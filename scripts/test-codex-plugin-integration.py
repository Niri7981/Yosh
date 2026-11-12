#!/usr/bin/env python3
"""Run opt-in Offline integration against verified Dev build dependencies.

The tests create private temporary profiles and simulated funds. No installed
App, real Keychain wallet, desktop configuration or network payment is used.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('plugin_builder', ROOT / 'scripts/build-codex-plugin-dev.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'build.noindex/codex-plugin-dev')
    args = parser.parse_args()
    output = builder.safe_output(args.output)
    builder.verify(output)
    runtime = output / (builder.NAME + '.app/Contents/Resources/Runtime')
    env = {key: os.environ[key] for key in ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'] if key in os.environ}
    env.update(YOSH_PLUGIN_TEST_RUNTIME_DIR=str(runtime), NEXT_TELEMETRY_DISABLED='1')
    command = [str(runtime / 'node'), str(ROOT / 'node_modules/vitest/vitest.mjs'),
               'run', '--config', str(ROOT / 'vitest.plugin.config.ts')]
    return subprocess.call(command, cwd=ROOT, env=env)


if __name__ == '__main__':
    raise SystemExit(main())
