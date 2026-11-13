#!/usr/bin/env python3
"""Exercise packaged same-contract upgrades against private fixture ownership."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

package = Path(sys.argv[1]).resolve(strict=True)
sha = lambda value: hashlib.sha256(value).hexdigest()
checks = []
with tempfile.TemporaryDirectory(prefix='yosh-upgrade-fixture-') as tmp:
    parent = Path(tmp).resolve(); data = parent / 'Yosh Local Authorization Dev'; data.mkdir(mode=0o700)
    control = {'apiVersion': 2, 'dataContract': 'local-devnet-v1', 'profile': 'com.yosh.local-authorization-dev', 'environment': 'devnet', 'managementSecret': 'a' * 64}
    def write(path, value):
        path.write_text(json.dumps(value)); path.chmod(0o600)
    write(data / 'standalone-control.json', control)
    sentinel = data / 'ledger-fixture'; sentinel.write_bytes(b'preserve existing data exactly')
    versions = parent / 'Yosh Local Authorization Runtime Dev'; versions.mkdir(mode=0o700)
    staged = versions / 'staged'; staged.mkdir(mode=0o700)
    shutil.copy2(package / 'runtime/node', staged / 'node')
    (staged / 'standalone.cjs').write_text("require('node:fs').writeFileSync(require('node:path').join(process.argv[4], 'drained'), 'yes');")
    manifest = {'kind': 'yosh-local-devnet', 'apiVersion': 2, 'dataContract': 'local-devnet-v1', 'productionEnabled': False,
                'files': {name: sha((staged / name).read_bytes()) for name in ['node', 'standalone.cjs']}}
    write(staged / 'manifest.json', manifest); digest = sha((staged / 'manifest.json').read_bytes()); previous = versions / digest; staged.rename(previous)
    owner = {'apiVersion': 2, 'dataContract': 'local-devnet-v1', 'runtimeDigest': digest, 'pid': 2000000000, 'ready': False}
    write(data / 'standalone-owner.json', owner)
    def upgrade():
        return subprocess.run([str(package / 'yosh-dev'), 'upgrade', '--data-dir', str(data)], capture_output=True, text=True, timeout=55,
                              env={'HOME': str(parent), 'PATH': '/usr/bin:/bin', 'NODE_ENV': 'test'})
    original = (previous / 'standalone.cjs').read_bytes(); (previous / 'standalone.cjs').write_bytes(original + b'// damaged')
    failed = upgrade(); assert failed.returncode != 0 and 'STANDALONE_RUNTIME_INTEGRITY_FAILED' in failed.stderr
    assert not (data / 'drained').exists() and json.loads((data / 'standalone-owner.json').read_text()) == owner
    checks.append('reject-damaged-old-runtime-before-stop-or-owner-change'); (previous / 'standalone.cjs').write_bytes(original)
    result = upgrade(); assert result.returncode == 0, result.stderr
    expected = sha((package / 'runtime/manifest.json').read_bytes())
    assert json.loads((data / 'standalone-owner.json').read_text())['runtimeDigest'] == expected
    assert (data / 'drained').read_text() == 'yes' and sentinel.read_bytes() == b'preserve existing data exactly'
    assert json.loads((data / 'standalone-control.json').read_text()) == control
    assert len(list(data.glob('runtime-upgrade-*.json'))) == 1
    checks.append('drain-then-atomic-upgrade-preserves-existing-data-and-control')
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        assert all(r.returncode == 0 for r in pool.map(lambda _: upgrade(), range(2)))
    assert len(list(data.glob('runtime-upgrade-*.json'))) == 1
    checks.append('replayed-concurrent-upgrade-is-idempotent')
print(json.dumps({'checks': checks, 'payments': 0}))
