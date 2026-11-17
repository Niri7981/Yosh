"""Run the shipped standalone policy against disposable App fixtures."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(Path('/usr/bin/sandbox-exec').exists(), 'macOS sandbox required')
class MainnetAppIsolationTests(unittest.TestCase):
    def test_standalone_cannot_read_write_or_execute_the_app(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            app = root / 'Yosh.app'
            reader = app / 'Contents/Resources/Runtime/backend/server.js'
            reader.parent.mkdir(parents=True)
            reader.write_text('old App fixture')
            executable = app / 'fixture-executable'
            executable.write_text('#!/bin/sh\nexit 0\n'); executable.chmod(0o700)
            script = '''
const fs = require('node:fs'), cp = require('node:child_process');
const [app, reader] = process.argv.slice(1);
const denied = fn => { try { fn(); return false; } catch { return true; } };
console.log(JSON.stringify({
  readApp: denied(() => fs.readFileSync(reader)),
  writeApp: denied(() => fs.appendFileSync(reader, 'changed')),
  executeApp: cp.spawnSync(app + '/fixture-executable').error?.code === 'EPERM'}));
'''
            result = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(ROOT / 'scripts/mainnet-runtime.sb'),
                'node', '-e', script, str(app), str(reader)], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout), {'readApp': True, 'writeApp': True, 'executeApp': True})
            self.assertEqual(reader.read_text(), 'old App fixture')


if __name__ == '__main__': unittest.main()
