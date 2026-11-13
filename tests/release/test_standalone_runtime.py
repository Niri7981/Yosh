import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


dependencies = module('standalone_dependency_test', 'build-standalone-dependencies.py')
packager = module('standalone_package_test', 'package-standalone-plugin.py')


class StandaloneArtifactTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / 'build.noindex/dependencies'
        self.runtime = self.output / 'runtime'; self.runtime.mkdir(parents=True)
        for name in ['node', 'standalone.cjs', 'mcp.cjs', 'pay-mcp', 'pay-protocol-engine', 'offline.sb']:
            (self.runtime / name).write_text('fixture-' + name)
        (self.runtime / 'licenses').mkdir()
        for name in ['Node-LICENSE', 'Pay-LICENSE', 'pay-kit-LICENSE']: (self.runtime / 'licenses' / name).write_text('license')
        (self.output / 'yosh-dev').write_text('fixture launcher')
        self.manifest = {'kind': 'yosh-standalone-offline-dev', 'productionEnabled': False, 'apiVersion': 1,
                         'dataContract': 'standalone-offline-v1', 'files': {p.name: packager.sha(p) for p in self.runtime.iterdir() if p.is_file()}}
        self.save_manifest()

    def save_manifest(self): (self.runtime / 'manifest.json').write_text(json.dumps(self.manifest))

    def local_mainnet_runtime(self):
        self.manifest.update(kind='yosh-local-devnet', apiVersion=2, dataContract='local-devnet-v1',
                             mainnetBridge=False, mainnetStandalone=True)
        for name in ['local-mcp.cjs', 'yosh-confirm', 'spirit-design-sheet.png', 'instrument-serif.woff2',
                     'Instrument-Serif-OFL.txt', 'mainnet.cjs', 'mainnet-mcp.cjs', 'mainnet.sb']:
            (self.runtime / name).write_text('test fixture ' + name)
            self.manifest['files'][name] = packager.sha(self.runtime / name)
        mainnet = {'kind': 'yosh-mainnet-standalone', 'apiVersion': 1, 'dataContract': 'existing-mainnet-v1',
                   'profile': 'com.yosh.pay-development.v011rc5', 'productionEnabled': False,
                   'files': {name: packager.sha(self.runtime / name) for name in
                             ['node', 'mainnet.cjs', 'mainnet-mcp.cjs', 'pay-mcp', 'pay-protocol-engine', 'mainnet.sb']},
                   'licenses': {name: packager.sha(self.runtime / 'licenses' / name) for name in
                                ['Node-LICENSE', 'Pay-LICENSE', 'pay-kit-LICENSE']}}
        (self.runtime / 'mainnet-manifest.json').write_text(json.dumps(mainnet))
        self.manifest['files']['mainnet-manifest.json'] = packager.sha(self.runtime / 'mainnet-manifest.json')
        self.save_manifest()
        return mainnet

    def save_mainnet(self, manifest):
        (self.runtime / 'mainnet-manifest.json').write_text(json.dumps(manifest))
        self.manifest['files']['mainnet-manifest.json'] = packager.sha(self.runtime / 'mainnet-manifest.json')
        self.save_manifest()

    def dependency_artifact(self):
        (self.output / 'build-inputs.json').write_text('{"locked":true}')
        (self.output / 'build-steps.json').write_text('[]')
        record = {'kind': 'standalone-dependencies', 'productionEnabled': False,
            'sourceSha256': dependencies.builder.digest(self.output / 'build-inputs.json'),
            'stepsSha256': dependencies.builder.digest(self.output / 'build-steps.json'),
            'files': dependencies.builder.inventory(self.runtime)}
        (self.output / 'dependencies-artifact.json').write_text(json.dumps(record))

    def test_verifies_recorded_dependency_bytes_then_rejects_a_changed_binary(self):
        self.dependency_artifact()
        with mock.patch.object(dependencies.builder, 'ROOT', self.root), mock.patch.object(dependencies.subprocess, 'run') as sign:
            self.assertEqual(dependencies.verify(self.output), self.runtime)
            self.assertEqual(sign.call_count, 3)
            (self.runtime / 'pay-mcp').write_text('unrecorded cache')
            with self.assertRaisesRegex(ValueError, 'artifact changed'): dependencies.verify(self.output)

    def test_changed_source_record_is_not_accepted_as_the_same_build(self):
        self.dependency_artifact()
        (self.output / 'build-inputs.json').write_text('{"locked":false}')
        with mock.patch.object(dependencies.builder, 'ROOT', self.root):
            with self.assertRaisesRegex(ValueError, 'artifact changed'): dependencies.verify(self.output)

    def test_rejects_extra_files_that_could_leak_private_data(self):
        self.manifest['files']['.env.local'] = '0' * 64; self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Unexpected runtime file'): packager.verify_runtime(self.output)

    def test_rejects_external_symlink_disguised_as_license(self):
        secret = self.root / 'private-test-fixture'; secret.write_text('must not ship')
        path = self.runtime / 'licenses/Node-LICENSE'; path.unlink(); path.symlink_to(secret)
        with self.assertRaisesRegex(ValueError, 'License path rejected'): packager.verify_runtime(self.output)

    def test_rejects_unsupported_interface_version(self):
        self.manifest['apiVersion'] = 2; self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Offline package required'): packager.verify_runtime(self.output)

    def test_rejects_changed_mcp_and_accepts_original(self):
        self.assertEqual(packager.verify_runtime(self.output), self.manifest)
        (self.runtime / 'mcp.cjs').write_text('modified adapter')
        with self.assertRaisesRegex(ValueError, 'integrity mismatch'): packager.verify_runtime(self.output)

    def test_local_package_identity_and_catalog_match_directory_not_copied_license(self):
        self.manifest.update(kind='yosh-local-devnet', apiVersion=2, dataContract='local-devnet-v1')
        for name in ['local-mcp.cjs', 'yosh-confirm', 'spirit-design-sheet.png', 'instrument-serif.woff2', 'Instrument-Serif-OFL.txt']:
            (self.runtime / name).write_text('test fixture ' + name)
            self.manifest['files'][name] = packager.sha(self.runtime / name)
        self.save_manifest()
        icon = self.root / 'plugins/yosh-dev/assets/icon.png'; icon.parent.mkdir(parents=True); icon.write_bytes(b'fixture')
        destination = self.root / 'build.noindex/local-package'
        with mock.patch.object(packager, 'ROOT', self.root): packager.package(self.output, destination)
        plugin = destination / 'marketplace/plugins/yosh-local-dev'
        self.assertEqual(json.loads((plugin / 'plugin.json').read_text())['name'], 'yosh-local-dev')
        catalog = json.loads((destination / 'marketplace/.agents/plugins/marketplace.json').read_text())
        self.assertEqual(catalog['plugins'][0]['source']['path'], './plugins/yosh-local-dev')
        self.assertTrue((destination / 'yosh-local-dev.zip').is_file())
        self.assertFalse(any('state/' in name for name in json.loads((destination / 'package-evidence.json').read_text())['files']))
        self.manifest['files']['wallet.json'] = '0' * 64; self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Unexpected runtime file'): packager.verify_runtime(self.output)

    def test_mainnet_package_contains_its_own_runtime_and_preserves_plugin_identity(self):
        self.local_mainnet_runtime()
        icon = self.root / 'plugins/yosh-dev/assets/icon.png'; icon.parent.mkdir(parents=True); icon.write_bytes(b'fixture')
        destination = self.root / 'build.noindex/mainnet-package'
        with mock.patch.object(packager, 'ROOT', self.root): packager.package(self.output, destination)
        plugin = destination / 'marketplace/plugins/yosh-local-dev'
        for name in ['plugin.json', '.codex-plugin/plugin.json']:
            metadata = json.loads((plugin / name).read_text())
            self.assertEqual((metadata['name'], metadata['version']), ('yosh-local-dev', '0.2.4'))
        evidence = json.loads((destination / 'package-evidence.json').read_text())
        self.assertIs(evidence['requiresApp'], False)
        self.assertTrue(evidence['realFunds'])
        with zipfile.ZipFile(destination / 'yosh-local-dev.zip') as archive:
            names = archive.namelist()
            self.assertTrue(any(name.endswith('/runtime/mainnet.cjs') for name in names))
            self.assertTrue(any(name.endswith('/runtime/mainnet-mcp.cjs') for name in names))
            self.assertFalse(any('mainnet-launch.' in name or '.app/' in name for name in names))

    def test_mainnet_manifest_cannot_omit_or_redirect_a_shared_dependency(self):
        for problem in ['missing binary', 'wrong profile', 'license outside runtime', 'App bridge']:
            with self.subTest(problem=problem):
                manifest = self.local_mainnet_runtime()
                if problem == 'missing binary': del manifest['files']['pay-mcp']
                elif problem == 'wrong profile': manifest['profile'] = 'com.yosh.local-authorization-dev'
                elif problem == 'license outside runtime': manifest['licenses']['../private-config'] = '0' * 64
                else: self.manifest['mainnetBridge'] = True
                self.save_mainnet(manifest)
                with self.assertRaisesRegex(ValueError, 'Mainnet runtime'):
                    packager.verify_runtime(self.output)

    def test_mainnet_manifest_authenticates_shared_binary_and_license_bytes(self):
        manifest = self.local_mainnet_runtime()
        manifest['files']['pay-mcp'] = '0' * 64
        self.save_mainnet(manifest)
        with self.assertRaisesRegex(ValueError, 'Mainnet runtime'):
            packager.verify_runtime(self.output)
        self.local_mainnet_runtime()
        (self.runtime / 'licenses/Node-LICENSE').write_text('changed dependency license')
        with self.assertRaisesRegex(ValueError, 'Mainnet runtime'):
            packager.verify_runtime(self.output)


if __name__ == '__main__': unittest.main()
