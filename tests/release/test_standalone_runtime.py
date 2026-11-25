import importlib.util
import json
from pathlib import Path
import shutil
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
standalone_builder = module('standalone_builder_test', 'build-standalone-dev.py')


class StandaloneArtifactTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / 'build.noindex/dependencies'
        self.runtime = self.output / 'runtime'; self.runtime.mkdir(parents=True)
        (self.root / 'scripts').mkdir()
        shutil.copy2(ROOT / 'scripts/connect-dot.py', self.root / 'scripts/connect-dot.py')
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

    def test_mpp_package_is_versioned_and_requires_both_verified_files(self):
        self.local_mainnet_runtime()
        self.manifest['mppProtocol'] = True
        for name in ['mpp-protocol-engine', 'mpp-provenance.json']:
            (self.runtime / name).write_text('isolated fixture ' + name)
            self.manifest['files'][name] = packager.sha(self.runtime / name)
        self.save_manifest()
        icon = self.root / 'plugins/yosh-dev/assets/icon.png'; icon.parent.mkdir(parents=True); icon.write_bytes(b'fixture')
        destination = self.root / 'build.noindex/mpp-package'
        with mock.patch.object(packager, 'ROOT', self.root): packager.package(self.output, destination)
        plugin = destination / 'marketplace/plugins/yosh-local-dev'
        self.assertEqual(json.loads((plugin / 'plugin.json').read_text())['version'], '0.2.7')
        self.assertEqual((plugin / 'runtime/mpp-protocol-engine').read_bytes(), (self.runtime / 'mpp-protocol-engine').read_bytes())
        (self.runtime / 'mpp-protocol-engine').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'integrity mismatch'): packager.verify_runtime(self.output)

    def test_mainnet_mpp_requires_matching_capability_and_verified_subset(self):
        mainnet = self.local_mainnet_runtime()
        self.manifest.update(mppProtocol=True, mainnetMpp=True)
        mainnet['mppProtocol'] = True
        for name in ['mpp-protocol-engine', 'mpp-provenance.json']:
            (self.runtime / name).write_text('fixture ' + name)
            self.manifest['files'][name] = mainnet['files'][name] = packager.sha(self.runtime / name)
        self.save_mainnet(mainnet)
        self.assertEqual(packager.verify_runtime(self.output), self.manifest)
        icon = self.root / 'plugins/yosh-dev/assets/icon.png'; icon.parent.mkdir(parents=True); icon.write_bytes(b'fixture')
        destination = self.root / 'build.noindex/mainnet-mpp-package'
        with mock.patch.object(packager, 'ROOT', self.root): packager.package(self.output, destination)
        plugin = destination / 'marketplace/plugins/yosh-local-dev'
        self.assertEqual(json.loads((plugin / 'plugin.json').read_text())['version'], '0.2.14')
        self.manifest['mppDeliveryRecovery'] = True; self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'delivery recovery'): packager.verify_runtime(self.output)
        mainnet['mppDeliveryRecovery'] = True; self.save_mainnet(mainnet)
        recovery_package = self.root / 'build.noindex/mainnet-mpp-recovery'
        with mock.patch.object(packager, 'ROOT', self.root): packager.package(self.output, recovery_package)
        metadata = recovery_package / 'marketplace/plugins/yosh-local-dev/plugin.json'
        self.assertEqual(json.loads(metadata.read_text())['version'], '0.2.21')
        self.manifest['mainnetMpp'] = False; self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'capability mismatch'): packager.verify_runtime(self.output)
        self.manifest['mainnetMpp'] = True
        del mainnet['files']['mpp-provenance.json']; self.save_mainnet(mainnet)
        with self.assertRaisesRegex(ValueError, 'contract mismatch'): packager.verify_runtime(self.output)

    def test_shared_daily_limit_editing_requires_matching_mainnet_capability_and_helper(self):
        mainnet = self.local_mainnet_runtime()
        self.manifest['mainnetDailyLimit'] = True
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'daily limit'):
            packager.verify_runtime(self.output)
        mainnet['mainnetDailyLimit'] = True
        self.save_mainnet(mainnet)
        with self.assertRaisesRegex(ValueError, 'confirmation helper'):
            packager.verify_runtime(self.output)
        mainnet['files']['yosh-confirm'] = self.manifest['files']['yosh-confirm']
        self.save_mainnet(mainnet)
        icon = self.root / 'plugins/yosh-dev/assets/icon.png'
        icon.parent.mkdir(parents=True)
        icon.write_bytes(b'fixture')
        destination = self.root / 'build.noindex/shared-daily-limit-package'
        with mock.patch.object(packager, 'ROOT', self.root):
            packager.package(self.output, destination)
        plugin = destination / 'marketplace/plugins/yosh-local-dev'
        self.assertEqual(json.loads((plugin / 'plugin.json').read_text())['version'], '0.2.22')

    def test_original_merchant_delivery_requires_matching_mainnet_and_advances_version(self):
        mainnet = self.local_mainnet_runtime()
        self.manifest['originalMerchantDelivery'] = True
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Original merchant delivery'):
            packager.verify_runtime(self.output)
        mainnet['originalMerchantDelivery'] = True
        self.save_mainnet(mainnet)
        icon = self.root / 'plugins/yosh-dev/assets/icon.png'
        icon.parent.mkdir(parents=True)
        icon.write_bytes(b'fixture')
        destination = self.root / 'build.noindex/original-delivery-package'
        with mock.patch.object(packager, 'ROOT', self.root):
            packager.package(self.output, destination)
        plugin = destination / 'marketplace/plugins/yosh-local-dev'
        self.assertEqual(json.loads((plugin / 'plugin.json').read_text())['version'], '0.2.23')

    def test_mpp_builder_rejects_unrecorded_executable_without_shipping_private_inventory(self):
        artifact = self.root / 'protocol'; artifact.mkdir()
        binary = artifact / 'yosh-execution-protocol'; binary.write_text('fixture-binary')
        record = {'kind': 'mpp-protocol-only', 'schemaVersion': 1, 'networkDenied': True,
                  'paymentSent': False, 'signerUsed': False,
                  'payRevision': '402f67c44dd8d41d7d1584fcb5d868006ce8c891',
                  'payKitRevision': '7f1369180ca4b047aadff1bea77aed4525e10039',
                  'binarySha256': packager.sha(binary),
                  'wrapperSha256': packager.sha(ROOT / 'integration/pay-protocol-engine/main.rs'),
                  'builderSha256': packager.sha(ROOT / 'scripts/build-mpp-protocol-engine.py'),
                  'commands': ['/private/workstation/path'], 'sourceFiles': {'private-path': 'fixture'}}
        (artifact / 'source-lock.json').write_text(json.dumps(record))
        standalone_builder.copy_mpp_protocol(artifact, self.runtime)
        public = json.loads((self.runtime / 'mpp-provenance.json').read_text())
        self.assertNotIn('commands', public); self.assertNotIn('sourceFiles', public)
        binary.write_text('changed')
        with self.assertRaisesRegex(ValueError, 'provenance mismatch'):
            standalone_builder.copy_mpp_protocol(artifact, self.runtime)

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

    def test_first_use_installer_requires_verified_owner_helper_and_client(self):
        mainnet = self.local_mainnet_runtime()
        self.manifest['firstUsePairing'] = True
        for name in ['first-use-mcp.cjs', 'register-local-agents.mjs']:
            (self.runtime / name).write_text('isolated client fixture')
            self.manifest['files'][name] = packager.sha(self.runtime / name)
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'confirmation helper'):
            packager.verify_runtime(self.output)
        mainnet['files']['yosh-confirm'] = self.manifest['files']['yosh-confirm']
        self.save_mainnet(mainnet)
        icon = self.root / 'plugins/yosh-dev/assets/icon.png'; icon.parent.mkdir(parents=True); icon.write_bytes(b'fixture')
        destination = self.root / 'build.noindex/pairing-package'
        with mock.patch.object(packager, 'ROOT', self.root): packager.package(self.output, destination)
        install = destination / 'marketplace/Install.command'
        self.assertTrue(install.stat().st_mode & 0o100)
        self.assertIn('install-agents', install.read_text())
        plugin = destination / 'marketplace/plugins/yosh-local-dev'
        self.assertEqual(json.loads((plugin / 'plugin.json').read_text())['version'], '0.2.15')
        with zipfile.ZipFile(destination / 'yosh-local-dev.zip') as archive:
            self.assertIn('yosh-standalone-marketplace/Install.command', archive.namelist())
        self.manifest['firstUsePurchases'] = True
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'retained backend'):
            packager.verify_runtime(self.output)
        mainnet['firstUsePurchases'] = True
        self.save_mainnet(mainnet)
        purchase_build = self.root / 'build.noindex/purchase-package'
        with mock.patch.object(packager, 'ROOT', self.root): packager.package(self.output, purchase_build)
        metadata = purchase_build / 'marketplace/plugins/yosh-local-dev/plugin.json'
        self.assertEqual(json.loads(metadata.read_text())['version'], '0.2.16')
        self.assertIn('--upgrade-legacy-clients', (purchase_build / 'marketplace/Install.command').read_text())
        self.manifest['purchaseResourceLookup'] = True
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'resource lookup'):
            packager.verify_runtime(self.output)
        mainnet['purchaseResourceLookup'] = True
        self.save_mainnet(mainnet)
        describe_build = self.root / 'build.noindex/resource-lookup-package'
        with mock.patch.object(packager, 'ROOT', self.root): packager.package(self.output, describe_build)
        describe_plugin = describe_build / 'marketplace/plugins/yosh-local-dev'
        self.assertEqual(json.loads((describe_plugin / 'plugin.json').read_text())['version'], '0.2.17')
        self.assertIn('describe_purchase_resource', (describe_plugin / 'skills/connect-local-yosh/SKILL.md').read_text())
        self.manifest['hostPurchaseAmountLimit'] = True
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'price limits'):
            packager.verify_runtime(self.output)
        mainnet['hostPurchaseAmountLimit'] = True
        self.save_mainnet(mainnet)
        limit_build = self.root / 'build.noindex/purchase-limit-package'
        with mock.patch.object(packager, 'ROOT', self.root): packager.package(self.output, limit_build)
        metadata = limit_build / 'marketplace/plugins/yosh-local-dev/plugin.json'
        self.assertEqual(json.loads(metadata.read_text())['version'], '0.2.18')
        self.manifest['remoteStatements'] = True
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Remote statement'):
            packager.verify_runtime(self.output)
        mainnet['remoteStatements'] = True
        self.save_mainnet(mainnet)
        statement_build = self.root / 'build.noindex/remote-statement-package'
        with mock.patch.object(packager, 'ROOT', self.root): packager.package(self.output, statement_build)
        metadata = statement_build / 'marketplace/plugins/yosh-local-dev/plugin.json'
        self.assertEqual(json.loads(metadata.read_text())['version'], '0.2.20')
        connector = statement_build / 'marketplace/Connect-Dot.command'
        self.assertTrue(connector.stat().st_mode & 0o100)
        self.assertFalse((limit_build / 'marketplace/Connect-Dot.command').exists())
        with zipfile.ZipFile(statement_build / 'yosh-local-dev.zip') as archive:
            self.assertEqual(archive.read('yosh-standalone-marketplace/Connect-Dot.command'), connector.read_bytes())
            self.assertEqual(archive.read('yosh-standalone-marketplace/plugins/yosh-local-dev/scripts/connect-dot.py'),
                             (ROOT / 'scripts/connect-dot.py').read_bytes())
        self.manifest['firstUsePurchases'] = False
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'resource lookup'):
            packager.verify_runtime(self.output)
        self.manifest['firstUsePurchases'] = True
        self.save_manifest()
        (self.runtime / 'first-use-mcp.cjs').write_text('wrong client bytes')
        with self.assertRaisesRegex(ValueError, 'integrity'):
            packager.verify_runtime(self.output)

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
