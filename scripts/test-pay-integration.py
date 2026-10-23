"""Run the production-module integration in a private, loopback-only OS sandbox."""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
node = shutil.which('node')
if not node or not pathlib.Path('/usr/bin/sandbox-exec').is_file():
    raise SystemExit('BLOCKED: Node >=24 and macOS sandbox-exec are required')
for required in [root / 'build.noindex/pay-protocol-engine/yosh-execution-protocol',
        root / 'build.noindex/pay-mcp-target/debug/yosh-controlled-mcp',
        root.parent / 'pay/rust/crates/mcp/tests/fixtures/agent402-mainnet-quote.json']:
    if not required.is_file():
        raise SystemExit(f'BLOCKED: missing prepared Pay dependency: {required}; see integration/README.md')

user = pathlib.Path.home()
private_paths = [user / 'Library/Keychains', pathlib.Path('/Library/Keychains'),
    user / '.config/solana', user / '.config/pay', user / 'Library/Application Support/2049',
    user / 'Library/Application Support/Yosh', user / '.codex/auth.json', user / '.codex/config.toml',
    user / 'Desktop/yosh/.data']
protected_paths = [user / 'Desktop/yosh', user / 'Desktop/open-source/pay',
    user / 'Desktop/open-source/yosh-pay-integration-poc', user / 'Applications/Yosh.app']
with tempfile.TemporaryDirectory(prefix='yosh-pay-verification-') as temporary:
    runtime = pathlib.Path(temporary)
    profile = runtime / 'isolation.sb'
    profile.write_text('(version 1)\n(allow default)\n(deny network*)\n'
        '(allow network-bind (local ip "localhost:*"))\n'
        '(allow network-inbound (local ip "localhost:*"))\n'
        '(allow network-outbound (remote ip "localhost:*"))\n'
        '(deny process-exec (literal "/usr/bin/security"))\n'
        '(deny mach-lookup (global-name "com.apple.securityd"))\n'
        '(deny file-read* file-write* ' + ' '.join(f'(subpath {json.dumps(str(path))})' for path in private_paths) + ')\n'
        '(deny file-write* ' + ' '.join(f'(subpath {json.dumps(str(path))})' for path in protected_paths) + ')\n'
        '(deny file-read* (regex #"^/Users/[^/]+/Desktop/yosh/\\.env(\\..*)?$"))\n')
    # The RC builder supplies its already-recorded policy. This runner remains
    # the single sandbox owner; macOS rejects nesting sandbox-exec processes.
    supplied_profile = os.environ.get('YOSH_PAY_TEST_SANDBOX_PROFILE')
    if supplied_profile:
        profile = pathlib.Path(supplied_profile)
        if not profile.is_absolute() or profile.is_symlink() or not profile.is_file():
            raise SystemExit('BLOCKED: explicit test sandbox profile must be an absolute regular file')
    environment = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(runtime), 'TMPDIR': str(runtime),
        'NODE_ENV': 'test', 'NODE_DISABLE_COMPILE_CACHE': '1', 'CI': '1'}
    all_tests = sys.argv[1:] == ['--all']
    if all_tests or not sys.argv[1:] or any('execution-persistence' in arg for arg in sys.argv[1:]):
        subprocess.run([sys.executable, str(root / 'scripts/prepare-pay-compatibility.py')], cwd=root, check=True)
    tests = ['tests/unit', 'tests/integration'] if all_tests else (sys.argv[1:] or [
        'tests/integration/pay-protocol-production.test.ts', 'tests/integration/pay-mcp-first.test.ts', 'tests/integration/execution-persistence.test.ts', 'tests/unit/pay-execution-boundary.test.ts'])
    vitest = [node, str(root / 'node_modules/vitest/vitest.mjs'), 'run']
    commands = [vitest + ['--config', 'vitest.pay.config.ts', *tests]]
    if all_tests:
        commands = [vitest + ['--config', 'vitest.pay.config.ts', *tests]]
        # Existing native .mjs suites use node:test, not the Vitest API. Execute
        # them with their own runner rather than dropping or weakening them.
        commands.append([node, '--test', *map(str, sorted((root / 'tests/native').glob('*.test.mjs')))])
    for command in commands:
        result = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile), *command],
            cwd=root, env=environment, check=False)
        if result.returncode:
            raise SystemExit(result.returncode)
