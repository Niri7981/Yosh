"""Configuration safety checks; these do not stand in for product host acceptance."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("pay_dev_codex", Path(__file__).resolve().parents[2] / "scripts/run-pay-dev-codex.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class PayDevCodexConfiguration(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="yosh-pay-codex-config-")
        self.root = Path(self.temporary.name).resolve()
        self.data = self.root / "data"
        self.data.mkdir(mode=0o700)
        self.manifest = self.data / "pay-dev-runtime.json"
        launcher.private_write(self.manifest, json.dumps(dict(version=1, profile="isolated-pay-dev", origin="http://127.0.0.1:13449",
            memberId="00000000-0000-4000-8000-000000000001", merchantUrl="http://127.0.0.1:13449/dev-api")))
        self.bundle = self.root / "Yosh Pay Dev v0.1.1-rc.5.app"
        runtime = self.bundle / "Contents/Resources/Runtime"
        runtime.mkdir(parents=True)
        for name in ("node", "mcp.cjs", "pay-mcp"):
            (runtime / name).touch()
        self.args = SimpleNamespace(data_dir=str(self.data), bundle=str(self.bundle), codex=None)

    def tearDown(self):
        self.temporary.cleanup()

    def test_no_real_home_auth_or_secret_environment_is_inherited(self):
        original_home = os.environ.get("HOME")
        with patch.dict(os.environ, {"OPENAI_API_KEY": "sentinel-secret", "YOSH_MANAGEMENT_TOKEN": "sentinel-management"}):
            _, env, workspace, _ = launcher.setup(self.args)
        self.assertEqual(os.environ.get("HOME"), original_home)
        self.assertEqual(env["HOME"], str(self.data / "codex-user-home"))
        self.assertEqual(env["CODEX_HOME"], str(self.data / "codex-home"))
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("YOSH_MANAGEMENT_TOKEN", env)
        self.assertEqual(workspace, self.data / "codex-workspace")
        config = self.data / "codex-home/config.toml"
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        self.assertIn('cli_auth_credentials_store = "file"', config.read_text())
        self.assertNotIn("sentinel", config.read_text())

    def test_untrusted_profile_nonprivate_manifest_and_symlink_are_rejected(self):
        self.manifest.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "PRIVATE_CONFIG"):
            launcher.setup(self.args)
        self.manifest.chmod(0o600)
        manifest = json.loads(self.manifest.read_text())
        manifest["profile"] = "production"
        launcher.private_write(self.manifest, json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, "PROFILE"):
            launcher.setup(self.args)
        self.manifest.rename(self.data / "real-manifest.json")
        self.manifest.symlink_to(self.data / "real-manifest.json")
        with self.assertRaisesRegex(RuntimeError, "PRIVATE_CONFIG"):
            launcher.setup(self.args)

    def test_actual_codex_parses_only_bundled_pay_entry(self):
        command, env, workspace, _ = launcher.setup(self.args)
        result = subprocess.run([command, "mcp", "list", "--json"], env=env, cwd=workspace,
                                capture_output=True, text=True, timeout=15, check=True)
        entries = json.loads(result.stdout)
        self.assertEqual([entry["name"] for entry in entries], ["yosh_pay_dev"])
        self.assertEqual(entries[0]["transport"]["command"], str(self.bundle / "Contents/Resources/Runtime/node"))


if __name__ == "__main__":
    unittest.main()
