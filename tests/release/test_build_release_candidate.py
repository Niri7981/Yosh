"""Source and artifact identity checks; no build, app or product state is used."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tarfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/build-release-candidate.py'
SPEC = importlib.util.spec_from_file_location('build_release_candidate', SCRIPT)
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class SourceRecordTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='yosh-release-source-test-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.root = self.directory / 'source'
        self.root.mkdir()
        self.lock = self.root / 'integration/release-candidate/source-lock.json'
        # Do not load the developer's Git configuration, signing hooks or HOME.
        environment = {
            'PATH': os.defpath,
            'HOME': str(self.directory),
            'XDG_CONFIG_HOME': str(self.directory / 'config'),
            'GIT_CONFIG_NOSYSTEM': '1',
            'GIT_CONFIG_GLOBAL': os.devnull,
            'LC_ALL': 'C',
        }
        self.environment_patch = mock.patch.dict(os.environ, environment, clear=True)
        self.environment_patch.start()
        self.addCleanup(self.environment_patch.stop)
        self.root_patch = mock.patch.object(builder, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.lock_patch = mock.patch.object(builder, 'LOCK', self.lock)
        self.lock_patch.start()
        self.addCleanup(self.lock_patch.stop)
        self.git('init', '--quiet')
        self.write('.gitignore', 'ignored-output/\n')
        self.write('src/main.txt', 'reviewed source\n')
        self.git('add', '.')
        self.git('-c', 'user.name=Release Fixture',
                 '-c', 'user.email=release-fixture@example.invalid',
                 '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
                 'commit', '--quiet', '-m', 'Temporary source fixture')

    def git(self, *arguments):
        return subprocess.check_output(
            ['git', *arguments], cwd=self.root, stderr=subprocess.STDOUT)

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def test_untracked_source_is_bound_but_ignored_output_and_lock_are_not(self):
        reviewed = builder.source_record(self.root)
        self.write('integration/new-adapter.txt', 'candidate overlay\n')
        self.write('ignored-output/binary', 'ignored build fixture\n')
        self.write(str(self.lock.relative_to(self.root)), '{}\n')

        candidate = builder.source_record(self.root)

        self.assertEqual(set(candidate['files']),
                         {'.gitignore', 'src/main.txt', 'integration/new-adapter.txt'})
        self.assertTrue(candidate['dirty'])
        self.assertEqual(candidate['head'], reviewed['head'])
        self.assertNotEqual(candidate['filesSha256'], reviewed['filesSha256'])
        self.assertEqual(candidate['trackedOverlaySha256'],
                         reviewed['trackedOverlaySha256'])

    def test_tracked_overlay_changes_fingerprint_without_changing_head(self):
        reviewed = builder.source_record(self.root)
        self.assertFalse(reviewed['dirty'])
        self.write('src/main.txt', 'release correction\n')
        unstaged = builder.source_record(self.root)

        self.assertTrue(unstaged['dirty'])
        self.assertEqual(unstaged['head'], reviewed['head'])
        self.assertNotEqual(unstaged['trackedOverlaySha256'],
                            reviewed['trackedOverlaySha256'])
        self.assertNotEqual(unstaged['filesSha256'], reviewed['filesSha256'])
        self.assertNotEqual(unstaged['files']['src/main.txt'],
                            reviewed['files']['src/main.txt'])

        self.git('add', 'src/main.txt')
        staged = builder.source_record(self.root)
        self.assertEqual(staged['trackedOverlaySha256'],
                         unstaged['trackedOverlaySha256'])
        self.assertEqual(staged['filesSha256'], unstaged['filesSha256'])

    def test_root_and_nested_environment_examples_are_source_inputs(self):
        self.write('.env.example', 'EXAMPLE=fixture\n')
        self.write('examples/nested/.env.example', 'EXAMPLE=nested-fixture\n')

        record = builder.source_record(self.root)

        self.assertIn('.env.example', record['files'])
        self.assertIn('examples/nested/.env.example', record['files'])

    def test_actual_environment_files_are_rejected_at_any_depth(self):
        for relative in ['.env', '.env.local', 'examples/.env',
                         'examples/nested/.env.test']:
            with self.subTest(relative=relative):
                path = self.write(relative, 'DUMMY_TEST_VALUE=fixture-only\n')
                try:
                    with self.assertRaisesRegex(ValueError, 'Environment files'):
                        builder.source_record(self.root)
                finally:
                    path.unlink()

    def test_external_symlink_is_rejected_without_reading_its_target(self):
        external = self.directory / 'outside.txt'
        external.write_text('outside fixture, never a source input\n')
        alias = self.root / 'external-link.txt'
        original_digest = builder.digest

        def guarded_digest(path):
            self.assertNotEqual(Path(path).resolve(), external)
            return original_digest(path)

        for target in [str(external), '../outside.txt']:
            with self.subTest(target=target):
                alias.symlink_to(target)
                try:
                    with mock.patch.object(builder, 'digest', side_effect=guarded_digest):
                        with self.assertRaisesRegex(ValueError, 'External source symlink'):
                            builder.source_record(self.root)
                finally:
                    alias.unlink()

    def test_internal_symlink_identity_uses_link_text_and_detects_retargeting(self):
        self.write('src/alternate.txt', 'alternate source\n')
        alias = self.root / 'source-alias.txt'
        alias.symlink_to('src/main.txt')
        original = builder.source_record(self.root)
        self.assertEqual(original['files']['source-alias.txt'],
                         hashlib.sha256(b'src/main.txt').hexdigest())

        alias.unlink()
        alias.symlink_to('src/alternate.txt')
        changed = builder.source_record(self.root)

        self.assertNotEqual(changed['files']['source-alias.txt'],
                            original['files']['source-alias.txt'])
        self.assertNotEqual(changed['filesSha256'], original['filesSha256'])

    def test_final_identity_survives_staging_and_commit_but_rejects_source_changes(self):
        base = self.git('rev-parse', 'HEAD').decode().strip()
        self.write('src/new.txt', 'reviewed final source\n')
        final = builder.final_source_record(self.root, base)
        self.git('add', '.')
        self.assertEqual(builder.final_source_record(self.root, base), final)
        self.git('-c', 'user.name=Release Fixture', '-c', 'user.email=release-fixture@example.invalid',
                 '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
                 'commit', '--quiet', '-m', 'Archive fixture')
        self.assertEqual(builder.final_source_record(self.root, base), final)
        self.write('src/new.txt', 'unreviewed mutation\n')
        self.assertNotEqual(builder.final_source_record(self.root, base), final)

    def test_build_provenance_uses_final_inventory_and_fixed_ancestor(self):
        base = self.git('rev-parse', 'HEAD').decode().strip()
        source = builder.final_source_record(self.root, base)
        self.assertEqual(builder.source_provenance({'yosh': source}), {
            'yosh': {'baseCommit': base, 'filesSha256': source['filesSha256'],
                     'modesSha256': hashlib.sha256(builder.canonical(source['modes'])).hexdigest()}})

    def test_final_identity_and_archive_bind_executable_modes(self):
        base = self.git('rev-parse', 'HEAD').decode().strip()
        original = builder.final_source_record(self.root, base)
        script = self.root / 'src/main.txt'
        script.chmod(0o755)
        changed = builder.final_source_record(self.root, base)
        self.assertEqual(original['files'], changed['files'])
        self.assertNotEqual(original['modes'], changed['modes'])
        archive = self.directory / 'mode.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            output.add(script, arcname='yosh/src/main.txt')
        expected = {'src/main.txt': original['files']['src/main.txt']}
        with self.assertRaisesRegex(ValueError, 'mode differs'):
            builder.verify_source_archive(archive, 'yosh', expected, original['modes'])
        builder.verify_source_archive(archive, 'yosh', expected, changed['modes'])

    def test_final_verifier_rejects_added_modified_deleted_and_historical_sources(self):
        baseline = self.write('baseline.json', '{}\n')
        historical = self.write('historical.json', '{"frozen":true}\n')
        base = self.git('rev-parse', 'HEAD').decode().strip()
        source = builder.final_source_record(self.root, base)
        manifest = {'schemaVersion': 3, 'recordKind': 'final-rc5-source',
                    'historicalSourceLockSha256': builder.digest(historical),
                    'reviewedBaselineSha256': builder.digest(baseline), 'payKitRevision': builder.KIT,
                    'isolation': builder.ISOLATION, 'differencesSinceRc4': [],
                    'sources': {'yosh': source, 'pay': source}}
        self.write(str(self.lock.relative_to(self.root)), json.dumps(manifest))
        with mock.patch.multiple(builder, HISTORICAL_LOCK=historical, BASELINE=baseline,
                                 HEADS={'yosh': base, 'pay': base}), \
                mock.patch.object(builder, 'verify_pay_contract'), \
                mock.patch.object(builder, 'check_version'), \
                mock.patch.object(builder, 'predecessor_differences', return_value=[]):
            self.assertEqual(builder.verify_sources(self.root), manifest)
            extra = self.write('src/unreviewed.txt', 'extra\n')
            with self.assertRaisesRegex(ValueError, 'changed after source freeze'):
                builder.verify_sources(self.root)
            extra.unlink()
            original = (self.root / 'src/main.txt').read_bytes()
            self.write('src/main.txt', 'changed\n')
            with self.assertRaisesRegex(ValueError, 'changed after source freeze'):
                builder.verify_sources(self.root)
            (self.root / 'src/main.txt').unlink()
            with self.assertRaises(ValueError):
                builder.verify_sources(self.root)
            (self.root / 'src/main.txt').write_bytes(original)
            historical.write_text('changed historical evidence\n')
            with self.assertRaisesRegex(ValueError, 'Historical rc.5 freeze changed'):
                builder.verify_sources(self.root)

    def test_source_archive_rejects_extra_missing_and_changed_members(self):
        archive = self.directory / 'source.tar.gz'
        expected = {'src/main.txt': builder.digest(self.root / 'src/main.txt')}
        def write_archive(names):
            with tarfile.open(archive, 'w:gz') as output:
                for name in names:
                    output.add(self.root / name, arcname='yosh/' + name)
        write_archive(['src/main.txt'])
        builder.verify_source_archive(archive, 'yosh', expected)
        write_archive(['src/main.txt', '.gitignore'])
        with self.assertRaises(ValueError):
            builder.verify_source_archive(archive, 'yosh', expected)
        write_archive([])
        with self.assertRaises(ValueError):
            builder.verify_source_archive(archive, 'yosh', expected)
        self.write('src/main.txt', 'archive mutation\n')
        write_archive(['src/main.txt'])
        with self.assertRaises(ValueError):
            builder.verify_source_archive(archive, 'yosh', expected)


class TreeFilesTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='yosh-release-artifact-test-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.root = self.directory / 'Candidate.app'
        self.root.mkdir()

    def test_regular_file_content_and_executable_mode_are_bound(self):
        executable = self.root / 'Contents/MacOS/Fixture'
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b'first build fixture\n')
        executable.chmod(0o644)
        original = builder.tree_files(self.root)
        relative = 'Contents/MacOS/Fixture'
        self.assertEqual(set(original), {relative})
        self.assertEqual(original[relative], {
            'sha256': hashlib.sha256(b'first build fixture\n').hexdigest(),
            'mode': '0o644',
        })

        executable.write_bytes(b'changed build fixture\n')
        changed = builder.tree_files(self.root)
        self.assertNotEqual(changed[relative]['sha256'], original[relative]['sha256'])
        executable.chmod(0o755)
        executable_mode = builder.tree_files(self.root)
        self.assertEqual(executable_mode[relative]['mode'], '0o755')
        self.assertEqual(executable_mode[relative]['sha256'], changed[relative]['sha256'])

    def test_symlink_target_is_bound_without_traversing_external_directory(self):
        external = self.directory / 'external-fixture'
        external.mkdir()
        external_file = external / 'outside.txt'
        external_file.write_text('external fixture one\n')
        alias = self.root / 'Runtime'
        alias.symlink_to('../external-fixture', target_is_directory=True)

        original = builder.tree_files(self.root)
        self.assertEqual(original, {'Runtime': {'symlink': '../external-fixture'}})
        external_file.write_text('external fixture changed\n')
        self.assertEqual(builder.tree_files(self.root), original)

        alias.unlink()
        alias.symlink_to('different-runtime')
        self.assertNotEqual(builder.tree_files(self.root), original)
        self.assertEqual(builder.tree_files(self.root),
                         {'Runtime': {'symlink': 'different-runtime'}})


if __name__ == '__main__':
    unittest.main()
