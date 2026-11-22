import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import warnings


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/connect-dot.py"
spec = importlib.util.spec_from_file_location("connect_dot", SCRIPT)
connector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connector)
AUTH = b"Bearer yrr1_" + b"a" * 43
KEY = b"sk-" + b"b" * 24
ID = "tunnel_example_test_01"


class ConnectDotTests(unittest.TestCase):
    def setUp(self):
        storage = tempfile.TemporaryDirectory()
        self.addCleanup(storage.cleanup)
        self.home = Path(storage.name).resolve()
        self.support = self.home / "Library/Application Support"
        self.support.mkdir(parents=True)
        self.directory = self.support / "Yosh Dot Connections" / ID
        self.runtime = self.home / "package/runtime"
        self.runtime.mkdir(parents=True)
        (self.runtime / "mainnet-manifest.json").write_text("{}")
        self.installed = self.home / ("a" * 64)
        self.arguments = ["connect-dot.py", "--runtime-dir", str(self.runtime), "--tunnel-id", ID]

    def run_main(self, *arguments):
        with mock.patch.object(connector.sys, "platform", "darwin"), \
                mock.patch.object(connector.sys, "argv", [*self.arguments, *arguments]), \
                mock.patch.object(connector.Path, "home", return_value=self.home), \
                mock.patch.object(connector.shutil, "which", return_value="/example/bin/tunnel-client"), \
                mock.patch.object(connector.os, "umask"), contextlib.redirect_stdout(io.StringIO()):
            connector.main()

    def test_setup_reuses_private_key_and_pairing_after_success(self):
        key = self.directory / "runtime.key"
        authorization = self.directory / "statement.authorization"

        def pair(runtime, *arguments, timeout):
            self.assertEqual(runtime, self.installed)
            self.assertEqual(arguments, ("remote-statement", "pair", "--label", "Dot", "--header-out", str(authorization)))
            connector.write_private(authorization, AUTH)

        with mock.patch.object(connector.getpass, "getpass", return_value=KEY.decode()) as prompt, \
                mock.patch.object(connector, "start_owner", return_value=self.installed), \
                mock.patch.object(connector, "local_cli", side_effect=pair) as request, \
                mock.patch.object(connector, "probe_statement") as probe, \
                mock.patch.object(connector, "launchctl", return_value=1), \
                mock.patch.object(connector, "foreground") as launch:
            self.run_main()
            self.run_main()
        prompt.assert_called_once()
        request.assert_called_once()
        self.assertEqual(probe.call_args_list, [mock.call(AUTH), mock.call(AUTH)])
        self.assertEqual(launch.call_count, 2)
        self.assertEqual(key.read_bytes(), KEY)
        self.assertEqual(key.stat().st_mode & 0o777, 0o600)

    def test_background_without_credentials_exits_before_cli_or_tunnel(self):
        with mock.patch.object(connector, "start_owner") as start, \
                mock.patch.object(connector.getpass, "getpass") as prompt, \
                mock.patch.object(connector.os, "execve") as launch:
            self.run_main("--serve")
        start.assert_not_called()
        prompt.assert_not_called()
        launch.assert_not_called()

    def test_refuses_echoed_key_entry_and_unsafe_credential_paths(self):
        key = self.home / "key"
        with mock.patch.object(connector.getpass, "getpass",
                               side_effect=lambda *_: warnings.warn("unexpected echo", connector.getpass.GetPassWarning)):
            with self.assertRaisesRegex(ValueError, "interactive Terminal"):
                connector.read_openai_key(key)
        self.assertFalse(key.exists())
        destination = self.home / "destination"
        connector.write_private(destination, KEY)
        key.symlink_to(destination)
        with self.assertRaises(OSError):
            connector.credential(key, connector.KEY_PATTERN)
        destination.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "permissions"):
            connector.credential(destination, connector.KEY_PATTERN)

    def test_scope_and_network_are_checked_before_tunnel_launch(self):
        expected = {"tools": [{"name": "list_account_purchases"}]}
        extra = {"tools": [*expected["tools"], {"name": "request_purchase"}]}
        wrong_network = {"content": [{"type": "text", "text": json.dumps({"environment": "live_devnet"})}]}
        good_statement = {"content": [{"type": "text", "text": json.dumps({"environment": "live_mainnet"})}]}
        with mock.patch.object(connector, "mcp_call", side_effect=[extra]) as call:
            with self.assertRaisesRegex(ValueError, "exactly one"):
                connector.probe_statement(AUTH)
        call.assert_called_once_with(AUTH, 1, "tools/list", {})
        with mock.patch.object(connector, "mcp_call", side_effect=[expected, wrong_network]):
            with self.assertRaisesRegex(ValueError, "verified as Mainnet"):
                connector.probe_statement(AUTH)
        with mock.patch.object(connector, "mcp_call", side_effect=[expected, good_statement]) as call:
            connector.probe_statement(AUTH)
        call.assert_called_with(AUTH, 2, "tools/call", {"name": "list_account_purchases", "arguments": {"limit": 1}})

    def test_tunnel_command_only_passes_credential_file_references(self):
        args = connector.parse_args([*self.arguments[1:], "--proxy", "http://127.0.0.1:9999"])
        options = connector.tunnel_arguments(args, self.directory)
        self.assertIn(f"--control-plane.api-key=file:{self.directory / 'runtime.key'}", options)
        self.assertIn(f"--mcp.extra-headers=Authorization: file:{self.directory / 'statement.authorization'}", options)
        self.assertIn("--control-plane.http-proxy=http://127.0.0.1:9999", options)
        self.assertEqual(connector.client_environment()["NO_PROXY"], "127.0.0.1,localhost,::1")
        with contextlib.redirect_stderr(io.StringIO()) as error, self.assertRaises(SystemExit):
            connector.parse_args([*self.arguments[1:], "--proxy", "http://name:private-value@127.0.0.1:9999"])
        self.assertNotIn("private-value", error.getvalue())


if __name__ == "__main__":
    unittest.main()
