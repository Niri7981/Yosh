"""Release scope and state-preserving installer rejection paths; fixture-only."""
import copy
import importlib.util
import json
import hashlib
import plistlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('stable_builder', ROOT / 'scripts/build-stable-release.py')
stable = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stable)


class StableReleaseTests(unittest.TestCase):
    def test_grant_authorization_update_requires_explicit_bounded_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / 'Yosh.app'
            runtime = app / 'Contents/Resources/Runtime'
            (runtime / 'backend').mkdir(parents=True)
            backend = runtime / 'backend/server.js'
            backend.write_bytes(b'fixture updated backend')
            info = {'CFBundleName': 'Yosh', 'CFBundleDisplayName': 'Yosh',
                    'CFBundleShortVersionString': stable.VERSION, 'CFBundleVersion': stable.BUILD,
                    'CFBundleIdentifier': stable.rc.ISOLATION['bundleIdentifier'],
                    'CFBundleExecutable': 'Yosh', 'YoshStableRelease': True, 'YoshPayDevelopment': True}
            (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
            paths = ['src/modules/payment/pay-authority-adapter.ts', 'src/modules/payment/mainnet-pay-execution.ts']
            provenance = {'canonicalBase': stable.BASE, 'product': stable.verify_metadata(),
                          'paymentCoreUnchanged': False, 'sources': {'yosh': {'files': {p: 'a' * 64 for p in paths}}},
                          'notificationReadOnlyOverlay': {'updatedBackendSha256': 'b' * 64},
                          'grantAuthorizationUpdate': {'version': 1, 'kind': 'product-spend-grant-v1',
                            'baseBackendSha256': 'b' * 64, 'backendSha256': hashlib.sha256(backend.read_bytes()).hexdigest(),
                            'files': {p: {'baseSha256': 'a' * 64, 'sha256': 'c' * 64} for p in paths}}}
            manifest = runtime / 'stable-source-manifest.json'
            def verify(value):
                manifest.write_text(json.dumps(value))
                with mock.patch.object(stable.rc, 'verify_packaged_isolation'), mock.patch.object(stable.subprocess, 'run'):
                    return stable.verify_bundle(app)
            self.assertEqual(verify(provenance), info)
            mutations = [
                lambda p: p.pop('grantAuthorizationUpdate'),
                lambda p: p['grantAuthorizationUpdate'].update(backendSha256='0' * 64),
                lambda p: p['grantAuthorizationUpdate'].update(baseBackendSha256='0' * 64),
                lambda p: p['grantAuthorizationUpdate']['files'].update({'src/modules/payment/wallet.ts': {'baseSha256': 'a' * 64, 'sha256': 'c' * 64}}),
                lambda p: p['grantAuthorizationUpdate']['files'][paths[0]].update(baseSha256='0' * 64),
            ]
            for mutate in mutations:
                changed = copy.deepcopy(provenance)
                mutate(changed)
                with self.assertRaises(ValueError): verify(changed)

    def test_stable_build_follows_every_frozen_candidate(self):
        self.assertEqual(stable.verify_metadata(), {
            'name': 'Yosh', 'version': '0.1.1', 'buildNumber': '7', 'channel': 'stable'})
        frozen = json.loads(stable.rc.LOCK.read_text())
        self.assertEqual(frozen['product']['buildNumber'], '6')
        self.assertEqual(stable.rc.ISOLATION, frozen['isolation'])

    def test_promotion_cannot_change_core_custody_or_persisted_profile(self):
        frozen = {'files': {'src/modules/payment/keychain.ts': 'one', 'package.json': 'two'},
                  'modes': {'src/modules/payment/keychain.ts': '100644', 'package.json': '100644'}}
        current = copy.deepcopy(frozen)
        current['files']['package.json'] = 'stable'
        self.assertEqual(stable.check_differences(current, frozen, stable.PROMOTION_FILES), ['package.json'])
        for path in ['src/modules/payment/keychain.ts', 'src/modules/pay-dev/profile.ts', 'src/modules/purchases/purchase-ledger.ts']:
            changed = copy.deepcopy(current)
            changed['files'][path] = 'unreviewed'
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'outside stable'):
                stable.check_differences(changed, frozen, stable.PROMOTION_FILES)
        deleted = copy.deepcopy(current)
        del deleted['files']['package.json']
        with self.assertRaises(ValueError):
            stable.check_differences(deleted, frozen, stable.PROMOTION_FILES)
        changed = copy.deepcopy(current)
        changed['modes']['src/modules/payment/keychain.ts'] = '100755'
        with self.assertRaises(ValueError):
            stable.check_differences(changed, frozen, stable.PROMOTION_FILES)

    def test_existing_stable_bundle_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            existing = directory / 'Yosh.app'
            existing.mkdir()
            marker = existing / 'original'
            marker.write_text('existing application')
            with mock.patch.object(stable, 'verify_artifact', return_value=directory / 'staging/Yosh.app'), \
                    mock.patch.object(stable.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'Existing Yosh.app'):
                    stable.install(directory, directory)
                run.assert_not_called()
            self.assertEqual(marker.read_text(), 'existing application')

    def test_running_candidate_prevents_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with mock.patch.object(stable, 'verify_artifact', return_value=directory / 'staging/Yosh.app'), \
                    mock.patch.object(stable.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
                with self.assertRaisesRegex(ValueError, 'Quit Yosh normally'):
                    stable.install(directory, directory)
            self.assertFalse((directory / 'Yosh.app').exists())


if __name__ == '__main__':
    unittest.main()
