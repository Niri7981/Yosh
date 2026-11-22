#!/usr/bin/env python3
"""Connect a private ChatGPT app to a local read-only Yosh Mainnet statement."""

import argparse
import fcntl
import getpass
import http.client
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
import warnings


HOST = "127.0.0.1"
PORT = 13449
MCP_PATH = "/api/agent/remote-mcp"
KEY_PATTERN = rb"sk-[A-Za-z0-9_-]{17,}"
AUTH_PATTERN = rb"Bearer yrr1_[A-Za-z0-9_-]{43}"
RESPONSE_LIMIT = 128 * 1024
POLL_LIMIT = 150


def require_private(path, directory=False):
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError(f"Check the owner and permissions of {path.name}.")


def private_directory(path):
    path.mkdir(mode=0o700, exist_ok=True)
    require_private(path, directory=True)
    return path


def credential(path, pattern):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError(f"Check the owner and permissions of {path.name}.")
        value = handle.read(4097).rstrip(b"\r\n")
    if len(value) > 4096 or not re.fullmatch(pattern, value):
        raise ValueError(f"{path.name} has an invalid format.")
    return value


def write_private(path, content, replace=False):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
            if replace:
                if os.path.lexists(path):
                    require_private(path)
                os.replace(temporary, path)
            else:
                os.link(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def read_openai_key(path):
    if not os.path.lexists(path):
        # getpass falls back to an echoed prompt when it cannot disable echo.
        # Treat this warning as an error before accepting any input.
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            try:
                secret = getpass.getpass("Enter your restricted OpenAI Tunnel API key (input hidden): ").encode()
            except (EOFError, getpass.GetPassWarning):
                raise ValueError("Open this command in an interactive Terminal to enter the key.") from None
        if len(secret) > 4096 or not re.fullmatch(KEY_PATTERN, secret):
            raise ValueError("The OpenAI Tunnel API key has an invalid format.")
        write_private(path, secret)
    credential(path, KEY_PATTERN)


def local_cli(runtime, *arguments, timeout=90):
    result = subprocess.run([str(runtime / "node"), str(runtime / "mainnet.cjs"), *arguments],
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout,
                            env=client_environment())
    if result.returncode:
        reason = next((line.decode("ascii") for line in reversed(result.stderr.splitlines())
                       if re.fullmatch(rb"(MAINNET|REMOTE_READ)_[A-Z0-9_]{1,90}", line)), None)
        raise ValueError(f"Yosh Mainnet could not complete the operation ({reason or 'local command failed'}).")
    return result.stdout


def start_owner(runtime):
    owner = json.loads(local_cli(runtime, "start"))
    if (not isinstance(owner, dict) or owner.get("running") is not True or owner.get("owner") != "standalone"
            or owner.get("environment") != "mainnet" or not isinstance(owner.get("runtimeDigest"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", owner["runtimeDigest"])
            or owner["runtimeDigest"] != owner.get("candidateRuntimeDigest")
            or not isinstance(owner.get("runtimeDirectory"), str)):
        raise ValueError("This connection requires the verified Yosh standalone Mainnet owner.")
    # Use the runtime installed by Yosh for relaunches. The unpacked ZIP can be removed afterward.
    installed = Path(owner["runtimeDirectory"])
    if not installed.is_absolute() or installed.name != owner["runtimeDigest"]:
        raise ValueError("Yosh returned an unexpected installed Mainnet runtime location.")
    return installed


def mcp_call(header, request_id, method, params):
    connection = http.client.HTTPConnection(HOST, PORT, timeout=8)
    try:
        body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        connection.request("POST", MCP_PATH, body=body, headers={"Authorization": header.decode("ascii"),
            "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError(f"The local Yosh MCP check returned HTTP {response.status}.")
        if response.getheader("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            raise ValueError("The local Yosh MCP endpoint did not return JSON.")
        data = response.read(RESPONSE_LIMIT + 1)
    except (http.client.HTTPException, OSError):
        raise ValueError("Unable to reach the local Yosh MCP endpoint.") from None
    finally:
        connection.close()
    if len(data) > RESPONSE_LIMIT:
        raise ValueError("The local Yosh MCP response exceeded the check limit.")
    reply = json.loads(data)
    if (not isinstance(reply, dict) or reply.get("jsonrpc") != "2.0" or reply.get("id") != request_id
            or "error" in reply or not isinstance(reply.get("result"), dict)):
        raise ValueError("The local Yosh MCP request failed.")
    return reply["result"]


def probe_statement(header):
    listing = mcp_call(header, 1, "tools/list", {})
    tools = listing.get("tools")
    if (listing.get("nextCursor") is not None or not isinstance(tools, list) or len(tools) != 1
            or not isinstance(tools[0], dict) or tools[0].get("name") != "list_account_purchases"):
        raise ValueError("Expected exactly one Yosh tool, list_account_purchases.")
    result = mcp_call(header, 2, "tools/call", {"name": "list_account_purchases", "arguments": {"limit": 1}})
    content = result.get("content")
    if (result.get("isError", False) is not False or not isinstance(content, list) or not content
            or not isinstance(content[0], dict) or content[0].get("type") != "text"
            or not isinstance(content[0].get("text"), str)):
        raise ValueError("Unable to read the local Yosh statement.")
    statement = json.loads(content[0]["text"])
    if not isinstance(statement, dict) or statement.get("environment") != "live_mainnet":
        raise ValueError("The statement could not be verified as Mainnet.")


def client_environment():
    return {"HOME": str(Path.home()), "PATH": "/usr/bin:/bin", "NO_PROXY": "127.0.0.1,localhost,::1"}


def tunnel_arguments(args, directory):
    options = [str(args.tunnel_client), "run",
               f"--control-plane.tunnel-id={args.tunnel_id}", f"--control-plane.api-key=file:{directory / 'runtime.key'}",
               "--control-plane.poll-channel=main", f"--mcp.server-url=http://{HOST}:{PORT}{MCP_PATH}",
               f"--mcp.extra-headers=Authorization: file:{directory / 'statement.authorization'}",
               "--mcp.oauth-discovery=disabled", "--mcp.startup-wait-timeout=2m",
               "--health.listen-addr=127.0.0.1:0", f"--health.url-file={directory / 'health.url'}",
               f"--pid.file={directory / 'runtime.pid'}"]
    if args.proxy:
        options.append(f"--control-plane.http-proxy={args.proxy}")
    return options


def ready(args, directory):
    health, pid = directory / "health.url", directory / "runtime.pid"
    if not health.is_file() or not pid.is_file():
        return False
    try:
        result = subprocess.run([str(args.tunnel_client), "health", "--url-file", str(health),
                                 "--pid-file", str(pid), "--require-control-plane-poll"],
                                env=client_environment(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4)
    except subprocess.TimeoutExpired:
        return False
    return result.returncode == 0


def wait_until_ready(args, directory, process=None):
    deadline = time.monotonic() + POLL_LIMIT
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise ValueError("The OpenAI tunnel client exited before it connected.")
        if ready(args, directory):
            print("Yosh's read-only tunnel is ready. Connect the private app in ChatGPT.", flush=True)
            return
        time.sleep(2)
    raise ValueError("Unable to confirm the OpenAI connection. Check the key permissions, tunnel ID, and proxy.")


def launchctl(*arguments, check=True):
    return subprocess.run(["/bin/launchctl", *arguments], check=check,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode


def launch_agent(args, directory, runtime, launch_agents, job):
    domain, label = job.rsplit("/", 1)
    service = directory / "connect-dot.py"
    write_private(service, Path(__file__).read_bytes(), replace=True)
    options = [sys.executable, "-I", str(service), "--serve", "--runtime-dir", str(runtime),
               "--tunnel-id", args.tunnel_id, "--tunnel-client", str(args.tunnel_client)]
    if args.proxy:
        options.extend(["--proxy", args.proxy])
    settings = {"Label": label, "ProgramArguments": options,
                "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 30,
                "ProcessType": "Background", "Umask": 0o077,
                "StandardOutPath": "/dev/null", "StandardErrorPath": "/dev/null"}
    launch_agents.mkdir(mode=0o700, exist_ok=True)
    plist = launch_agents / f"{label}.plist"
    present = os.path.lexists(plist)
    if present:
        require_private(plist)
    wanted = plistlib.dumps(settings)
    loaded = launchctl("print", job, check=False) == 0
    if not present or plist.read_bytes() != wanted:
        if loaded:
            launchctl("bootout", job)
            loaded = False
        write_private(plist, wanted, replace=True)
    if not loaded:
        launchctl("bootstrap", domain, str(plist))
    elif not ready(args, directory):
        launchctl("kickstart", "-k", job)


def foreground(args, directory):
    process = subprocess.Popen(tunnel_arguments(args, directory), env=client_environment(),
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_until_ready(args, directory, process)
        print("Keep this Terminal open while using the app. Press Ctrl-C to stop the tunnel.", flush=True)
        if process.wait() != 0:
            raise ValueError("The OpenAI tunnel client stopped.")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", required=True, type=Path, help="Verified Yosh package runtime directory.")
    parser.add_argument("--tunnel-id", required=True, help="OpenAI Tunnel ID for your private ChatGPT app.")
    parser.add_argument("--proxy", help="HTTP proxy for the OpenAI connection, including its port.")
    parser.add_argument("--tunnel-client", default="tunnel-client", help="OpenAI tunnel-client executable.")
    parser.add_argument("--login-start", action="store_true", help="Keep the connection running and start it at login.")
    parser.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if not re.fullmatch(r"tunnel_[A-Za-z0-9_-]{8,96}", args.tunnel_id):
        parser.error("Provide a valid OpenAI Tunnel ID.")
    if args.proxy:
        try:
            proxy = urlsplit(args.proxy)
            valid = (proxy.scheme in ("http", "https") and bool(proxy.hostname) and proxy.port is not None
                     and proxy.username is None and proxy.password is None and proxy.path in ("", "/")
                     and not proxy.query and not proxy.fragment and not re.search(r"\s", args.proxy))
        except ValueError:
            valid = False
        if not valid:
            parser.error("Provide a proxy URL with scheme, hostname and port, with no credentials.")
    return args


def main():
    args = parse_args()
    if sys.platform != "darwin":
        raise ValueError("The Yosh Dot connection requires macOS.")
    binary = shutil.which(args.tunnel_client)
    if binary is None:
        raise ValueError("Install OpenAI tunnel-client (v0.0.21 or later), or pass --tunnel-client.")
    args.tunnel_client = Path(binary).absolute()
    runtime = args.runtime_dir.resolve(strict=True)
    if not (runtime / "mainnet-manifest.json").is_file():
        raise ValueError("Provide the runtime directory bundled with the Yosh Dev package.")
    os.umask(0o077)
    support = Path.home().resolve() / "Library" / "Application Support"
    base = private_directory(support / "Yosh Dot Connections")
    directory = private_directory(base / args.tunnel_id)
    auth, key = directory / "statement.authorization", directory / "runtime.key"
    if args.serve:
        # Background launches validate both credentials and never prompt for consent.
        if not os.path.lexists(key) or not os.path.lexists(auth):
            return
        credential(key, KEY_PATTERN)
        header = credential(auth, AUTH_PATTERN)
        start_owner(runtime)
        probe_statement(header)
        options = tunnel_arguments(args, directory)
        os.execve(options[0], options, client_environment())

    job = f"gui/{os.getuid()}/com.yosh.dot-connection.{args.tunnel_id}"
    lock = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another setup or foreground tunnel is running for this connection.") from None
        installed = start_owner(runtime)
        read_openai_key(key)
        if not os.path.lexists(auth):
            print("Confirm Dot's read-only Mainnet statement access in the Yosh approval window.", flush=True)
            local_cli(installed, "remote-statement", "pair", "--label", "Dot", "--header-out", str(auth), timeout=145)
        probe_statement(credential(auth, AUTH_PATTERN))
        print("Local check passed. Dot can read the Mainnet statement.", flush=True)
        if args.login_start:
            launch_agent(args, directory, installed, support.parent / "LaunchAgents", job)
            wait_until_ready(args, directory)
        elif launchctl("print", job, check=False) == 0:
            wait_until_ready(args, directory)
        else:
            foreground(args, directory)
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except (json.JSONDecodeError, UnicodeDecodeError, RecursionError):
        print("Yosh returned an invalid setup or statement response.", file=sys.stderr)
        sys.exit(1)
    except (OSError, subprocess.SubprocessError):
        print("Unable to complete the Dot connection. Check the package, file permissions, and macOS login session.", file=sys.stderr)
        sys.exit(1)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
