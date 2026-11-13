#!/usr/bin/env python3
"""Read-only acceptance of the combined Yosh Dev 0.2.4 ZIP in real Codex app-server.

Requires the original Yosh native application to be closed. Existing Desktop
MCP clients from its bundle are counted but never terminated. An existing Dev
owner must already match this package; perform any approved upgrade separately.
The shipped plugin may automatically start its backend. This script never
issues Yosh start/stop/upgrade, purchase, recovery or authorization operations.
It creates and closes two private app-server hosts, without a model turn.

This proves a packaged plugin in fresh real app-server processes. It does NOT
prove that the current Codex Desktop Session reloaded its MCP, Desktop GUI
acceptance, actual signing/payment, clean-machine setup or Keychain consent.
Backends are deliberately left running; failures never trigger cleanup of funds.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = 'yosh-local-dev'
VERSION = '0.2.4'
MARKETPLACE = 'yosh-standalone-testing'
MAINNET_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
MAINNET_ASSET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
TABLES = ('purchases', 'spend_grants', 'original_payments', 'original_payment_signatures',
          'purchase_events', 'spend_grant_events', 'purchase_delivery', 'payment_reconciliation',
          'purchase_execution_provenance', 'external_execution_leases', 'external_authority_claims',
          'resource_registry', 'wallet_accounts', 'monetary_scopes', 'monetary_controls', 'card_members')
REQUIRED_TABLES = {'purchases', 'spend_grants', 'original_payments', 'resource_registry', 'wallet_accounts', 'monetary_controls'}


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def private_json(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'r') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                and not info.st_mode & 0o077 and info.st_size <= 65536, 'PRIVATE_OWNER_METADATA_REQUIRED')
        return json.load(stream)


def processes():
    result = subprocess.run(['/bin/ps', '-axo', 'pid=,ppid=,comm='], capture_output=True, text=True, check=True, timeout=10)
    rows = {}
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3 and fields[0].isdigit() and fields[1].isdigit():
            rows[int(fields[0])] = (int(fields[1]), fields[2])
    return rows


def assert_app_closed(home, rows):
    executable = str(home / 'Applications/Yosh.app/Contents/MacOS/Yosh')
    require(not any(command == executable for _, command in rows.values()), 'ORIGINAL_YOSH_APP_MUST_BE_CLOSED')


def listener_pids(port):
    result = subprocess.run(['/usr/sbin/lsof', '-nP', '-iTCP:' + str(port), '-sTCP:LISTEN', '-Fpn'],
                            capture_output=True, text=True, timeout=10)
    require(result.returncode in (0, 1), 'LISTENER_INSPECTION_FAILED')
    pids, addresses = set(), set()
    for line in result.stdout.splitlines():
        if line.startswith('p') and line[1:].isdigit():
            pids.add(int(line[1:]))
        elif line.startswith('n'):
            addresses.add(line[1:])
    require(not addresses or addresses == {'127.0.0.1:' + str(port)}, 'LOOPBACK_LISTENER_REQUIRED')
    return pids


def private_database_stat(database):
    info = database.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077
            and database.resolve(strict=True) == database, 'EXISTING_PRIVATE_LEDGER_REQUIRED')
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def fingerprint_connection(connection):
    connection.execute('PRAGMA query_only=ON')
    connection.execute('BEGIN')
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
    require(REQUIRED_TABLES <= tables, 'EXPECTED_ECONOMIC_TABLES_REQUIRED')
    result = {}
    for table in TABLES:
        if table not in tables:
            continue
        columns = [row[1] for row in connection.execute('PRAGMA table_info("' + table + '")')]
        order = ','.join('"' + column.replace('"', '""') + '"' for column in columns)
        digest, count = hashlib.sha256(), 0
        for row in connection.execute('SELECT * FROM "' + table + '" ORDER BY ' + order):
            # Signed bytes stay in memory and are represented only inside an
            # aggregate table digest, never written as acceptance evidence.
            cells = [({'blobSha256': hashlib.sha256(cell).hexdigest()} if isinstance(cell, bytes) else cell) for cell in row]
            digest.update(json.dumps(cells, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode() + b'\n')
            count += 1
        result[table] = {'rows': count, 'sha256': digest.hexdigest()}
    return result


def fingerprints(database):
    private_database_stat(database)
    connection = None
    try:
        connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=5)
        return fingerprint_connection(connection)
    except sqlite3.OperationalError as error:
        # Stopped WAL-mode databases without their sidecars may request a shared
        # memory write even in mode=ro. Immutable reads are safe only while the
        # same ownership lock used by AppRuntime excludes a new backend.
        code = getattr(error, 'sqlite_errorcode', None)
        require(str(error) in ('unable to open database file', 'attempt to write a readonly database')
                and (code is None or isinstance(code, int) and code & 0xff in (8, 14)),
                'READ_ONLY_LEDGER_QUERY_FAILED')
    finally:
        if connection is not None:
            connection.close()
    require(not listener_pids(13449), 'STOPPED_LEDGER_SNAPSHOT_REQUIRED')
    lock_file = database.parent / 'backend-owner.sqlite'
    private_database_stat(lock_file)
    lock = sqlite3.connect(lock_file.as_uri() + '?mode=rw', uri=True, timeout=0)
    try:
        lock.execute('PRAGMA busy_timeout=0')
        lock.execute('BEGIN IMMEDIATE')
        require(not listener_pids(13449), 'STOPPED_LEDGER_SNAPSHOT_REQUIRED')
        wal = database.with_name(database.name + '-wal')
        require(not wal.exists() or (not wal.is_symlink() and wal.stat().st_size == 0), 'NONEMPTY_LEDGER_WAL_REFUSED')
        before = private_database_stat(database)
        snapshot = sqlite3.connect(database.as_uri() + '?mode=ro&immutable=1', uri=True, timeout=0)
        try:
            result = fingerprint_connection(snapshot)
        finally:
            snapshot.close()
        require(private_database_stat(database) == before
                and (not wal.exists() or (not wal.is_symlink() and wal.stat().st_size == 0)), 'STOPPED_LEDGER_SNAPSHOT_CHANGED')
        return result
    finally:
        lock.rollback()
        lock.close()


def extract_package(archive, state):
    expected = json.loads(archive.with_name('package-evidence.json').read_text())
    require(expected.get('name') == PLUGIN and expected.get('requiresApp') is False
            and expected.get('zipSha256') == sha(archive), 'VERIFIED_COMBINED_ZIP_REQUIRED')
    require(isinstance(expected.get('files'), dict) and expected['files'], 'PACKAGE_FILE_MAP_REQUIRED')
    for name, digest in expected['files'].items():
        require(isinstance(name, str) and name and not Path(name).is_absolute()
                and '..' not in Path(name).parts and Path(name).as_posix() == name
                and isinstance(digest, str) and re.fullmatch(r'[0-9a-f]{64}', digest), 'UNSAFE_PACKAGE_FILE_MAP')
    unpacked = state / 'unpacked'
    unpacked.mkdir(mode=0o700)
    names = set()
    with zipfile.ZipFile(archive) as bundle:
        require(sum(item.file_size for item in bundle.infolist()) <= 512 * 1024 * 1024, 'PACKAGE_TOO_LARGE')
        for item in bundle.infolist():
            name = Path(item.filename)
            mode = item.external_attr >> 16
            require(not name.is_absolute() and '..' not in name.parts and name.as_posix() == item.filename
                    and item.filename not in names and name.parts
                    and stat.S_ISREG(mode) and name.parts[0] == 'yosh-standalone-marketplace', 'UNSAFE_ZIP_ENTRY')
            names.add(item.filename)
            target = unpacked / name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            target.write_bytes(bundle.read(item))
            target.chmod(mode & 0o777)
    marketplace = unpacked / 'yosh-standalone-marketplace'
    require(names == {'yosh-standalone-marketplace/' + name for name in expected['files']}, 'PACKAGE_FILE_SET_MISMATCH')
    for name, digest in expected['files'].items():
        require(sha(marketplace / name) == digest, 'PACKAGE_BYTES_MISMATCH')
    plugin = marketplace / 'plugins' / PLUGIN
    metadata = json.loads((plugin / 'plugin.json').read_text())
    require(metadata.get('name') == PLUGIN and metadata.get('version') == VERSION, 'PLUGIN_024_REQUIRED')
    manifest = module('standalone_packager', 'package-standalone-plugin.py').verify_runtime(plugin)
    require(manifest.get('mainnetStandalone') is True and not manifest.get('mainnetBridge')
            and sha(plugin / 'runtime/manifest.json') == expected['runtimeDigest'], 'STANDALONE_MAINNET_PACKAGE_REQUIRED')
    return marketplace, expected, sha(plugin / 'runtime/mainnet-manifest.json')


def parse_tool(result):
    require(isinstance(result, dict) and not result.get('isError'), 'READ_ONLY_TOOL_FAILED')
    texts = [item.get('text') for item in result.get('content', []) if item.get('type') == 'text']
    require(len(texts) == 1 and isinstance(texts[0], str) and len(texts[0]) <= 1048576, 'BOUNDED_JSON_TOOL_RESULT_REQUIRED')
    return json.loads(texts[0])


def select(value, names):
    require(isinstance(value, dict), 'STATUS_SHAPE_INVALID')
    return {name: value.get(name) for name in names}


def status_facts(report, member):
    require(report.get('realFunds') is True and report.get('profile') == 'pay-mcp-mainnet', 'MAINNET_STATUS_REQUIRED')
    status = report['status']
    scope = status['budget']['monetaryScope']
    require(scope.get('environment') == 'live_mainnet' and scope.get('network') == MAINNET_NETWORK
            and scope.get('assetId') == MAINNET_ASSET and scope.get('assetDecimals') == 6, 'MAINNET_MONETARY_SCOPE_REQUIRED')
    actual_member = status['execution']['readinessCardMemberId']
    require(actual_member == member, 'ORIGINAL_MEMBER_CHANGED')
    grant = status.get('grant')
    return {'memberId': actual_member, 'wallet': select(status['wallet'], ('address', 'available')),
            'grant': None if grant is None else select(grant, ('id', 'version', 'status', 'resourceId', 'network', 'assetId',
                'payTo', 'totalLimit', 'singleLimit', 'committed', 'remaining', 'expiresAt')),
            'budget': select(status['budget'], ('dailyLimit', 'paid', 'reserved', 'remaining', 'paused'))}


def runtime_proof(home, codex_home, host_pid, mainnet_digest, expected):
    rows = processes()
    assert_app_closed(home, rows)
    directory = home / 'Library/Application Support/Yosh Pay Dev v0.1.1-rc.5/Mainnet'
    owner = private_json(directory / 'mainnet-standalone-owner.json')
    require(owner.get('kind') == 'mainnet-standalone' and owner.get('apiVersion') == 1
            and owner.get('dataContract') == 'existing-mainnet-v1' and owner.get('runtimeDigest') == mainnet_digest
            and owner.get('ready') is True and type(owner.get('pid')) is int, 'ACTUAL_STANDALONE_OWNER_REQUIRED')
    pid = owner['pid']
    executable = home / 'Library/Application Support/Yosh Mainnet Runtime' / mainnet_digest / 'node'
    require(pid in rows and rows[pid][1] == str(executable) and listener_pids(13449) == {pid}, 'ACTUAL_STANDALONE_PROCESS_REQUIRED')
    mapped = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-p', str(pid), '-d', 'txt', '-Fn'],
                            capture_output=True, text=True, check=True, timeout=10)
    require('n' + str(executable) in mapped.stdout.splitlines(), 'STANDALONE_EXECUTABLE_NOT_MAPPED')
    cache = codex_home / 'plugins/cache' / MARKETPLACE / PLUGIN / VERSION
    require(json.loads((cache / 'plugin.json').read_text()).get('version') == VERSION, 'ACTUAL_CACHE_024_REQUIRED')
    for relative, digest in expected['files'].items():
        prefix = 'plugins/' + PLUGIN + '/'
        if relative.startswith(prefix):
            require(sha(cache / relative[len(prefix):]) == digest, 'ACTUAL_CACHE_BYTES_MISMATCH')
    def descendant(candidate):
        visited = set()
        while candidate in rows and candidate not in visited:
            if candidate == host_pid:
                return True
            visited.add(candidate)
            candidate = rows[candidate][0]
        return False
    cache_pids = [candidate for candidate, (_, command) in rows.items()
                  if command == str(cache / 'runtime/node') and descendant(candidate)]
    require(cache_pids, 'HOST_NOT_USING_CACHE_024')
    app_prefix = str(home / 'Applications/Yosh.app') + '/'
    app_processes = [candidate for candidate, (_, command) in rows.items() if command.startswith(app_prefix)]
    require(not any(descendant(candidate) for candidate in app_processes), 'FRESH_HOST_USES_ORIGINAL_APP_EXECUTABLE')
    return {'pid': pid, 'listener': '127.0.0.1:13449', 'executable': str(executable),
            'nodeSha256': sha(executable), 'runtimeDigest': mainnet_digest, 'cacheVersion': VERSION,
            'cacheNodePids': sorted(cache_pids), 'cachePath': str(cache),
            'hostAppBundledProcessCount': 0, 'unrelatedAppBundledProcessCount': len(app_processes)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--purchase-id', required=True)
    args = parser.parse_args()
    require(re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', args.purchase_id), 'EXPLICIT_PUBLIC_PURCHASE_ID_REQUIRED')
    os.umask(0o077)
    home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=True)
    assert_app_closed(home, processes())
    state = args.state.absolute()
    require(not state.is_symlink() and state.resolve().is_relative_to((ROOT / 'build.noindex').resolve()), 'NEW_PRIVATE_BUILD_STATE_REQUIRED')
    state.mkdir(mode=0o700, parents=True, exist_ok=False)
    marketplace, expected, mainnet_digest = extract_package(args.archive.resolve(strict=True), state)
    mainnet = home / 'Library/Application Support/Yosh Pay Dev v0.1.1-rc.5/Mainnet'
    listeners = listener_pids(13449)
    if listeners:
        existing_owner = private_json(mainnet / 'mainnet-standalone-owner.json')
        existing_pid = existing_owner.get('pid')
        existing_executable = home / 'Library/Application Support/Yosh Mainnet Runtime' / mainnet_digest / 'node'
        rows = processes()
        require(existing_owner.get('kind') == 'mainnet-standalone'
                and existing_owner.get('runtimeDigest') == mainnet_digest and existing_owner.get('ready') is True
                and type(existing_pid) is int and listeners == {existing_pid} and existing_pid in rows
                and rows[existing_pid][1] == str(existing_executable), 'UNVERIFIED_MAINNET_OWNER_PRESENT')
    dev = home / 'Library/Application Support/Yosh Local Authorization Dev'
    owner_file = dev / 'standalone-owner.json'
    if owner_file.exists():
        require(private_json(owner_file).get('runtimeDigest') == expected['runtimeDigest'], 'DEV_RUNTIME_UPGRADE_REQUIRED')
    else:
        require(not listener_pids(17449), 'UNVERIFIED_DEV_OWNER_PRESENT')
    member = private_json(mainnet / 'pay-mainnet-runtime.json')['memberId']
    database = mainnet / 'app-ledger.sqlite'
    before = fingerprints(database)
    original_config = home / '.codex/config.toml'
    config_before = sha(original_config) if original_config.exists() else None
    for name in ('codex-home', 'user-home', 'workspace'):
        (state / name).mkdir(mode=0o700)
    codex_home = state / 'codex-home'
    (codex_home / 'config.toml').write_text('cli_auth_credentials_store="file"\nmcp_oauth_credentials_store="file"\n'
        + '[projects.' + json.dumps(str(state / 'workspace')) + ']\ntrust_level="trusted"\n')
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(state / 'user-home'),
           'CODEX_HOME': str(codex_home), 'NO_COLOR': '1'}
    codex = shutil.which('codex')
    require(codex, 'INSTALLED_CODEX_REQUIRED')
    for command in (['plugin', 'marketplace', 'add', str(marketplace), '--json'],
                    ['plugin', 'add', PLUGIN + '@' + MARKETPLACE, '--json']):
        result = subprocess.run([codex, *command], cwd=state / 'workspace', env=env, capture_output=True, timeout=90)
        require(result.returncode == 0, 'PRIVATE_PLUGIN_INSTALL_FAILED')
    host_module = module('mainnet_standalone_host', 'accept-codex-plugin-dev.py')
    checks, completed = [], False
    try:
        for iteration in range(2):
            host = host_module.Host(codex, env, state / 'workspace')
            try:
                host.call('initialize', {'clientInfo': {'name': 'yosh_mainnet_standalone_readonly', 'version': VERSION},
                                        'capabilities': {'experimentalApi': True}})
                host.send({'method': 'initialized', 'params': {}})
                thread = host.call('thread/start', {'cwd': str(state / 'workspace'), 'sandbox': 'read-only',
                    'approvalPolicy': 'on-request', 'ephemeral': True})['thread']['id']
                inventory = host.call('mcpServerStatus/list', {'threadId': thread, 'detail': 'toolsAndAuthOnly'})
                servers = [server for server in inventory['data'] if {'get_spending_status', 'get_purchase'} <= set(server.get('tools', {}))]
                require(len(servers) == 1, 'EXACT_COMBINED_PLUGIN_REQUIRED')
                server = servers[0]
                def call(tool, arguments):
                    # Deliberate allowlist: no future caller may turn this into a purchase/recovery harness.
                    require(tool in ('get_spending_status', 'get_purchase'), 'READ_ONLY_ACCEPTANCE_TOOL_REQUIRED')
                    return parse_tool(host.call('mcpServer/tool/call', {'threadId': thread, 'server': server['name'],
                        'tool': tool, 'arguments': {'environment': 'mainnet', **arguments}}))
                facts = status_facts(call('get_spending_status', {}), member)
                purchase = call('get_purchase', {'purchaseId': args.purchase_id})
                require(purchase.get('purchaseId') == args.purchase_id and purchase.get('network') == MAINNET_NETWORK
                        and purchase.get('assetId') == MAINNET_ASSET, 'ORIGINAL_MAINNET_PURCHASE_REQUIRED')
                purchase = select(purchase, ('purchaseId', 'operationId', 'status', 'paymentStatus', 'deliveryStatus',
                    'policyCode', 'resourceId', 'amount', 'network', 'assetId', 'assetDecimals', 'transaction'))
                proof = runtime_proof(home, codex_home, host.child.pid, mainnet_digest, expected)
                checks.append({'hostRun': iteration + 1, 'status': facts, 'purchase': purchase, 'runtime': proof})
                require(iteration == 0 or (checks[0]['status'] == facts and checks[0]['purchase'] == purchase
                        and checks[0]['runtime']['pid'] == proof['pid']), 'FRESH_HOST_IDENTITY_OR_STATE_CHANGED')
            finally:
                host.close()
            require(listener_pids(13449) == {checks[-1]['runtime']['pid']}, 'HOST_CLOSE_STOPPED_SHARED_BACKEND')
            require(fingerprints(database) == before, 'ECONOMIC_OR_EVIDENCE_TABLES_CHANGED')
        completed = True
    finally:
        after = fingerprints(database)
        unchanged_config = (sha(original_config) if original_config.exists() else None) == config_before
        record = {'kind': 'real-codex-app-server-readonly', 'pluginVersion': VERSION,
            'acceptancePassed': completed and unchanged_config and before == after,
            'desktopSessionReloadVerified': False, 'desktopGuiAcceptance': False, 'modelTurnStarted': False,
            'paymentCalls': 0, 'recoveryCalls': 0, 'authorizationChangesRequested': False,
            'scriptStoppedOrUpgradedBackend': False, 'backendsLeftRunning': True,
            'originalCodexConfigUnchanged': unchanged_config, 'economicAndEvidenceTablesUnchanged': before == after,
            'tableHashesBefore': before, 'tableHashesAfter': after, 'checks': checks, 'completedAt': time.time()}
        (state / 'evidence.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    require(unchanged_config, 'ORIGINAL_CODEX_CONFIG_CHANGED')
    require(before == after, 'ECONOMIC_OR_EVIDENCE_TABLES_CHANGED')
    print(json.dumps({'hostRuns': len(checks), 'pluginVersion': VERSION, 'mainnetPid': checks[0]['runtime']['pid'],
        'wallet': checks[0]['status']['wallet']['address'], 'memberId': member, 'purchaseId': args.purchase_id,
        'economicAndEvidenceTablesUnchanged': True, 'originalCodexConfigUnchanged': True,
        'paymentCalls': 0, 'desktopSessionReloadVerified': False, 'evidence': str(state / 'evidence.json')}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok': False, 'code': code if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', code)
                         else 'MAINNET_HOST_ACCEPTANCE_FAILED'}), file=sys.stderr)
        sys.exit(1)
