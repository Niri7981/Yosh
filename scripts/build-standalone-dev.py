#!/usr/bin/env python3
"""Build an uninstalled, Offline-only runtime without a Yosh App shell.

Node and Rust inputs come from a verified dependency-only build, or explicitly
from a legacy Dev artifact. No installed App or wallet is read.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('plugin_builder', ROOT / 'scripts/build-codex-plugin-dev.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source_args = parser.add_mutually_exclusive_group(required=True)
    source_args.add_argument('--artifact', type=Path)
    source_args.add_argument('--dependencies', type=Path)
    parser.add_argument('--local-authorization', action='store_true', help='Build the isolated C Devnet runtime with trusted local setup')
    parser.add_argument('--output', type=Path, default=ROOT / 'build.noindex/standalone-dev-0.1.0')
    args = parser.parse_args()
    output = builder.safe_output(args.output)
    if args.dependencies:
        spec = importlib.util.spec_from_file_location('standalone_dependencies', ROOT / 'scripts/build-standalone-dependencies.py')
        dependencies = importlib.util.module_from_spec(spec); spec.loader.exec_module(dependencies)
        source = dependencies.verify(args.dependencies)
        artifact = args.dependencies / 'dependencies-artifact.json'
        provenance = args.dependencies / 'build-inputs.json'
    else:
        app = builder.verify(args.artifact)
        source = app / 'Contents/Resources/Runtime'
        artifact = args.artifact / 'dev-artifact.json'
        provenance = source / 'codex-plugin-dev-source-manifest.json'
    builder.npm_inventory(ROOT)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    runtime = output / 'runtime'
    runtime.mkdir(mode=0o700)
    for name in ['node', 'pay-mcp', 'pay-protocol-engine']:
        shutil.copy2((source / name).resolve(strict=True), runtime / name)
    shutil.copytree(source / 'licenses', runtime / 'licenses')
    shutil.copy2(provenance, output / 'dependency-provenance.json')
    env = {key: os.environ[key] for key in ['HOME', 'PATH', 'TMPDIR', 'LANG'] if key in os.environ}
    inputs = {}
    for source_name, name in [('standalone-dev.ts', 'standalone.cjs'), ('pay-dev-mcp.ts', 'mcp.cjs'), *([('local-plugin-mcp.ts', 'local-mcp.cjs')] if args.local_authorization else [])]:
        metadata = output / (name + '.inputs.json')
        subprocess.run([str(runtime / 'node'), str(ROOT / 'node_modules/esbuild/bin/esbuild'),
            str(ROOT / 'scripts' / source_name), '--bundle', '--platform=node', '--target=node24', '--format=cjs',
            '--define:__YOSH_LOCAL_AUTH_DEV__=' + ('true' if args.local_authorization else 'false'), '--define:__YOSH_PLUGIN_DEV__=true', '--define:__YOSH_STANDALONE_DEV__=true', '--define:__YOSH_RC5__=false',
            '--outfile=' + str(runtime / name), '--metafile=' + str(metadata)], cwd=ROOT, env=env, check=True)
        for path in json.loads(metadata.read_text())['inputs']:
            inputs[path] = builder.digest(ROOT / path)
    (runtime / 'offline.sb').write_text('''(version 1)
(allow default)
(deny network*)
(allow network-inbound network-outbound (local ip "localhost:*") (remote ip "localhost:*"))
(deny file-read* file-write* (regex #".*\\.app(/|$)"))
(deny file-read-data (require-all (subpath (param "USERHOME"))
    (require-not (subpath (param "RUNTIME"))) (require-not (subpath (param "DATA")))))
(deny file-write*)
(allow file-write* (subpath (param "DATA")))
(deny file-read* file-write* (subpath "/Library/Keychains"))
(deny process-exec (literal "/usr/bin/security"))
''')
    if args.local_authorization:
        subprocess.run(['swiftc', '-parse-as-library', str(ROOT / 'scripts/native/LocalGrantConfirmation.swift'), '-o', str(runtime / 'yosh-confirm'),
            '-framework', 'AppKit', '-framework', 'LocalAuthentication', '-framework', 'CryptoKit'], check=True)
        subprocess.run(['codesign', '--force', '--sign', '-', '--options', 'runtime', '--identifier', 'com.yosh.local-authorization-dev.confirm', str(runtime / 'yosh-confirm')], check=True)
        for name in ['spirit-design-sheet.png', 'instrument-serif.woff2', 'Instrument-Serif-OFL.txt']:
            shutil.copy2(ROOT / 'src/modules/authority/web-assets' / name, runtime / name)
        inputs['scripts/native/LocalGrantConfirmation.swift'] = builder.digest(ROOT / 'scripts/native/LocalGrantConfirmation.swift')
    if args.local_authorization:
        shutil.copy2(ROOT / 'plugins/yosh-mainnet/scripts/launch.mjs', runtime / 'mainnet-launch.mjs')
        bridge = (ROOT / 'plugins/yosh-mainnet/scripts/launch.sh').read_text()
        bridge = bridge.replace('$(/usr/bin/dirname "$0")/..', '$(/usr/bin/dirname "$0")')
        bridge = bridge.replace('$plugin_root/scripts/launch.mjs', '$plugin_root/mainnet-launch.mjs')
        (runtime / 'mainnet-launch.sh').write_text(bridge)
        (runtime / 'mainnet-launch.sh').chmod(0o755)
        for name in ['plugins/yosh-mainnet/scripts/launch.mjs', 'plugins/yosh-mainnet/scripts/launch.sh']:
            inputs[name] = builder.digest(ROOT / name)
    manifest = {'kind': 'yosh-local-devnet' if args.local_authorization else 'yosh-standalone-offline-dev', 'apiVersion': 2 if args.local_authorization else 1, 'dataContract': 'local-devnet-v1' if args.local_authorization else 'standalone-offline-v1',
        'productionEnabled': False, 'mainnetBridge': bool(args.local_authorization), 'signing': 'dependency-ad-hoc-only', 'version': '0.1.0-dev',
        'profile': 'com.yosh.local-authorization-dev' if args.local_authorization else 'com.yosh.standalone-plugin-dev', 'ports': [17449, 17452] if args.local_authorization else [15449, 15450, 15451],
        'sourceHead': builder.git(ROOT, 'rev-parse', 'HEAD').decode().strip(),
        'dependencyArtifactSha256': builder.digest(artifact),
        'dependencySourceSha256': builder.digest(output / 'dependency-provenance.json'),
        'npmLockSha256': builder.digest(ROOT / 'package-lock.json'),
        'inputs': inputs, 'files': {p.name: builder.digest(p) for p in runtime.iterdir() if p.is_file()}}
    builder.write_json(runtime / 'manifest.json', manifest)
    (output / 'yosh-dev').write_text('''#!/bin/sh
set -eu
runtime="$(CDPATH= cd -- "$(dirname -- "$0")/runtime" && pwd -P)"
exec "$runtime/node" "$runtime/standalone.cjs" "$@"
''')
    (output / 'yosh-dev').chmod(0o755)
    print('Standalone Dev package: ' + str(output))


if __name__ == '__main__':
    main()
