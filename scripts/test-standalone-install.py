#!/usr/bin/env python3
"""Verify runtime lifetime is independent of a disposable plugin cache."""
import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('recovery_test', ROOT / 'scripts/test-standalone-recovery.py')
support = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(support)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', type=Path)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    package = args.package.resolve(strict=True)
    parent = Path(tempfile.mkdtemp(prefix='yosh-runtime-install-')).resolve()
    data = parent / 'Yosh Standalone Plugin Dev'
    versions = parent / 'Yosh Standalone Runtime Dev'; versions.mkdir(mode=0o700)
    partial = versions / '.install-interrupted-test'; partial.mkdir(mode=0o700)
    (partial / 'node').write_text('incomplete installation')
    cache = parent / 'plugin-cache'; shutil.copytree(package, cache)
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(parent), 'NODE_ENV': 'test'}
    digest = hashlib.sha256((package / 'runtime/manifest.json').read_bytes()).hexdigest()
    installed = versions / digest
    clients = []
    checks = []
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            clients.extend(executor.map(lambda _: support.MCP(cache, data, env, 'install-mcp'), range(2)))
        checks.append('concurrent-atomic-version-install')
        for client in clients:
            status = support.status(client); assert status['budget']['paused'] and not status['recentPurchases']
        owner = json.loads((data / 'standalone-owner.json').read_text())
        command = subprocess.check_output(['/bin/ps', '-p', str(owner['pid']), '-o', 'command='], text=True).strip()
        assert command.startswith(str(installed / 'node') + ' ')
        checks.append('backend-executes-from-independent-version-directory')
        wallet = (data / 'pay-development.json').read_bytes()
        assert partial.exists() and (installed / 'pay-mcp').exists()
        checks.append('incomplete-staging-never-activated')
        shutil.rmtree(cache)
        for client in clients: client.close()
        clients.clear()
        result = subprocess.run([str(installed / 'node'), str(installed / 'standalone.cjs'), 'status', '--data-dir', str(data)],
            env=env, capture_output=True, text=True, timeout=15)
        assert result.returncode == 0 and json.loads(result.stdout)['running']
        checks.append('cache-removal-and-mcp-close-preserve-running-backend')
        shutil.copytree(package, cache)
        clients.append(support.MCP(cache, data, env, 'install-mcp'))
        assert support.status(clients[0])['budget']['paused']
        assert json.loads((data / 'standalone-owner.json').read_text()) == owner
        assert (data / 'pay-development.json').read_bytes() == wallet
        checks.append('reinstall-reuses-original-backend-and-wallet')
        for client in clients: client.close()
        clients.clear()
        original = (installed / 'mcp.cjs').read_bytes()
        (installed / 'mcp.cjs').write_bytes(original + b'\n// damaged test copy\n')
        try:
            rejected = subprocess.run([str(cache / 'yosh-dev'), 'install-mcp', '--data-dir', str(data)],
                env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15)
            assert rejected.returncode == 1 and 'STANDALONE_RUNTIME_INTEGRITY_FAILED' in rejected.stderr
            assert (data / 'pay-development.json').read_bytes() == wallet
        finally: (installed / 'mcp.cjs').write_bytes(original)
        checks.append('damaged-installed-version-refused-without-replacing-wallet')
    finally:
        for client in clients: client.close()
        if (data / 'standalone-control.json').exists():
            result = subprocess.run([str(package / 'yosh-dev'), 'stop', '--data-dir', str(data)], env=env, capture_output=True, timeout=20)
            if result.returncode: raise RuntimeError('SAFE_TEST_SHUTDOWN_FAILED')
        shutil.rmtree(parent)
    evidence = {'kind': 'standalone-version-install-lifecycle', 'checks': checks, 'payments': 0, 'testStateDeleted': True}
    with args.evidence.open('x') as stream: json.dump(evidence, stream, indent=2)
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__': main()
