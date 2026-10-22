"""Read the actual desktop config and verify only its offline Pay connection.
Never writes configuration/auth, calls curl, or starts a model turn.
"""
from pathlib import Path
import hashlib
import hmac
import json
import os
import queue
import re
import secrets
import sqlite3
import subprocess
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DATA = Path.home() / 'Library/Application Support/Yosh Pay Dev'
CLI = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
ORIGIN = 'http://127.0.0.1:13049'

def management(path):
    secret = (DATA / 'management-token').read_text()
    timestamp, nonce = str(int(time.time() * 1000)), secrets.token_hex(32)
    digest = hashlib.sha256(b'').hexdigest()
    message = '\n'.join(['2049-management-v1', 'GET', path, timestamp, nonce, digest])
    headers = {'x-2049-timestamp': timestamp, 'x-2049-nonce': nonce, 'x-2049-body-sha256': digest,
               'x-2049-proof': hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()}
    with urllib.request.urlopen(urllib.request.Request(ORIGIN + path, headers=headers), timeout=5) as response:
        return json.load(response)

def economic_snapshot():
    db = sqlite3.connect('file:' + str(DATA / 'app-ledger.sqlite') + '?mode=ro', uri=True)
    try:
        tables = ['purchases', 'original_payments', 'purchase_execution_provenance', 'spend_grants']
        return {table: hashlib.sha256(repr(db.execute('SELECT * FROM ' + table + ' ORDER BY rowid').fetchall()).encode()).hexdigest()
                for table in tables}
    finally:
        db.close()

# Parse the actual desktop config. Command output may contain other MCP secrets;
# keep it in memory only and emit only names and pass/fail facts.
names = re.findall(r'^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$', (Path.home() / '.codex/config.toml').read_text(), re.MULTILINE)
assert 'yosh_pay_dev' in names
args = [CLI]
for name in names:
    if name != 'yosh_pay_dev':
        args += ['-c', 'mcp_servers.' + name + '.enabled=false']
args += ['app-server', '--stdio']
# These are ephemeral verification-process overrides, never config writes.
# Prevent the verification child from opening formal Yosh or other MCPs.
before = economic_snapshot()
process = subprocess.Popen(args, cwd=DATA / 'codex-workspace', stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True, bufsize=1,
                           env={**{key: os.environ[key] for key in ('PATH', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR') if key in os.environ},
                                'HOME': str(Path.home()), 'CODEX_HOME': str(Path.home() / '.codex')})
messages = queue.Queue()
def read():
    try:
        for line in process.stdout:
            messages.put(json.loads(line))
    finally:
        messages.put(None)
threading.Thread(target=read, daemon=True).start()
sequence = 0
def send(value):
    process.stdin.write(json.dumps(value) + '\n')
    process.stdin.flush()
def call(method, params):
    global sequence
    sequence += 1
    identifier = sequence
    send({'id': identifier, 'method': method, 'params': params})
    end = time.monotonic() + 35
    while time.monotonic() < end:
        value = messages.get(timeout=max(.01, end - time.monotonic()))
        if value is None:
            raise RuntimeError('DESKTOP_CODEX_HOST_CLOSED')
        if value.get('id') == identifier and ('result' in value or 'error' in value):
            if 'error' in value:
                raise RuntimeError('DESKTOP_CODEX_RPC_REJECTED:' + method)
            return value['result']
        if 'id' in value and 'method' in value:
            send({'id': value['id'], 'error': {'code': -32601, 'message': 'No user interaction in read-only connection verification'}})
    raise RuntimeError('DESKTOP_CODEX_TIMEOUT')
try:
    call('initialize', {'clientInfo': {'name': 'yosh_pay_desktop_connection_check', 'version': '1'},
                        'capabilities': {'experimentalApi': True}})
    send({'method': 'initialized', 'params': {}})
    thread = call('thread/start', {'cwd': str(DATA / 'codex-workspace'), 'sandbox': 'read-only',
                                   'approvalPolicy': 'on-request', 'ephemeral': True})['thread']['id']
    status = call('mcpServerStatus/list', {'threadId': thread, 'serverName': 'yosh_pay_dev', 'detail': 'toolsAndAuthOnly'})
    pay = next(item for item in status['data'] if item['name'] == 'yosh_pay_dev')
    assert not pay.get('toolsError')
    assert 'curl' in pay['tools']
    connected = False
    for _ in range(25):
        connection = management('/api/app/overview')['connection']
        # The existing session lease requires real Codex -> real Pay wrapper
        # ping replies, then member-capability authentication by AppRuntime.
        if connection.get('integration', {}).get('connected') or connection.get('integration', {}).get('state') == 'connected':
            connected = True
            break
        time.sleep(.2)
    if not connected:
        raise RuntimeError('YOSH_HOST_HANDSHAKE_NOT_OBSERVED')
    health = management('/api/app/health')
    assert health['coreReady'] and health['dataDirectory'] == str(DATA)
    assert economic_snapshot() == before
    result = {'configSource': str(Path.home() / '.codex/config.toml'), 'realDesktopCodexBinary': CLI,
              'realPayMcpDiscovered': True, 'curlToolDiscovered': True, 'authenticatedYoshHostHandshake': True,
              'coreReady': True, 'dataDirectory': str(DATA), 'economicRowsUnchanged': True,
              'purchaseToolCalled': False, 'modelTurnStarted': False, 'formalMcpConnectionsDisabledInVerificationChildOnly': True,
              'otherConfigEntriesModified': False, 'loginFilesCopiedOrModified': False, 'production': 'BLOCKED'}
    (ROOT / 'integration/desktop-connection-fix/verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
finally:
    process.stdin.close()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=10)
