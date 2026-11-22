"""Verify the terminal installer without downloading or registering real hosts."""
import hashlib
import os
from pathlib import Path
import platform
import stat
import subprocess
import tempfile
import unittest
import zipfile


INSTALLER = Path(__file__).resolve().parents[2] / "scripts/install-yosh.sh"
RELEASE = "v0.2.20-preview"
PACKAGE = "yosh-standalone-marketplace"


@unittest.skipUnless(platform.system() == "Darwin" and platform.machine() == "arm64",
                     "The preview targets Apple Silicon macOS")
class InstallYoshTests(unittest.TestCase):
    def setUp(self):
        owner = tempfile.TemporaryDirectory()
        self.addCleanup(owner.cleanup)
        root = Path(owner.name).resolve()
        self.home = root / "home with spaces"
        self.home.mkdir()
        self.archive = root / "Yosh preview.zip"
        self.checksum = root / "Yosh preview.sha256"
        self.installation = self.home / "Library/Application Support/Yosh Preview" / RELEASE

    def make_zip(self, extra=None):
        files = {
            "Install.command": (0o100755, "#!/bin/sh\nprintf 'Installer received %s\\n' \"$*\"\n"),
            "Connect-Dot.command": (0o100755, "#!/bin/sh\n"),
            ".agents/plugins/marketplace.json": (0o100644, "{}\n"),
            "plugins/yosh-local-dev/yosh-dev": (0o100755, "#!/bin/sh\n"),
            "plugins/yosh-local-dev/runtime/node": (0o100755, "#!/bin/sh\n"),
            "plugins/yosh-local-dev/runtime/manifest.json": (0o100644, "{}\n"),
            "plugins/yosh-local-dev/.codex-plugin/plugin.json": (0o100644, '{"version":"0.2.20"}\n'),
        }
        with zipfile.ZipFile(self.archive, "w") as archive:
            for path, (mode, body) in files.items():
                self.add_entry(archive, f"{PACKAGE}/{path}", mode, body)
            if extra:
                self.add_entry(archive, *extra)
        expected = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.checksum.write_text(f"{expected}  {self.archive.name}\n")

    @staticmethod
    def add_entry(archive, path, mode, body):
        entry = zipfile.ZipInfo(path)
        entry.create_system = 3
        entry.external_attr = mode << 16
        archive.writestr(entry, body)

    def install(self, *arguments):
        env = {**os.environ, "HOME": str(self.home)}
        return subprocess.run(
            ["/bin/sh", str(INSTALLER), "--archive", str(self.archive),
             "--sha256-file", str(self.checksum), *arguments],
            env=env, capture_output=True, text=True, timeout=10,
        )

    def test_install_and_rerun_keep_a_private_marketplace(self):
        self.make_zip()
        result = self.install("--install-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("Installer received", result.stdout)
        self.assertEqual(stat.S_IMODE(self.installation.stat().st_mode), 0o700)
        self.assertTrue((self.installation / PACKAGE / "Install.command").is_file())

        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Installer received --interactive", result.stdout)
        self.assertEqual(len(list(self.installation.parent.glob(".stage.*"))), 0)

    def test_checksum_mismatch_never_installs(self):
        self.make_zip()
        self.checksum.write_text("0" * 64 + "\n")
        result = self.install("--install-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum does not match", result.stderr)
        self.assertFalse(self.installation.exists())

    def test_rejects_links_and_paths_outside_the_package(self):
        for extra in ((f"{PACKAGE}/link", 0o120777, "/tmp"),
                      ("../outside", 0o100644, "invalid"),
                      ("../path with space/" + PACKAGE + "/bin", 0o100644, "invalid")):
            with self.subTest(extra=extra[0]):
                self.make_zip(extra)
                result = self.install("--install-only")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unsafe or unexpected archive entries", result.stderr)
                self.assertFalse(self.installation.exists())

    def test_refuses_to_replace_existing_preview(self):
        self.make_zip()
        self.installation.mkdir(parents=True, mode=0o700)
        self.installation.parent.chmod(0o700)
        marker = self.installation / "keep"
        marker.write_text("existing installation")
        result = self.install("--install-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("existing preview", result.stderr)
        self.assertEqual(marker.read_text(), "existing installation")


if __name__ == "__main__":
    unittest.main()
