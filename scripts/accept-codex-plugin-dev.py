#!/usr/bin/env python3
"""Exercise an installed Dev plugin through the real local Codex app-server.

Uses a private, separate CODEX_HOME; never signs in, starts a model turn, edits
the desktop configuration, or manages Yosh authority. Configure test Grants in
the native Dev window. Every invocation checks the exact Offline identity.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import queue
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
NAME = 'Yosh Codex Plugin Dev'
IDENTITY = 'com.yosh.codex-plugin-dev'
ORIGIN = 'http://127.0.0.1:14449'
TOOLS = {'get_spending_status', 'get_purchase', 'get_purchase_delivery',
         'quote_x402_resource', 'discover_x402_resource', 'register_x402_resource',
         'curl', 'recover_payment'}
SAFE_FIELDS = {'purchaseId', 'operationId', 'status', 'code', 'policyCode', 'reasonCode',
               'paymentStatus', 'deliveryStatus', 'transactionId', 'transaction',
               'amount', 'amountAtomic', 'network', 'testOnly', 'realFunds', 'profile',
               'spendingAuthorized', 'paused', 'nextOffset', 'totalBytes', 'encoding'}


def private_json(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('PRIVATE_DEV_RECORD_REQUIRED')
    if info.st_size > 1024 * 1024:
        raise RuntimeError('DEV_RECORD_TOO_LARGE')
    return json.loads(path.read_text())


def private_directory(path):
    if path.is_symlink():
        raise RuntimeError('TEST_DIRECTORY_SYMLINK_REJECTED')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('PRIVATE_TEST_DIRECTORY_REQUIRED')


def write_record(path, value):
    data = (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)


def environment(args):
    app = args.app.resolve(strict=True)
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != IDENTITY or info.get('YoshCodexPluginDevelopment') is not True \
            or info.get('YoshPayDevelopment') is not True:
        raise RuntimeError('PLUGIN_DEV_APP_REQUIRED')
    runtime = app / 'Contents/Resources/Runtime'
    source = json.loads((runtime / 'codex-plugin-dev-source-manifest.json').read_text())
    if source.get('kind') != 'codex-plugin-dev' or source.get('productionEnabled') is not False:
        raise RuntimeError('PLUGIN_DEV_BUILD_REQUIRED')
    directory = Path.home() / 'Library/Application Support' / NAME
    if directory.resolve(strict=True) != directory:
        raise RuntimeError('PLUGIN_DEV_DIRECTORY_REQUIRED')
    selection = directory / 'development-environment.json'
    if selection.exists() and private_json(selection).get('environment') != 'offline':
        raise RuntimeError('OFFLINE_ACCEPTANCE_REQUIRED')
    descriptor = private_json(directory / 'pay-dev-runtime.json')
    if descriptor.get('profile') != 'isolated-pay-dev' or descriptor.get('origin') != ORIGIN:
        raise RuntimeError('OFFLINE_DESCRIPTOR_REQUIRED')
    state = args.state.absolute()
    if not state.resolve().is_relative_to((ROOT / 'build.noindex').resolve()):
        raise RuntimeError('ISOLATED_ACCEPTANCE_OUTPUT_REQUIRED')
    for path in [state, state / 'codex-home', state / 'user-home', state / 'workspace', state / 'evidence']:
        private_directory(path)
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TMPDIR') if key in os.environ}
    env.update(CODEX_HOME=str(state / 'codex-home'), HOME=str(state / 'user-home'),
               YOSH_CODEX_PLUGIN_APP=str(app), NO_COLOR='1')
    executable = args.codex or shutil.which('codex')
    if not executable or not Path(executable).is_file():
        raise RuntimeError('INSTALLED_CODEX_REQUIRED')
    return str(Path(executable).resolve()), env, state, descriptor


class Host:
    def __init__(self, executable, env, workspace):
        self.child = subprocess.Popen([executable, 'app-server', '--stdio'], cwd=workspace, env=env,
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.lock = threading.Lock()
        self.pending = {}
        self.counter = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        try:
            for line in self.child.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                identifier = message.get('id')
                if 'method' in message and identifier is not None:
                    self.send({'id': identifier, 'error': {'code': -32601, 'message': 'Interactive confirmation required'}})
                else:
                    channel = self.pending.get(identifier)
                    if channel is not None:
                        channel.put(message)
        finally:
            for channel in list(self.pending.values()):
                channel.put(None)

    def send(self, message):
        with self.lock:
            self.child.stdin.write(json.dumps(message) + '\n')
            self.child.stdin.flush()

    def call(self, method, params, timeout=90):
        with self.lock:
            self.counter += 1
            identifier = self.counter
            channel = queue.Queue()
            self.pending[identifier] = channel
        self.send({'id': identifier, 'method': method, 'params': params})
        try:
            message = channel.get(timeout=timeout)
            if message is None:
                raise RuntimeError('CODEX_HOST_CLOSED')
            if 'error' in message:
                raise RuntimeError('CODEX_RPC_FAILED:' + method + ':' + str(message['error'].get('code')))
            return message['result']
        finally:
            self.pending.pop(identifier, None)

    def close(self):
        self.child.stdin.close()
        try:
            self.child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            # Only this test's app-server child. The desktop host and Yosh
            # backend keep running and retain original payment ownership.
            self.child.terminate()
            self.child.wait(timeout=10)


def summarize(result):
    texts = [item.get('text', '') for item in result.get('content', []) if item.get('type') == 'text']
    text = '\n'.join(texts)
    facts = []

    def walk(value):
        if isinstance(value, dict):
            selected = {key: item for key, item in value.items()
                        if key in SAFE_FIELDS and isinstance(item, (str, int, bool, type(None)))}
            if selected:
                facts.append(selected)
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for content in texts:
        try:
            walk(json.loads(content))
        except ValueError:
            pass
    walk(result.get('structuredContent'))
    return {'isError': result.get('isError', False), 'facts': facts,
            'codes': sorted(set(re.findall(r'\b[A-Z][A-Z0-9_]{3,80}\b', text))),
            'containsDemoDelivery': 'is_demo_snapshot' in text or 'Offline development simulator' in text,
            'textSha256': hashlib.sha256(text.encode()).hexdigest(), 'textBytes': len(text.encode())}


def install(executable, env, state, args):
    config = state / 'codex-home/config.toml'
    if not config.exists():
        text = 'cli_auth_credentials_store="file"\nmcp_oauth_credentials_store="file"\n'
        text += '[projects.' + json.dumps(str(state / 'workspace')) + ']\ntrust_level="trusted"\n'
        descriptor = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(text)
    for arguments in [['plugin', 'marketplace', 'add', str(ROOT), '--json'],
                      ['plugin', 'add', args.plugin, '--json']]:
        result = subprocess.run([executable, *arguments], cwd=state / 'workspace', env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=90)
        if result.returncode:
            raise RuntimeError('CODEX_PLUGIN_INSTALL_FAILED:' + arguments[1])
    return {'installed': True, 'plugin': args.plugin, 'realCodexBinary': executable,
            'isolatedCodexHome': str(state / 'codex-home')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'probe', 'call', 'concurrent'])
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--state', type=Path, default=ROOT / 'build.noindex/codex-plugin-host-acceptance')
    parser.add_argument('--codex')
    parser.add_argument('--plugin', default='yosh-dev@yosh-development')
    parser.add_argument('--tool', choices=sorted(TOOLS))
    parser.add_argument('--arguments-file', type=Path)
    args = parser.parse_args()
    desktop_config = Path.home() / '.codex/config.toml'
    config_before = hashlib.sha256(desktop_config.read_bytes()).hexdigest() if desktop_config.exists() else None
    executable, env, state, descriptor = environment(args)
    result = {'host': 'installed-codex-app-server', 'modelTurnStarted': False,
              'desktopGuiRestarted': False, 'realFunds': False, 'origin': ORIGIN,
              'profile': descriptor['profile'], 'startedAt': time.time()}
    if args.action == 'install':
        result.update(install(executable, env, state, args))
    else:
        host = Host(executable, env, state / 'workspace')
        try:
            host.call('initialize', {'clientInfo': {'name': 'yosh_plugin_dev_acceptance', 'version': '1'},
                                     'capabilities': {'experimentalApi': True}})
            host.send({'method': 'initialized', 'params': {}})
            thread = host.call('thread/start', {'cwd': str(state / 'workspace'), 'sandbox': 'read-only',
                                              'approvalPolicy': 'on-request', 'ephemeral': True})['thread']['id']
            inventory = host.call('mcpServerStatus/list', {'threadId': thread, 'detail': 'toolsAndAuthOnly'})
            servers = [server for server in inventory['data'] if 'get_spending_status' in server.get('tools', {})]
            if len(servers) != 1 or servers[0].get('toolsError'):
                diagnostics = [{'name': item.get('name'), 'tools': sorted(item.get('tools', {})),
                                'toolsError': item.get('toolsError')} for item in inventory['data']]
                write_record(state / 'evidence' / ('startup-' + str(uuid.uuid4()) + '.json'), diagnostics)
                raise RuntimeError('EXACT_PLUGIN_SERVER_REQUIRED')
            server = servers[0]
            result.update(serverName=server['name'], tools=sorted(server['tools']))
            skills = host.call('skills/list', {'cwds': [str(state / 'workspace')], 'forceReload': True})
            result['skills'] = [skill['name'] for data in skills.get('data', [])
                                for skill in data.get('skills', []) if 'yosh' in skill.get('name', '').lower()]
            if args.action != 'probe':
                if not args.tool:
                    raise RuntimeError('TOOL_REQUIRED')
                arguments = json.loads(args.arguments_file.read_text()) if args.arguments_file else {}
                invocation = {'threadId': thread, 'server': server['name'], 'tool': args.tool, 'arguments': arguments}
                if args.action == 'concurrent':
                    from concurrent.futures import ThreadPoolExecutor
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        calls = [pool.submit(host.call, 'mcpServer/tool/call', invocation) for _ in range(2)]
                        result['calls'] = [summarize(call.result()) for call in calls]
                else:
                    result['call'] = summarize(host.call('mcpServer/tool/call', invocation))
        finally:
            host.close()
    config_after = hashlib.sha256(desktop_config.read_bytes()).hexdigest() if desktop_config.exists() else None
    result['desktopConfigChangedDuringThisProbe'] = config_before != config_after
    path = state / 'evidence' / (args.action + '-' + str(uuid.uuid4()) + '.json')
    write_record(path, result)
    print(json.dumps({**result, 'evidence': str(path)}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, queue.Empty, subprocess.TimeoutExpired) as error:
        print('Yosh plugin acceptance: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        raise SystemExit(1)
