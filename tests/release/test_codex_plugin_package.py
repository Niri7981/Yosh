"""Relocatable package contents and private-state rejection, fixture only."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('plugin_packager', ROOT / 'scripts/package-codex-plugin.py')
packager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packager)


class PluginPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.plugin = self.root / 'plugins/yosh-dev'
        (self.plugin / '.codex-plugin').mkdir(parents=True)
        manifest = {'name': 'yosh-dev', 'version': '0.1.0'}
        for path in ['plugin.json', '.codex-plugin/plugin.json']:
            (self.plugin / path).write_text(json.dumps(manifest))
        (self.plugin / 'mcp.json').write_text(json.dumps({'mcpServers': {'yosh': {'type': 'stdio', 'command': 'bash'}}}))
        self.output = self.root / 'build.noindex/package/yosh-dev.zip'
        self.patch = mock.patch.multiple(packager, ROOT=self.root, PLUGIN=self.plugin)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_archive_is_relocatable_deterministic_and_contains_no_parent_files(self):
        (self.root / 'private-config.json').write_text('private parent fixture')
        (self.plugin / 'scripts').mkdir()
        launcher = self.plugin / 'scripts/launch.sh'
        launcher.write_text('#!/bin/bash\nexit 0\n')
        launcher.chmod(0o755)
        packager.package(self.output)
        original = self.output.read_bytes()
        packager.package(self.output)
        self.assertEqual(original, self.output.read_bytes())
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(set(archive.namelist()), {'yosh-dev/plugin.json', 'yosh-dev/.codex-plugin/plugin.json', 'yosh-dev/mcp.json', 'yosh-dev/scripts/launch.sh'})
            self.assertEqual((archive.getinfo('yosh-dev/scripts/launch.sh').external_attr >> 16) & 0o777, 0o755)

    def test_private_files_and_symlink_sources_are_rejected_before_output(self):
        forbidden = self.plugin / '.env.local'
        forbidden.write_text('fixture-secret')
        with self.assertRaisesRegex(ValueError, 'Private or generated state'):
            packager.package(self.output)
        self.assertFalse(self.output.exists())
        forbidden.unlink()
        (self.plugin / 'alias.json').symlink_to(self.plugin / 'plugin.json')
        with self.assertRaisesRegex(ValueError, 'cannot include symlinks'):
            packager.package(self.output)
        self.assertFalse(self.output.exists())

    def test_output_cannot_target_an_installed_or_source_location(self):
        with self.assertRaisesRegex(ValueError, 'build.noindex'):
            packager.package(self.root / 'Applications/yosh-dev.zip')

    def test_codex_config_fields_and_absolute_commands_cannot_silently_drop_mcp(self):
        for server in [{'type': 'stdio', 'command': '/bin/bash'},
                       {'type': 'stdio', 'command': 'bash', 'env_vars': ['YOSH_CODEX_PLUGIN_APP']}]:
            (self.plugin / 'mcp.json').write_text(json.dumps({'mcpServers': {'yosh': server}}))
            with self.subTest(server=server), self.assertRaisesRegex(ValueError, 'portable|Portable'):
                packager.package(self.output)


if __name__ == '__main__':
    unittest.main()
