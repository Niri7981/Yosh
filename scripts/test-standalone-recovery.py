#!/usr/bin/env python3
"""Crash a test-owned Offline backend with an unresolved original purchase.

Uses only private fixture data/test funds. No real wallet, external network,
installed App or Desktop configuration. Kills only our own Popen child handle.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import queue
import re
import secrets
import sqlite3
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request

ORIGIN = 'http://127.0.0.1:15449'


class MCP:
    def __init__(self, package, directory, env, action='mcp'):
        self.child = subprocess.Popen([str(package / 'yosh-dev'), action, '--data-dir', str(directory)],
            cwd=directory.parent, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.queue = queue.Queue(); self.sequence = 0
        threading.Thread(target=self.read, daemon=True).start()
        self.call('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'standalone-recovery-test', 'version': '1'}})
        self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})

    def read(self):
        for line in self.child.stdout:
            try: self.queue.put(json.loads(line))
            except ValueError: self.queue.put({'error': 'MCP_INVALID_JSON'})
        self.queue.put({'error': 'MCP_CLOSED'})

    def send(self, message):
        self.child.stdin.write(json.dumps(message) + '\n'); self.child.stdin.flush()

    def call(self, method, params):
        self.sequence += 1
        self.send({'jsonrpc': '2.0', 'id': self.sequence, 'method': method, 'params': params})
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            message = self.queue.get(timeout=max(.01, deadline - time.monotonic()))
            if message.get('method') == 'ping': self.send({'jsonrpc': '2.0', 'id': message['id'], 'result': {}})
            if 'error' in message: raise RuntimeError('MCP_TEST_CALL_FAILED')
            if message.get('id') == self.sequence and 'method' not in message: return message['result']
        raise RuntimeError('MCP_TEST_TIMEOUT')

    def tool(self, name, args): return self.call('tools/call', {'name': name, 'arguments': args})

    def close(self):
        self.child.stdin.close(); self.child.wait(timeout=10)


def management(directory, method, path, body=None):
    secret = json.loads((directory / 'standalone-control.json').read_text())['managementSecret']
    raw = json.dumps(body, separators=(',', ':')).encode() if body is not None else b''
    nonce = secrets.token_hex(32); timestamp = str(int(time.time() * 1000))
    sha = lambda value: hashlib.sha256(value).hexdigest()
    message = '\n'.join(['2049-management-v1', method, path, timestamp, nonce, sha(raw)])
    request = urllib.request.Request(ORIGIN + path, data=raw if body is not None else None, method=method,
        headers={'Origin': ORIGIN, 'Content-Type': 'application/json', 'X-2049-Timestamp': timestamp,
                 'X-2049-Nonce': nonce, 'X-2049-Body-Sha256': sha(raw),
                 'X-2049-Proof': hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()})
    with urllib.request.urlopen(request, timeout=5) as response:
        data = response.read(65537)
        assert len(data) <= 65536
        proof = '\n'.join(['2049-management-response-v1', nonce, str(response.status), sha(data)])
        assert hmac.compare_digest(response.headers.get('x-2049-response-proof', ''), hmac.new(secret.encode(), proof.encode(), hashlib.sha256).hexdigest())
        return json.loads(data)


def status(client):
    result = client.tool('get_spending_status', {})
    assert not result.get('isError')
    record = json.loads(result['content'][0]['text'])
    assert record['realFunds'] is False and record['profile'] == 'isolated-pay-dev'
    return record['status']


def scenario(package, mode):
    parent = Path(tempfile.mkdtemp(prefix='yosh-standalone-crash-')).resolve()
    directory = parent / 'Yosh Standalone Plugin Dev'
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(parent), 'NODE_ENV': 'test'}
    def command(action):
        result = subprocess.run([str(package / 'yosh-dev'), action, '--data-dir', str(directory)],
            env=env, cwd=parent, capture_output=True, text=True, timeout=25)
        if result.returncode: raise RuntimeError('RECOVERY_LIFECYCLE_FAILED:' + result.stderr.strip()[:100])
        return json.loads(result.stdout)
    child = None; client = None
    try:
        command('start'); command('stop')
        runtime = package / 'runtime'
        child = subprocess.Popen(['/usr/bin/sandbox-exec', '-D', 'DATA=' + str(directory), '-D', 'RUNTIME=' + str(runtime),
            '-D', 'USERHOME=' + str(Path.home()), '-f', str(runtime / 'offline.sb'), str(runtime / 'node'),
            str(runtime / 'standalone.cjs'), 'serve', '--data-dir', str(directory)],
            cwd=directory, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if child.poll() is not None: raise RuntimeError('TEST_SERVICE_EXITED')
            try:
                if management(directory, 'GET', '/api/app/health').get('ready'): break
            except (OSError, ValueError): time.sleep(.1)
        else: raise RuntimeError('TEST_SERVICE_NOT_READY')
        owner = json.loads((directory / 'standalone-owner.json').read_text())
        assert owner['pid'] == child.pid  # kill target is our owned Popen, not an arbitrary record.
        management(directory, 'PUT', '/api/app/settings', {'dailyLimit': '400000'})
        management(directory, 'PUT', '/api/app/grant', {'action': 'create', 'totalLimit': '400000', 'singleLimit': '200000', 'expiresAt': int(time.time() * 1000) + 600000})
        management(directory, 'PUT', '/api/app/settings', {'paused': False})
        fault = directory / 'simulator/offline-fault.json'
        with fault.open('x') as stream: json.dump({'version': 1, 'mode': mode}, stream)
        fault.chmod(0o600)
        descriptor = json.loads((directory / 'pay-dev-runtime.json').read_text())
        operation = 'crash-' + mode
        client = MCP(package, directory, env)
        response = client.tool('curl', {'operation_id': operation, 'url': descriptor['merchantUrl']})
        assert response.get('isError') is True
        before = status(client)
        original = before['recentPurchases'][0]
        expected = 'PAYMENT_UNKNOWN' if mode == 'lose-paid-response-and-rpc' else 'PAID'
        assert original['status'] == expected
        assert before['budget']['reserved'] == ('200000' if expected == 'PAYMENT_UNKNOWN' else '0')
        network_path = directory / 'simulator/offline-network.json'
        network = json.loads(network_path.read_text())['transactions']
        assert len(network) == 1
        management(directory, 'PUT', '/api/app/settings', {'paused': True})
        child.kill(); child.wait(timeout=10); child = None
        client.close(); client = None
        # First restart with the fault still present must retain the original
        # unknown reservation; it must not reinterpret shutdown as permission.
        command('start')
        client = MCP(package, directory, env)
        after_crash = status(client)
        assert after_crash['recentPurchases'][0]['purchaseId'] == original['purchaseId']
        assert after_crash['budget']['paused'] is True
        if expected == 'PAYMENT_UNKNOWN':
            assert after_crash['budget']['reserved'] == '200000'
            assert after_crash['recentPurchases'][0]['status'] == 'PAYMENT_UNKNOWN'
        fault.write_text(json.dumps({'version': 1, 'mode': 'none'}))
        # Observe the durable schedule before retrying. A restart may already
        # have attempted delivery while the fixture was still unavailable.
        with sqlite3.connect(f'file:{directory / "app-ledger.sqlite"}?mode=ro', uri=True) as db:
            schedule = db.execute('SELECT state,retry_count,next_attempt_at,last_error FROM purchase_delivery').fetchone()
        assert schedule[1] <= 4
        if expected == 'PAID': assert schedule[0] in ['PENDING', 'COMPLETE'], schedule
        wait_seconds = max(0, (schedule[2] - int(time.time() * 1000)) / 1000) if expected == 'PAID' else 0
        assert wait_seconds <= 8
        if wait_seconds: time.sleep(wait_seconds + .05)
        recovered = client.tool('curl', {'operation_id': operation, 'url': descriptor['merchantUrl']})
        if recovered.get('isError'):
            codes = set(re.findall(r'\b[A-Z][A-Z0-9_]{3,80}\b', json.dumps(recovered)))
            assert {'OPERATION_ALREADY_STARTED', 'PAID', 'COMPLETE'} <= codes, sorted(codes)
        after = status(client)
        purchase = after['recentPurchases'][0]
        assert len(after['recentPurchases']) == 1 and purchase['purchaseId'] == original['purchaseId']
        assert purchase['status'] == 'PAID' and purchase['deliveryStatus'] == 'COMPLETE'
        assert after['budget']['reserved'] == '0' and after['budget']['paid'] == '200000'
        assert json.loads(network_path.read_text())['transactions'] == network
        again = client.tool('curl', {'operation_id': operation, 'url': descriptor['merchantUrl']})
        # Pay may reject executing an already completed operation. The wrapper
        # must still report the original paid/delivered purchase; use its read
        # tool instead of turning a repeat into a new payment request.
        repeated_codes = set(re.findall(r'\b[A-Z][A-Z0-9_]{3,80}\b', json.dumps(again)))
        if again.get('isError'):
            assert {'OPERATION_ALREADY_STARTED', 'PAID', 'COMPLETE'} <= repeated_codes, sorted(repeated_codes)
        readback = client.tool('get_purchase', {'operationId': operation})
        assert not readback.get('isError') and original['purchaseId'] in json.dumps(readback)
        assert json.loads(network_path.read_text())['transactions'] == network
        delivered = bytearray(); offset = 0
        for _ in range(64):
            chunk = client.tool('get_purchase_delivery', {'purchaseId': original['purchaseId'], 'offset': offset})
            assert not chunk.get('isError')
            content = json.loads(chunk['content'][0]['text'])
            delivered.extend(base64.b64decode(content['chunk']))
            if content['nextOffset'] is None: break
            assert content['nextOffset'] > offset; offset = content['nextOffset']
        else: raise AssertionError('DELIVERY_READ_TOO_LARGE')
        assert json.loads(delivered) == network[0]['delivery']
        return {'mode': mode, 'beforeCrash': expected, 'afterRecovery': 'PAID', 'delivery': 'COMPLETE',
                'samePurchase': True, 'fixtureTransfers': 1, 'realPayments': 0, 'pausedDuringRecovery': True,
                'scheduledBackoffRespected': True, 'deliveryReadMatchesOriginal': True}
    finally:
        if client: client.close()
        if child:
            child.terminate(); child.wait(timeout=15)
        if (directory / 'standalone-control.json').exists(): command('stop')
        shutil.rmtree(parent)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', type=Path)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    records = [scenario(args.package.resolve(strict=True), mode) for mode in ['lose-paid-response-and-rpc', 'delivery-unavailable']]
    result = {'kind': 'packaged-offline-abrupt-exit-recovery', 'scenarios': records, 'desktopAcceptance': False}
    with args.evidence.open('x') as stream: json.dump(result, stream, indent=2)
    print(json.dumps(result, indent=2))
