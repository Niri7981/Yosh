"""Candidate identity checks use source text and disposable bundle fixtures only."""
import copy
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('rc3_builder', ROOT / 'scripts/build-release-candidate.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class CandidateIsolationTests(unittest.TestCase):
    def test_native_and_manifest_share_candidate_identity(self):
        native = (ROOT / 'apps/macos/Yosh/YoshApp/Services/BackendLaunchConfiguration.swift').read_text()
        identity = builder.ISOLATION
        for value in [identity['bundleIdentifier'], identity['directoryName']]:
            self.assertIn(value, native)
        for port in identity['ports'].values():
            self.assertIn(str(port), native)
        self.assertEqual(builder.check_version(), {
            'version': '0.1.1', 'releaseCandidate': '0.1.1-rc.5', 'buildNumber': '6'})

    def test_predecessor_comparison_rejects_business_and_pay_changes(self):
        previous = json.loads(builder.PREDECESSOR_LOCK.read_text())
        sources = copy.deepcopy(previous['sources'])
        sources['pay']['head'] = builder.HEADS['pay']
        self.assertEqual(builder.predecessor_differences(sources), [])
        for source, path in [('yosh', 'src/modules/authority/spend-grant.ts')]:
            changed = copy.deepcopy(sources)
            changed[source]['files'][path] = 'unexpected-source-change'
            with self.assertRaises(ValueError):
                builder.predecessor_differences(changed)

    def test_only_explicit_lifecycle_files_are_allowed(self):
        self.assertIn('src/modules/payment/pay-authority-adapter.ts', builder.RC5_FILES)
        for path in ['src/modules/purchases/purchase-ledger.ts',
                     'src/modules/payment/pay-controller-diagnostics.ts',
                     'tests/unit/pay-controller-contract.test.ts',
                     'tests/unit/pay-controller-diagnostics.test.ts']:
            self.assertIn(path, builder.RC5_FILES)
        self.assertNotIn('src/modules/authority/spend-grant.ts', builder.RC5_FILES)

    def test_packaged_entry_points_reject_old_dev_configuration(self):
        with tempfile.TemporaryDirectory(prefix='rc3-isolation-fixture-') as temporary:
            app = Path(temporary) / 'Candidate.app'
            runtime = app / 'Contents/Resources/Runtime'
            (runtime / 'backend').mkdir(parents=True)
            (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
                'CFBundleIdentifier': builder.ISOLATION['bundleIdentifier'],
                'YoshCandidateIsolation': builder.ISOLATION}))
            (runtime / 'candidate-isolation.json').write_text(json.dumps(builder.ISOLATION))
            names = ['backend/server.js', 'mcp.cjs', 'confirm-pay-mainnet.cjs']
            for name in names:
                (runtime / name).write_text('// disposable compiled entry fixture\n')
            for name in ['pay-dev.sb', 'pay-dev-mainnet.sb']:
                (runtime / name).write_text('/Library/Application Support/Yosh Pay Dev\"\n/Library/Application Support/Yosh Pay Dev v0.1.1-rc.2\"\n/Library/Application Support/Yosh Pay Dev v0.1.1-rc.3\"\n/Library/Application Support/Yosh Pay Dev v0.1.1-rc.4\"')
            (runtime / names[0]).write_text('[[13250, 13250], "disallowed"]')
            builder.verify_packaged_isolation(app)
            for old in ['13049', '13050', '13051', '13149', '13150', '13151', 'com.yosh.pay-development.wallet.offline.v1', 'com.yosh.pay-development.v011rc2.wallet.mainnet.v1', '"Yosh Pay Dev"', '"Yosh Pay Dev v0.1.1-rc.2"']:
                (runtime / names[0]).write_text(old)
                with self.subTest(old=old), self.assertRaises(ValueError):
                    builder.verify_packaged_isolation(app)


if __name__ == '__main__':
    unittest.main()
