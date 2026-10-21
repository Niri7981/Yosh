"""Exercise the actual Rust process against fresh loopback challenge/RPC fixtures.

No keys, signing, original PoC Gate, Yosh database or production network is used.
"""
import base64
import copy
import json
import os
import pathlib
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

root = pathlib.Path(__file__).resolve().parents[2]
binary = root / 'build.noindex/pay-protocol-engine/yosh-execution-protocol'
if not binary.is_file() or not pathlib.Path('/usr/bin/sandbox-exec').is_file():
    raise SystemExit('BLOCKED: build the helper; macOS sandbox-exec required')
network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
requirement = {'scheme': 'exact', 'network': network, 'amount': '200000',
               'asset': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
               'payTo': '11111111111111111111111111111111', 'maxTimeoutSeconds': 60,
               'extra': {'decimals': 6, 'feePayer': 'Vote111111111111111111111111111111111111111',
                         'memo': 'isolated-hostile-challenge'}}
current = copy.deepcopy(requirement)
rpc_calls = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        challenge = {'x402Version': 2, 'resource': {'url': origin + '/resource'}, 'accepts': [current]}
        self.send_response(402)
        self.send_header('payment-required', base64.b64encode(json.dumps(challenge).encode()).decode())
        self.end_headers()
        self.wfile.write(b'{}')

    def do_POST(self):
        global rpc_calls
        request = json.loads(self.rfile.read(int(self.headers['content-length'])))
        if request['method'] != 'getLatestBlockhash':
            self.send_error(400)
            return
        rpc_calls += 1
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'jsonrpc': '2.0', 'id': 1,
            'result': {'context': {'slot': 1}, 'value': {
                'blockhash': '11111111111111111111111111111111', 'lastValidBlockHeight': 1000}}}).encode())


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
origin = f'http://127.0.0.1:{server.server_port}'
threading.Thread(target=server.serve_forever, daemon=True).start()
checks = []
try:
    with tempfile.TemporaryDirectory(prefix='yosh-rust-hostile-') as temporary:
        os.chmod(temporary, 0o700)
        profile = pathlib.Path(temporary) / 'runtime.sb'
        denied = [pathlib.Path.home() / item for item in [
            'Library/Keychains', 'Library/Application Support/Yosh', 'Library/Application Support/2049',
            '.config/solana', '.config/pay', 'Desktop/yosh/.data', 'Desktop/open-source/pay']]
        profile.write_text('(version 1)\n(allow default)\n(deny network*)\n'
            '(allow network-outbound (remote ip "localhost:*"))\n'
            '(deny process-exec (literal "/usr/bin/security"))\n'
            '(deny file-read* file-write* ' + ' '.join(f'(subpath {json.dumps(str(path))})' for path in denied) + ')\n')

        def invoke(value):
            result = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile), str(binary)],
                input=json.dumps(value), text=True, capture_output=True, check=False, timeout=10,
                cwd=temporary, env={'PATH': '/usr/bin:/bin', 'HOME': temporary})
            if result.returncode:
                raise RuntimeError(f'isolated helper failed ({result.returncode}): {result.stderr[:1024]}')
            return json.loads(result.stdout)

        def quote():
            return invoke({'operation': 'quote', 'url': origin + '/resource', 'method': 'GET', 'headers': {}})

        def prepare(value):
            return invoke({'operation': 'prepare', 'payer': 'So11111111111111111111111111111111111111112',
                           'rpcUrl': origin + '/rpc', 'requirement': value})

        baseline = quote()
        assert baseline['ok'] and baseline['classifier'] == 'pay-core'
        assert prepare(baseline['requirement'])['ok'] and rpc_calls == 1
        checks.append('real quote and unsigned prepare baseline')
        for field, value in [('paymentFlow', 'settlement'), ('assetTransferMethod', 'permit2')]:
            current = copy.deepcopy(requirement)
            current['extra'][field] = value
            assert quote() == {'ok': False, 'error': 'UNSUPPORTED_PAYMENT_TERMS'}
            assert prepare(current) == {'ok': False, 'error': 'UNSUPPORTED_PAYMENT_TERMS'}
            assert rpc_calls == 1, 'hostile prepare must fail before RPC or construction'
            checks.extend([f'{field} quote refused', f'{field} prepare refused before RPC'])
        current = copy.deepcopy(requirement)
        current['extra']['tokenProgram'] = '11111111111111111111111111111111'
        assert quote() == {'ok': False, 'error': 'UNSUPPORTED_TOKEN_PROGRAM'}
        assert prepare(current) == {'ok': False, 'error': 'UNSUPPORTED_TOKEN_PROGRAM'}
        assert rpc_calls == 1
        checks.append('foreign token program refused by quote and prepare')
        sanitized = base64.b64encode(json.dumps({'success': True, 'network': network}).encode()).decode()
        result = invoke({'operation': 'interpret', 'status': 200, 'headers': {'payment-response': sanitized}})
        assert result['ok'] and result['receipt'] == {'success': True, 'network': network}
        checks.append('receipt without payer preserves optional field schema')
        print(json.dumps({'status': 'PASS', 'checks': checks, 'rpcCalls': rpc_calls,
                          'realSigning': False, 'realPayment': False}))
finally:
    server.shutdown()
    server.server_close()
