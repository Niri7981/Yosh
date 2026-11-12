#!/usr/bin/env python3
"""Opt-in packaged-runtime integration, not Codex Desktop acceptance. No payments."""
import argparse
import concurrent.futures
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', type=Path)
    parser.add_argument('--evidence', type=Path)
    args = parser.parse_args()
    package = args.package.resolve(strict=True)
    parent = Path(tempfile.mkdtemp(prefix='yosh-standalone-test-')).resolve()
    directory = parent / 'Yosh Standalone Plugin Dev'
    env = {'HOME': str(parent), 'PATH': '/usr/bin:/bin', 'NODE_ENV': 'test'}
    checks = []

    def command(action, target=package, expected=0):
        result = subprocess.run([str(target / 'yosh-dev'), action, '--data-dir', str(directory)],
            env=env, cwd=parent, capture_output=True, text=True, timeout=25)
        if result.returncode != expected:
            raise AssertionError(f'{action}: exit={result.returncode}, expected={expected}, code={result.stderr.strip()[:120]}')
        return result

    def read(name):
        return json.loads((directory / name).read_text())

    def checksum(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    client = None
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            starts = list(executor.map(lambda _: command('start'), range(3)))
        assert all(json.loads(result.stdout)['running'] for result in starts)
        original_owner = read('standalone-owner.json')
        original_wallet = read('pay-development.json')
        original_connection = read('mcp-connection.json') if (directory / 'mcp-connection.json').exists() else None
        assert json.loads(command('start').stdout)['running']
        assert read('standalone-owner.json') == original_owner
        checks.append('concurrent-and-repeat-start-single-owner')
        duplicate = command('serve', expected=1)
        assert 'DATA_DIRECTORY_IN_USE' in duplicate.stderr
        assert read('standalone-owner.json') == original_owner
        checks.append('duplicate-service-cannot-rewrite-owner')

        client = subprocess.Popen([str(package / 'yosh-dev'), 'mcp', '--data-dir', str(directory)],
            cwd=parent, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        replies = queue.Queue()
        def reader():
            for line in client.stdout:
                try: replies.put(json.loads(line))
                except ValueError: replies.put({'invalid': True})
        threading.Thread(target=reader, daemon=True).start()
        sequence = 0
        def request(method, params):
            nonlocal sequence
            sequence += 1
            client.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': sequence, 'method': method, 'params': params}) + '\n')
            client.stdin.flush()
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                message = replies.get(timeout=max(0.01, deadline - time.monotonic()))
                assert not message.get('invalid')
                if message.get('method') == 'ping':
                    client.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': {}}) + '\n'); client.stdin.flush()
                if message.get('id') == sequence and 'method' not in message:
                    assert 'error' not in message
                    return message['result']
            raise AssertionError('MCP_TIMEOUT')
        request('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'standalone-integration', 'version': '1'}})
        client.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); client.stdin.flush()
        listed = request('tools/list', {})
        actual_tools = {tool['name'] for tool in listed['tools']}
        # Existing wrapper exposes recover_payment only for live networks. This
        # Offline package must preserve its seven-tool allowlist, not widen it.
        assert actual_tools == {'get_spending_status', 'get_purchase', 'get_purchase_delivery',
            'quote_x402_resource', 'discover_x402_resource', 'register_x402_resource', 'curl'}, sorted(actual_tools)
        status = request('tools/call', {'name': 'get_spending_status', 'arguments': {}})
        assert not status.get('isError')
        data = status.get('structuredContent') or json.loads(status['content'][0]['text'])
        assert data['profile'] == 'isolated-pay-dev' and data['realFunds'] is False
        data = data['status']
        assert data['budget']['paused'] and not data['spendingAuthorized'] and not data['recentPurchases'] and data['grant'] is None
        checks.append('mcp-seven-tools-paused-no-grant-no-purchases')
        client.stdin.close(); client.wait(timeout=10); client = None
        assert json.loads(command('status').stdout)['running']
        checks.append('mcp-close-keeps-backend-alive')
        control_path = directory / 'standalone-control.json'
        original_control = control_path.read_bytes()
        wrong_token = json.loads(original_control); wrong_token['managementSecret'] = '0' * 64
        control_path.write_text(json.dumps(wrong_token))
        try:
            denied = command('start', expected=1)
            assert 'STANDALONE_BACKEND_AUTH_FAILED' in denied.stderr
        finally: control_path.write_bytes(original_control)
        assert read('standalone-owner.json') == original_owner
        assert json.loads(command('status').stdout)['running']
        checks.append('invalid-management-credential-no-takeover')
        alternative = parent / 'different-version'
        shutil.copytree(package, alternative)
        manifest_path = alternative / 'runtime/manifest.json'
        manifest = json.loads(manifest_path.read_text()); manifest['version'] = 'future-test-version'
        manifest_path.write_text(json.dumps(manifest))
        incompatible = command('start', target=alternative, expected=1)
        assert 'STANDALONE_VERSION_INCOMPATIBLE' in incompatible.stderr
        assert read('standalone-owner.json') == original_owner
        assert json.loads(command('status').stdout)['running']
        checks.append('different-runtime-does-not-replace-healthy-owner')
        assert not json.loads(command('stop').stdout)['running']
        assert not json.loads(command('status').stdout)['running']
        assert json.loads(command('start').stdout)['running']
        assert read('standalone-owner.json')['pid'] != original_owner['pid']
        assert read('pay-development.json') == original_wallet
        if original_connection: assert read('mcp-connection.json') == original_connection
        checks.append('safe-stop-and-process-restart-preserve-identity')
        command('stop')
        before = checksum(directory / 'app-ledger.sqlite')
        rejected_service = command('serve', target=alternative, expected=1)
        assert 'STANDALONE_VERSION_INCOMPATIBLE' in rejected_service.stderr
        assert checksum(directory / 'app-ledger.sqlite') == before
        checks.append('direct-service-entry-cannot-bypass-version-fence')
        modified = json.loads(original_control); modified['apiVersion'] = 999
        control_path.write_text(json.dumps(modified))
        try: command('start', expected=1)
        finally: control_path.write_bytes(original_control)
        assert checksum(directory / 'app-ledger.sqlite') == before
        checks.append('incompatible-contract-preserves-ledger')
        damaged = parent / 'damaged'
        shutil.copytree(package, damaged)
        with (damaged / 'runtime/mcp.cjs').open('a') as stream: stream.write('\n// damaged\n')
        failure = command('start', target=damaged, expected=1)
        assert 'STANDALONE_RUNTIME_INTEGRITY_FAILED' in failure.stderr
        assert checksum(directory / 'app-ledger.sqlite') == before
        checks.append('damaged-program-refused-preserves-ledger')
        class UntrustedListener(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"ready":true}')
            def log_message(self, *_): pass
        server = HTTPServer(('127.0.0.1', 15449), UntrustedListener)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            untrusted = command('start', expected=1)
            assert 'STANDALONE_BACKEND_AUTH_FAILED' in untrusted.stderr
            assert checksum(directory / 'app-ledger.sqlite') == before
        finally:
            server.shutdown(); server.server_close(); thread.join()
        checks.append('untrusted-listener-no-takeover')
        result = {'kind': 'packaged-standalone-offline-integration', 'passed': checks, 'payments': 0,
            'desktopAcceptance': False, 'testStateDeleted': True}
    finally:
        if client:
            client.stdin.close()
            client.wait(timeout=10)
        if (directory / 'standalone-control.json').exists():
            # Stop only via authenticated lifecycle, never kill a PID read from
            # a file. Preserve test state if safe shutdown is not confirmed.
            command('stop')
        shutil.rmtree(parent)
    if args.evidence:
        with args.evidence.open('x') as stream: json.dump(result, stream, indent=2)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
