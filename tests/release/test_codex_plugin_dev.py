"""Input/provenance rejection paths for the independently identified Dev build."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('plugin_dev_builder', ROOT / 'scripts/build-codex-plugin-dev.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class CodexPluginDevBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.checkout = self.root / 'yosh'
        self.checkout.mkdir()
        self.pay = self.root / 'pay'
        self.pay.mkdir()
        subprocess.run(['git', 'init', '-q', self.pay], check=True)
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'commit.gpgsign', 'false')
        (self.pay / 'rust').mkdir()
        (self.pay / 'rust/Cargo.toml').write_text('rev = "' + builder.KIT + '"\n')
        (self.pay / 'rust/Cargo.lock').write_text('locked fixture\n')
        controlled = self.pay / 'rust/crates/mcp/src/controlled.rs'
        controlled.parent.mkdir(parents=True)
        controlled.write_text('''prepare_unsigned_payment(
                    &payer,
                    &rpc,
                    &requirements,
                    None,
                )''')
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture upstream')
        self.revision = self.git('rev-parse', 'HEAD').decode().strip()
        for destination, source in builder.OVERLAYS.items():
            target = self.checkout / source
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('current repository overlay: ' + source)
            cached = self.pay / destination
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_text('old cached overlay')
        protocol = self.checkout / 'integration/pay-protocol-engine/main.rs'
        protocol.parent.mkdir(parents=True)
        protocol.write_text('fixture protocol source')
        self.archive = self.root / 'node.tar.xz'
        with tarfile.open(self.archive, 'w:xz') as archive:
            member = tarfile.TarInfo('node-v' + builder.NODE_VERSION + '-darwin-arm64/LICENSE')
            data = b'fixture runtime license'
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        self.args = SimpleNamespace(pay=self.pay, output=self.checkout / 'build.noindex/dev', node_archive=self.archive)
        self.record = {'schemaVersion': 1, 'cargo': {'vendor': str(self.root / 'vendor')}}
        self.patch = mock.patch.multiple(builder, ROOT=self.checkout, PAY=self.revision)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.pay)

    def test_only_pinned_clean_upstream_is_accepted(self):
        builder.check_pay(self.pay)
        with mock.patch.object(builder, 'PAY', '0' * 40), self.assertRaisesRegex(ValueError, 'pinned revision'):
            builder.check_pay(self.pay)
        (self.pay / 'rust/Cargo.lock').write_text('changed lock')
        with self.assertRaisesRegex(ValueError, 'tracked source must be clean'):
            builder.check_pay(self.pay)

    def test_unexpected_local_pay_source_is_rejected(self):
        (self.pay / 'unreviewed.rs').write_text('unreviewed source')
        with self.assertRaisesRegex(ValueError, 'Unexpected Pay source'):
            builder.check_pay(self.pay)

    def test_preparation_replaces_cached_overlays_from_current_repository_only(self):
        builder.prepare(self.args, copy.deepcopy(self.record))
        for destination, source in builder.OVERLAYS.items():
            self.assertEqual((self.args.output / 'pay-source' / destination).read_bytes(),
                             (self.checkout / source).read_bytes())
            self.assertEqual((self.pay / destination).read_text(), 'old cached overlay')
        self.assertFalse((self.args.output / 'pay-source/.git').exists())
        self.assertEqual(builder.check_prepared(self.args, self.record)['schemaVersion'], 1)

    def test_preparation_limits_only_the_yosh_custody_builder_to_v0(self):
        original = (self.pay / 'rust/crates/mcp/src/controlled.rs').read_bytes()
        builder.prepare(self.args, copy.deepcopy(self.record))
        for source in ['pay-source/rust', 'protocol-source/rust']:
            prepared = (self.args.output / source / 'crates/mcp/src/controlled.rs').read_text()
            self.assertIn('Some(pay_kit::core::tx::TxVersion::V0)', prepared)
            self.assertNotIn('                    None,', prepared)
        self.assertEqual((self.pay / 'rust/crates/mcp/src/controlled.rs').read_bytes(), original)

    def test_custody_patch_rejects_missing_or_ambiguous_upstream_call(self):
        source = self.pay / 'rust/crates/mcp/src/controlled.rs'
        original = source.read_text()
        for changed in ['unexpected upstream source', original + original]:
            source.write_text(changed)
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, 'custody builder call changed'):
                builder.limit_yosh_custody_version(self.pay)

    def test_tampered_prepared_source_or_runtime_is_rejected(self):
        builder.prepare(self.args, copy.deepcopy(self.record))
        for target in [self.args.output / 'pay-source/rust/Cargo.lock',
                       self.args.output / ('node-runtime/node-v' + builder.NODE_VERSION + '-darwin-arm64/LICENSE')]:
            original = target.read_bytes()
            target.write_bytes(original + b'tamper')
            with self.assertRaisesRegex(ValueError, 'Prepared source or runtime changed'):
                builder.check_prepared(self.args, self.record)
            target.write_bytes(original)
        changed = copy.deepcopy(self.record)
        changed['schemaVersion'] = 2
        with self.assertRaisesRegex(ValueError, 'inputs changed'):
            builder.check_prepared(self.args, changed)

    def test_existing_output_and_escape_paths_preserve_existing_data(self):
        self.args.output.mkdir(parents=True)
        marker = self.args.output / 'original'
        marker.write_text('existing artifact')
        with self.assertRaisesRegex(ValueError, 'existing artifacts are preserved'):
            builder.prepare(self.args, copy.deepcopy(self.record))
        self.assertEqual(marker.read_text(), 'existing artifact')
        for path in [self.root, self.checkout / 'build.noindex', self.checkout / 'build.noindex/../../outside']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                builder.safe_output(path)
        link = self.checkout / 'build.noindex/link'
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            builder.safe_output(link / 'another-output')

    def test_archive_cannot_escape_its_destination(self):
        for name, target in [('../escape', None), ('safe-link', '/tmp/outside-fixture')]:
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w') as archive:
                member = tarfile.TarInfo(name)
                if target:
                    member.type = tarfile.SYMTYPE
                    member.linkname = target
                archive.addfile(member)
            destination = self.root / 'extract'
            destination.mkdir(exist_ok=True)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'Unsafe archive'):
                builder.extract(buffer.getvalue(), destination)

    def test_npm_lock_mismatch_is_rejected_before_build(self):
        modules = self.checkout / 'node_modules/example'
        modules.mkdir(parents=True)
        (modules / 'package.json').write_text(json.dumps({'version': '1.0.0'}))
        installed = {'packages': {'node_modules/example': {'version': '1.0.0', 'integrity': 'expected'}}}
        (self.checkout / 'node_modules/.package-lock.json').write_text(json.dumps(installed))
        expected = copy.deepcopy(installed)
        expected['packages']['node_modules/example']['integrity'] = 'different'
        (self.checkout / 'package-lock.json').write_text(json.dumps(expected))
        with self.assertRaisesRegex(ValueError, 'differs from package-lock'):
            builder.npm_inventory(self.checkout)

    def test_vendor_must_match_the_selected_pay_kit_source(self):
        kit = self.root / 'kit/rust/crates/kit/src'
        vendor = self.root / 'vendor/solana-pay-kit/src'
        for path in [kit, vendor]:
            path.mkdir(parents=True)
            (path / 'lib.rs').write_text('pinned source')
        builder.verify_kit_vendor(self.root / 'kit', self.root / 'vendor')
        (vendor / 'lib.rs').write_text('mismatched cached source')
        with self.assertRaisesRegex(ValueError, 'differs from the pinned checkout'):
            builder.verify_kit_vendor(self.root / 'kit', self.root / 'vendor')


if __name__ == '__main__':
    unittest.main()
