"""Build/review the isolated Pay MCP worktree, offline and without production state.

This script consumes the explicitly preserved adjacent Pay and pay-kit-current
sources. It never fetches, installs, changes the original checkouts or enables
production execution. See integration/pay-mcp-first/README.md.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--test', action='store_true', help='also run Pay regressions, clippy and compatibility checks')
parser.add_argument('--baseline', type=Path, help='explicit fresh original-source fingerprint snapshot; historical baselines remain unchanged')
options = parser.parse_args()
root = Path(__file__).resolve().parents[1]
pay = root.parent / 'pay'
kit = root.parent / 'pay-kit-current'
output = root / 'build.noindex/pay-mcp-target'
output.mkdir(parents=True, exist_ok=True)
profile = root / 'integration/pay-mcp-first/isolation.sb'
baseline_file = options.baseline or root / 'integration/pay-mcp-first/source-baselines.json'
baselines = json.loads(baseline_file.read_text())
expected = baselines['pr514']['head']
actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=pay, text=True).strip()
if actual != expected or not (kit / 'src/x402/client/exact/payment.rs').is_file():
    raise SystemExit('BLOCKED: isolated Pay base or patched kit is missing/different')
# Original sources and pre-existing user edits must stay exactly as observed.
for name, baseline in baselines.items():
    source = Path(baseline['path'])
    if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip() != baseline['head']:
        raise SystemExit(f'BLOCKED: original {name} HEAD changed')
    for filename, digest in baseline['files'].items():
        file = source / filename
        if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != digest:
            raise SystemExit(f'BLOCKED: original {name} working changes changed: {filename}')
commands = [['cargo', 'build', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-controlled-mcp']]
if options.test:
    commands.extend([
        ['cargo', 'test', '--offline', '--locked', '-p', 'pay-mcp', '--lib', '--test', 'external_authority', '--test', 'curl_http_e2e'],
        ['cargo', 'clippy', '--offline', '--locked', '-p', 'pay-mcp', '--all-targets', '--', '-D', 'warnings'],
        ['cargo', 'check', '--offline', '--locked', '-p', 'pay-connect'],
        ['cargo', 'fmt', '--all', '--check'],
    ])
with tempfile.TemporaryDirectory(prefix='pay-mcp-first-build-') as private:
    home = Path(private)
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(home), 'CARGO_HOME': str(home / 'cargo'),
        'RUSTUP_HOME': os.environ.get('RUSTUP_HOME', str(Path.home() / '.rustup')), 'CARGO_NET_OFFLINE': 'true',
        'CARGO_TARGET_DIR': str(output)}
    for index, command in enumerate(commands):
        log = output / f'verification-{index}.log'
        with log.open('w') as stream:
            result = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile), *command], cwd=pay / 'rust',
                env=env, stdout=stream, stderr=subprocess.STDOUT)
        print(command[1], 'PASS' if result.returncode == 0 else f'FAIL: {log}', flush=True)
        if result.returncode:
            raise SystemExit(result.returncode)
files = subprocess.check_output(['git', 'ls-files', '-m', '-o', '--exclude-standard', '-z'], cwd=pay).decode().split('\0')
provenance = {'payBase': expected, 'payKitBase': 'bd3ad25baeb65c1c293239e1b4990f14d26a22ad',
    'originalSourceBaselineSha256': hashlib.sha256(baseline_file.read_bytes()).hexdigest(),
    'paySourceSha256': {f: hashlib.sha256((pay / f).read_bytes()).hexdigest() for f in files if f and (pay / f).is_file()},
    'kitPaymentSha256': hashlib.sha256((kit / 'src/x402/client/exact/payment.rs').read_bytes()).hexdigest(),
    'binarySha256': hashlib.sha256((output / 'debug/yosh-controlled-mcp').read_bytes()).hexdigest(),
    'commands': commands, 'originalSourcesUnchanged': True, 'offline': True, 'productionEnabled': False}
(output / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
