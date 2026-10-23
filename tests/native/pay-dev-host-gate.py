"""Exercise the actual built Pay host's opt-in and private-config gate."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BINARY = ROOT / "build.noindex/pay-mcp-target/debug/yosh-controlled-mcp"


class PayDevelopmentHostGate(unittest.TestCase):
    def run_host(self, development, mode=0o600):
        with tempfile.TemporaryDirectory(prefix="pay-host-gate-") as temporary:
            config = Path(temporary) / "host.json"
            config.write_text(json.dumps(dict(origin="http://127.0.0.1:13449", token="a" * 43,
                caller="00000000-0000-4000-8000-000000000001", timeout_ms=5000)))
            config.chmod(mode)
            env = dict(PATH="/usr/bin:/bin", HOME=temporary, NODE_ENV="production")
            if development:
                env["YOSH_PAY_DEV"] = "1"
            request = dict(jsonrpc="2.0", id=1, method="initialize", params=dict(protocolVersion="2024-11-05",
                capabilities={}, clientInfo=dict(name="gate-check", version="1")))
            return subprocess.run([str(BINARY), str(config)], env=env, input=json.dumps(request) + "\n",
                text=True, capture_output=True, timeout=10)

    def test_ordinary_production_invocation_remains_disabled(self):
        result = self.run_host(False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ISOLATED_TEST_ONLY", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_nonprivate_config_is_rejected(self):
        result = self.run_host(True, 0o644)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PRIVATE_CONFIG_REQUIRED", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_explicit_private_development_initializes_real_pay(self):
        result = self.run_host(True)
        self.assertEqual(result.returncode, 0)
        response = json.loads(result.stdout)
        self.assertEqual(response["result"]["serverInfo"]["name"], "pay")
        self.assertIn("tools", response["result"]["capabilities"])


if __name__ == "__main__":
    unittest.main()
