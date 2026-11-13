#!/usr/bin/env python3
"""Install the ZIP into a private Codex home and probe the real app-server.

No model turn, Desktop restart, user Codex config edit, or payment. This is host
integration evidence, not GUI or clean-machine acceptance.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('host_probe', ROOT / 'scripts/accept-codex-plugin-dev.py')
host_probe = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(host_probe)
NAME = 'yosh-standalone-dev'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--state', type=Path, required=True)
    args = parser.parse_args()
    archive = args.archive.resolve(strict=True)
    expected = json.loads(archive.with_name('package-evidence.json').read_text())
    local = expected.get('name') == 'yosh-local-dev'
    plugin_name = 'yosh-local-dev' if local else NAME
    state = args.state.absolute()
    if state.is_symlink() or not state.resolve().is_relative_to((ROOT / 'build.noindex').resolve()): raise ValueError('Private build state required')
    state.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name in ['codex-home', 'user-home', 'workspace', 'unpacked', 'data']:
        (state / name).mkdir(mode=0o700)
    # Codex filters arbitrary inherited environment variables. Exercise the
    # shipped launcher's real isolated Dev default instead of claiming a test
    # override reached it. Refuse a live service or a previously funded fixture.
    directory = Path.home() / 'Library/Application Support' / ('Yosh Local Authorization Dev' if local else 'Yosh Standalone Plugin Dev')
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(('127.0.0.1', 17449 if local else 15449))
    fixture = directory / 'simulator/offline-network.json'
    if fixture.exists() and json.loads(fixture.read_text()).get('transactions'):
        raise RuntimeError('EMPTY_STANDALONE_OFFLINE_FIXTURE_REQUIRED')
    original_config = Path.home() / '.codex/config.toml'
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
    config_before = digest(original_config)
    expected = json.loads(archive.with_name('package-evidence.json').read_text())
    if digest(archive) != expected['zipSha256']: raise ValueError('ZIP checksum mismatch')
    owner_path = directory / 'standalone-owner.json'
    if owner_path.exists() and json.loads(owner_path.read_text())['runtimeDigest'] != expected['runtimeDigest']:
        raise RuntimeError('EXISTING_DEV_VERSION_PRESERVED_USE_MATCHING_PACKAGE')
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            name = Path(member.filename)
            if name.is_absolute() or '..' in name.parts or stat.S_ISLNK(member.external_attr >> 16): raise ValueError('Unsafe ZIP entry')
            target = state / 'unpacked' / name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            target.write_bytes(bundle.read(member)); target.chmod((member.external_attr >> 16) & 0o777)
    marketplace = state / 'unpacked/yosh-standalone-marketplace'
    for name, checksum in expected['files'].items():
        if digest(marketplace / name) != checksum: raise ValueError('Extracted bytes changed')
    config = 'cli_auth_credentials_store="file"\nmcp_oauth_credentials_store="file"\n'
    config += '[projects.' + json.dumps(str(state / 'workspace')) + ']\ntrust_level="trusted"\n'
    (state / 'codex-home/config.toml').write_text(config)
    (state / 'codex-home/config.toml').chmod(0o600)
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(state / 'user-home'), 'CODEX_HOME': str(state / 'codex-home'),
           'NO_COLOR': '1'}
    codex = shutil.which('codex')
    if not codex: raise RuntimeError('INSTALLED_CODEX_REQUIRED')
    for command in [['plugin', 'marketplace', 'add', str(marketplace), '--json'],
                    ['plugin', 'add', plugin_name + '@yosh-standalone-testing', '--json']]:
        result = subprocess.run([codex, *command], cwd=state / 'workspace', env=env, capture_output=True, text=True, timeout=90)
        if result.returncode: raise RuntimeError('ISOLATED_PLUGIN_INSTALL_FAILED:' + command[1])
    checks = []
    try:
        owner = None
        for iteration in range(2):
            host = host_probe.Host(codex, env, state / 'workspace')
            try:
                host.call('initialize', {'clientInfo': {'name': 'yosh_standalone_B', 'version': '1'}, 'capabilities': {'experimentalApi': True}})
                host.send({'method': 'initialized', 'params': {}})
                thread = host.call('thread/start', {'cwd': str(state / 'workspace'), 'sandbox': 'read-only', 'approvalPolicy': 'on-request', 'ephemeral': True})['thread']['id']
                inventory = host.call('mcpServerStatus/list', {'threadId': thread, 'detail': 'toolsAndAuthOnly'})
                servers = [item for item in inventory['data'] if ('local_setup_status' if local else 'get_spending_status') in item.get('tools', {})]
                if len(servers) != 1:
                    # Bounded operational diagnostics only; never config/env.
                    (state / 'startup-failure.json').write_text(json.dumps([{'name': item.get('name'), 'toolsError': item.get('toolsError')} for item in inventory['data']], indent=2))
                    raise RuntimeError('EXACT_STANDALONE_PLUGIN_REQUIRED')
                server = servers[0]
                if local:
                    assert set(server['tools']) == {'open_local_settings','local_setup_status'}
                    result = host.call('mcpServer/tool/call', {'threadId': thread, 'server': server['name'], 'tool': 'local_setup_status', 'arguments': {}})
                    assert not result.get('isError')
                    report = json.loads(result['content'][0]['text'])
                    assert report['realFunds'] is False and report['paused'] and report['enabled'] is False
                else:
                    assert set(server['tools']) == {'get_spending_status', 'get_purchase', 'get_purchase_delivery',
                        'quote_x402_resource', 'discover_x402_resource', 'register_x402_resource', 'curl'}
                    result = host.call('mcpServer/tool/call', {'threadId': thread, 'server': server['name'], 'tool': 'get_spending_status', 'arguments': {}})
                    assert not result.get('isError')
                    report = json.loads(result['content'][0]['text'])
                    assert report['realFunds'] is False and report['status']['budget']['paused'] and report['status']['grant'] is None
                    assert not report['status']['recentPurchases']
                actual_owner = json.loads((directory / 'standalone-owner.json').read_text())
                if owner is not None: assert actual_owner == owner
                owner = actual_owner
                checks.append({'hostRun': iteration + 1, 'tools': sorted(server['tools']), 'paused': True, 'grant': None, 'purchases': 0})
            finally: host.close()
    finally:
        if owner_path.exists() and json.loads(owner_path.read_text())['runtimeDigest'] == expected['runtimeDigest']:
            launcher = marketplace / 'plugins' / plugin_name / 'yosh-dev'
            stopped = subprocess.run([str(launcher), 'stop', '--data-dir', str(directory)], cwd=state, env=env, capture_output=True, text=True, timeout=20)
            if stopped.returncode: raise RuntimeError('TEST_BACKEND_SAFE_STOP_FAILED')
    if digest(original_config) != config_before: raise RuntimeError('USER_CODEX_CONFIG_CHANGED')
    result = {'kind': 'installed-codex-plugin-app-server', 'installedFromZip': True, 'requiresApp': False,
              'modelTurnStarted': False, 'desktopGuiAcceptance': False, 'realFunds': False,
              'userCodexConfigUnchanged': True, 'testBackendStopped': True, 'checks': checks, 'completedAt': time.time()}
    (state / 'evidence.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__': main()
