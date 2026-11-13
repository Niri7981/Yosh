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
    def test_diagnostics_overlay_preserves_parent_and_all_non_backend_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            app = output / 'Yosh.app'
            evidence = output / 'payment-diagnostics'; evidence.mkdir()
            for name in [stable.BACKEND_BINARY, stable.PAY_BINARY, stable.SOURCE_MANIFEST]:
                path = app / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(name.encode())
            old = stable.rc.digest(app / stable.BACKEND_BINARY)
            base = {'localGrantWebUpdate': {'backendSha256': old}, 'historical': 'preserved'}
            (evidence / 'base-source-manifest.json').write_text(json.dumps(base))
            parent = {'files': stable.rc.tree_files(app), 'sourceManifestSha256': stable.rc.digest(evidence / 'base-source-manifest.json')}
            (evidence / 'base-artifact.json').write_text(json.dumps(parent))
            files = {name: 'a' * 64 for name in stable.DIAGNOSTICS_SOURCES}
            (evidence / 'source-changes.json').write_text(json.dumps({'baselineReproduced': True, 'files': files}))
            (app / stable.BACKEND_BINARY).write_bytes(b'diagnostic backend')
            update = {'version': 1, 'kind': 'payment-diagnostics-v1', 'baseBackendSha256': old,
                      'backendSha256': stable.rc.digest(app / stable.BACKEND_BINARY), 'files': files,
                      'evidence': {p.name: stable.rc.digest(p) for p in evidence.iterdir()}}
            provenance = {**base, 'paymentDiagnosticsUpdate': update}
            self.assertEqual(stable.verify_payment_diagnostics_evidence(output, app, provenance), (base, parent['files']))
            for mutate in [lambda p: p.update(historical='changed'),
                           lambda p: p['paymentDiagnosticsUpdate']['files'].clear(),
                           lambda p: p['paymentDiagnosticsUpdate'].update(baseBackendSha256='b' * 64)]:
                changed = copy.deepcopy(provenance); mutate(changed)
                with self.assertRaises(ValueError): stable.verify_payment_diagnostics_evidence(output, app, changed)
            (app / stable.PAY_BINARY).write_bytes(b'unrelated SDK change')
            with self.assertRaises(ValueError): stable.verify_payment_diagnostics_evidence(output, app, provenance)

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

    @mock.patch.object(stable, 'native_code_digest', side_effect=lambda path: stable.rc.digest(path))
    def test_web_grant_overlay_preserves_native_and_payment_binaries(self, _native_digest):
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / 'Yosh.app'
            names = ['Contents/MacOS/Yosh', 'Contents/MacOS/YoshBackendNode', 'Contents/Resources/Runtime/mcp.cjs',
                     'Contents/Resources/Runtime/pay-mcp', 'Contents/Resources/Runtime/pay-protocol-engine']
            for name in names + ['Contents/Resources/Runtime/backend/server.js']:
                file = app / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(name.encode())
            paths = ['src/modules/authority/local-grant-approval.ts', 'src/modules/authority/mainnet-local-grants.ts',
                     'src/modules/app/app-runtime.ts', 'src/modules/purchases/purchase-ledger.ts', 'src/modules/pay-dev/management-server.ts']
            update = {'version': 1, 'kind': 'local-grant-web-v1', 'baseBackendSha256': 'a' * 64,
                      'backendSha256': stable.rc.digest(app / 'Contents/Resources/Runtime/backend/server.js'),
                      'baselineReproduced': True, 'files': {p: 'b' * 64 for p in paths},
                      'preservedBinaries': {p: stable.rc.digest(app / p) for p in names}}
            provenance = {'grantAuthorizationUpdate': {'backendSha256': 'a' * 64}, 'localGrantWebUpdate': update}
            stable.verify_local_grant_web_update(app, provenance)
            for field, value in [('baseBackendSha256', 'c' * 64), ('backendSha256', 'c' * 64), ('baselineReproduced', False), ('files', {})]:
                changed = copy.deepcopy(provenance); changed['localGrantWebUpdate'][field] = value
                with self.assertRaises(ValueError): stable.verify_local_grant_web_update(app, changed)
            (app / names[0]).write_bytes(b'changed native code')
            with self.assertRaises(ValueError): stable.verify_local_grant_web_update(app, provenance)

    def test_pay_version_update_requires_link_to_preserved_web_binary(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / 'Yosh.app'
            binary = app / 'Contents/Resources/Runtime/pay-mcp'
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b'new v0-compatible pay')
            update = {'version': 1, 'kind': 'pay-v0-compatibility-v1',
                      'basePayMcpSha256': 'a' * 64, 'payMcpSha256': stable.rc.digest(binary),
                      'evidence': {name: 'b' * 64 for name in [
                          'base-source-manifest.json', 'base-artifact.json', 'dependencies-artifact.json',
                          'build-inputs.json', 'build-steps.json']},
                      'sources': {name: 'c' * 64 for name in [
                          'scripts/build-codex-plugin-dev.py', 'scripts/build-standalone-dependencies.py',
                          'integration/release-candidate/pay-overlay/yosh-controlled-mcp.rs']}}
            provenance = {'localGrantWebUpdate': {'preservedBinaries': {
                'Contents/Resources/Runtime/pay-mcp': 'a' * 64}}, 'payVersionCompatibilityUpdate': update}
            stable.verify_pay_version_compatibility_update(app, provenance)
            for mutate in [
                lambda p: p['payVersionCompatibilityUpdate'].update(basePayMcpSha256='d' * 64),
                lambda p: p['payVersionCompatibilityUpdate'].update(payMcpSha256='d' * 64),
                lambda p: p['payVersionCompatibilityUpdate']['sources'].clear(),
                lambda p: p['payVersionCompatibilityUpdate']['evidence'].pop('base-source-manifest.json'),
            ]:
                changed = copy.deepcopy(provenance); mutate(changed)
                with self.assertRaises(ValueError): stable.verify_pay_version_compatibility_update(app, changed)

    def test_pay_version_artifact_keeps_parent_and_verified_dependency_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            app = output / 'Yosh.app'
            evidence = output / 'pay-version-compatibility'; evidence.mkdir()
            for name in [stable.PAY_BINARY, 'Contents/Resources/Runtime/backend/server.js', 'Contents/MacOS/YoshBackendNode']:
                file = app / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(name.encode())
            base = {'localGrantWebUpdate': {'preservedBinaries': {stable.PAY_BINARY: stable.rc.digest(app / stable.PAY_BINARY)}}}
            manifest = app / stable.SOURCE_MANIFEST
            manifest.write_text(json.dumps(base))
            (evidence / 'base-source-manifest.json').write_bytes(manifest.read_bytes())
            parent = {'sourceManifestSha256': stable.rc.digest(manifest), 'files': stable.rc.tree_files(app)}
            sources = {name: 'c' * 64 for name in stable.PAY_COMPATIBILITY_SOURCES}
            inputs = {'kind': 'standalone-dependencies', 'productionEnabled': False,
                      'yosh': {'files': {name: {'sha256': digest} for name, digest in sources.items()}},
                      'pay': {'revision': stable.rc.HEADS['pay'], 'overlays': {
                          'rust/crates/mcp/src/bin/yosh-controlled-mcp.rs': {'sha256': 'c' * 64}}},
                      'payKit': {'revision': stable.rc.KIT}}
            steps = [{'label': name, 'exitCode': 0} for name in ['pay-mcp', 'sign-pay-mcp']]
            for name, value in [('base-artifact.json', parent), ('build-inputs.json', inputs), ('build-steps.json', steps)]:
                (evidence / name).write_text(json.dumps(value))
            (app / stable.PAY_BINARY).write_bytes(b'new v0-compatible pay')
            artifact = {'kind': 'standalone-dependencies', 'productionEnabled': False,
                        'sourceSha256': stable.rc.digest(evidence / 'build-inputs.json'),
                        'stepsSha256': stable.rc.digest(evidence / 'build-steps.json'),
                        'files': {'pay-mcp': {'sha256': stable.rc.digest(app / stable.PAY_BINARY)}}}
            (evidence / 'dependencies-artifact.json').write_text(json.dumps(artifact))
            update = {'version': 1, 'kind': 'pay-v0-compatibility-v1',
                      'basePayMcpSha256': base['localGrantWebUpdate']['preservedBinaries'][stable.PAY_BINARY],
                      'payMcpSha256': stable.rc.digest(app / stable.PAY_BINARY), 'sources': sources,
                      'evidence': {name: stable.rc.digest(evidence / name) for name in stable.PAY_COMPATIBILITY_EVIDENCE}}
            provenance = {**base, 'payVersionCompatibilityUpdate': update}
            manifest.write_text(json.dumps(provenance))
            stable.verify_pay_version_compatibility_evidence(output, app, provenance)
            original = {name: (evidence / name).read_bytes() for name in stable.PAY_COMPATIBILITY_EVIDENCE}
            mutations = [
                ('base-source-manifest.json', lambda data: data.update(unreviewed=True)),
                ('base-artifact.json', lambda data: data.update(sourceManifestSha256='d' * 64)),
                ('dependencies-artifact.json', lambda data: data['files']['pay-mcp'].update(sha256='d' * 64)),
                ('build-inputs.json', lambda data: data['yosh']['files'][next(iter(sources))].update(sha256='d' * 64)),
                ('build-steps.json', lambda data: data[0].update(exitCode=1)),
            ]
            for name, mutate in mutations:
                changed = copy.deepcopy(provenance)
                data = json.loads(original[name]); mutate(data)
                (evidence / name).write_text(json.dumps(data))
                changed['payVersionCompatibilityUpdate']['evidence'][name] = stable.rc.digest(evidence / name)
                # Recompute the dependency's immediate links too: validation
                # must inspect provenance semantics, not merely a hash mismatch.
                dependency = copy.deepcopy(artifact)
                if name in ['build-inputs.json', 'build-steps.json']:
                    field = 'sourceSha256' if name == 'build-inputs.json' else 'stepsSha256'
                    dependency[field] = stable.rc.digest(evidence / name)
                    (evidence / 'dependencies-artifact.json').write_text(json.dumps(dependency))
                    changed['payVersionCompatibilityUpdate']['evidence']['dependencies-artifact.json'] = stable.rc.digest(evidence / 'dependencies-artifact.json')
                with self.subTest(name=name), self.assertRaises(ValueError):
                    stable.verify_pay_version_compatibility_evidence(output, app, changed)
                for file, content in original.items(): (evidence / file).write_bytes(content)
            (app / 'Contents/Resources/Runtime/backend/server.js').write_bytes(b'unreviewed backend')
            with self.assertRaisesRegex(ValueError, 'unrelated bundle'):
                stable.verify_pay_version_compatibility_evidence(output, app, provenance)

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

    def test_isolated_dev_process_does_not_block_original_app_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary); staged = directory / 'build/Yosh.app'; staged.mkdir(parents=True)
            result = SimpleNamespace(returncode=1, stdout='/Users/test/Applications/Yosh Codex Plugin Dev.app/Contents/MacOS/Yosh\n')
            with mock.patch.object(stable, 'verify_artifact', return_value=staged), mock.patch.object(stable, 'verify_bundle'), \
                    mock.patch.object(stable.subprocess, 'run', return_value=result):
                stable.install(directory / 'build', directory)
            self.assertTrue((directory / 'Yosh.app').is_dir())

    def test_running_candidate_prevents_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with mock.patch.object(stable, 'verify_artifact', return_value=directory / 'staging/Yosh.app'), \
                    mock.patch.object(stable.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='/Users/test/Applications/Yosh.app/Contents/MacOS/Yosh\n')):
                with self.assertRaisesRegex(ValueError, 'Quit Yosh normally'):
                    stable.install(directory, directory)
            self.assertFalse((directory / 'Yosh.app').exists())


if __name__ == '__main__':
    unittest.main()
