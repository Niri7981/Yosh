#!/usr/bin/env python3
"""Run the installed Codex host with a separate home and the bundled Pay MCP."""
import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import stat
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import urlparse


def private_json(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid() or info.st_size > 16384:
        raise RuntimeError("PAY_DEV_PRIVATE_CONFIG_REQUIRED")
    return json.loads(path.read_text())


def private_write(path, content):
    if path.exists() and (path.is_symlink() or path.stat().st_uid != os.getuid()):
        raise RuntimeError("PAY_DEV_CONFIG_OWNERSHIP_REQUIRED")
    temporary = path.with_suffix(f".tmp-{uuid.uuid4()}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(content)
    temporary.replace(path)


def codex_path(requested):
    candidates = [requested, shutil.which("codex")]
    for applications in (Path.home() / "Applications", Path("/Applications")):
        candidates.extend([str(applications / "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
                           str(applications / "Codex.app/Contents/Resources/codex")])
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return str(Path(candidate).resolve())
    raise RuntimeError("CODEX_NOT_INSTALLED")


def setup(args):
    directory = Path(args.data_dir).expanduser().resolve()
    manifest = private_json(directory / "pay-dev-runtime.json")
    if manifest.get("version") != 1 or manifest.get("profile") != "isolated-pay-dev":
        raise RuntimeError("PAY_DEV_PROFILE_REQUIRED")
    merchant = urlparse(manifest["merchantUrl"])
    if merchant.scheme != "http" or merchant.hostname != "127.0.0.1" or not merchant.port or merchant.username or merchant.password:
        raise RuntimeError("PAY_DEV_LOOPBACK_MERCHANT_REQUIRED")
    bundle = Path(args.bundle).expanduser().resolve()
    runtime = bundle / "Contents/Resources/Runtime"
    for name in ("node", "mcp.cjs", "pay-mcp"):
        if not (runtime / name).is_file():
            raise RuntimeError("PAY_DEV_BUNDLE_INCOMPLETE")
    codex_home = directory / "codex-home"
    user_home = directory / "codex-user-home"
    workspace = directory / "codex-workspace"
    for path in (codex_home, user_home, workspace):
        if path.is_symlink():
            raise RuntimeError("PAY_DEV_DIRECTORY_SYMLINK")
        path.mkdir(mode=0o700, exist_ok=True)
        path.chmod(0o700)
    # This helper owns one isolated config. Never touch or inherit ~/.codex/auth.
    config = '\n'.join([
        'cli_auth_credentials_store = "file"', 'mcp_oauth_credentials_store = "file"',
        'approval_policy = "on-request"', 'sandbox_mode = "read-only"',
        'mcp_optional_startup_grace_ms = 0',
        f'[projects.{json.dumps(str(workspace))}]', 'trust_level = "trusted"',
        '[mcp_servers.yosh_pay_dev]', f'command = {json.dumps(str(runtime / "node"))}',
        f'args = {json.dumps([str(runtime / "mcp.cjs"), "--data-dir", str(directory)])}',
        f'cwd = {json.dumps(str(workspace))}', 'enabled = true', 'required = true',
        'enabled_tools = ["curl", "get_spending_status"]', 'startup_timeout_sec = 20', 'tool_timeout_sec = 90',
        'default_tools_approval_mode = "prompt"', '',
    ])
    private_write(codex_home / "config.toml", config)
    instructions = ("# Yosh Pay Dev\n\nUse only the `yosh_pay_dev` MCP `curl` tool for API purchases. "
                    "This environment uses a loopback merchant, fake RPC and offline keys; it has no real funds. "
                    "Never replace a failed/unknown operation with another payment. Keep the same operation_id when retrying.\n\n"
                    f"Test API: {manifest['merchantUrl']}\n")
    private_write(workspace / "AGENTS.md", instructions)
    env = {key: os.environ[key] for key in ("PATH", "TERM", "LANG", "LC_ALL", "COLORTERM", "TMPDIR") if key in os.environ}
    env.update(HOME=str(user_home), CODEX_HOME=str(codex_home))
    return codex_path(args.codex), env, workspace, manifest


class Host:
    def __init__(self, command, env, workspace):
        self.process = subprocess.Popen([command, "app-server", "--stdio"], cwd=workspace, env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, bufsize=1)
        self.messages = queue.Queue()
        self.counter = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        try:
            for line in self.process.stdout:
                self.messages.put(json.loads(line))
        finally:
            self.messages.put(None)

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def call(self, method, params, timeout=100):
        self.counter += 1
        identifier = self.counter
        self.send(dict(id=identifier, method=method, params=params))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = self.messages.get(timeout=max(0.01, deadline-time.monotonic()))
            if message is None:
                raise RuntimeError("CODEX_HOST_CLOSED")
            if message.get("id") == identifier and ("result" in message or "error" in message):
                if "error" in message:
                    raise RuntimeError(f"CODEX_RPC_FAILED:{method}:{message['error'].get('code')}")
                return message["result"]
            if "id" in message and "method" in message:
                self.send(dict(id=message["id"], error=dict(code=-32601, message="User interaction required in the interactive Codex host")))
        raise RuntimeError("CODEX_HOST_TIMEOUT")

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            # This closes only our temporary Codex child; Yosh keeps original
            # payment evidence and owns completion/recovery independently.
            self.process.terminate()
            self.process.wait(timeout=10)


def probe(command, env, workspace, manifest, args):
    directory = Path(env["CODEX_HOME"]).parent
    connection = directory / "members" / manifest["memberId"] / "mcp-connection.json"
    if not connection.exists():
        connection = directory / "mcp-connection.json"
    if not connection.exists():
        raise RuntimeError("PAY_DEV_CONNECTION_NOT_ENABLED_OPEN_APP_FIRST")
    descriptor = private_json(connection)
    if descriptor.get("cardMemberId") != manifest["memberId"] or descriptor.get("origin") != manifest["origin"]:
        raise RuntimeError("PAY_DEV_CONNECTION_MISMATCH")
    host = Host(command, env, workspace)
    try:
        host.call("initialize", dict(clientInfo=dict(name="yosh_pay_dev_acceptance", title="Yosh Pay Dev", version="1"),
                                     capabilities=dict(experimentalApi=True)))
        host.send(dict(method="initialized", params={}))
        started = host.call("thread/start", dict(cwd=str(workspace), sandbox="read-only", approvalPolicy="on-request", ephemeral=True))
        thread_id = started["thread"]["id"]
        status = host.call("mcpServerStatus/list", dict(threadId=thread_id, serverName="yosh_pay_dev", detail="toolsAndAuthOnly"))
        server = next((item for item in status["data"] if item["name"] == "yosh_pay_dev"), None)
        if not server or "curl" not in server["tools"] or server.get("toolsError"):
            raise RuntimeError("PAY_DEV_MCP_NOT_CONNECTED")
        summary = dict(host="real-codex-app-server", mcp="real-pay-mcp", connected=True,
                       modelTurnStarted=False, realFunds=False)
        if args.action == "buy":
            operation = args.operation or f"manual-{uuid.uuid4()}"
            result = host.call("mcpServer/tool/call", dict(threadId=thread_id, server="yosh_pay_dev", tool="curl",
                                arguments=dict(url=manifest["merchantUrl"], operation_id=operation)))
            summary.update(operationId=operation, isError=bool(result.get("isError")), content=result.get("content", []))
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    finally:
        host.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "check", "buy", "login", "open"))
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--codex")
    parser.add_argument("--operation", help="Stable purchase ID; reuse the same value to recover the original purchase")
    args = parser.parse_args()
    command, env, workspace, manifest = setup(args)
    if args.action == "prepare":
        print("独立 Codex 环境已准备；未修改现有 Codex 配置或登录凭据。")
    elif args.action in ("check", "buy"):
        probe(command, env, workspace, manifest, args)
    else:
        arguments = [command, "login"] if args.action == "login" else [command, "--no-daemon", "-C", str(workspace), "--no-alt-screen"]
        raise SystemExit(subprocess.call(arguments, env=env, cwd=workspace))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, StopIteration, queue.Empty) as error:
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f"Yosh Pay Dev Codex: {code}", file=sys.stderr)
        raise SystemExit(1)
