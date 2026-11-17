#!/usr/bin/env python3
"""Build uninstalled standalone Offline or local authorization runtimes.

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


def copy_mpp_protocol(source, runtime):
    """Consume the reviewed protocol-only artifact; never ship its private inventory."""
    lock = source / 'source-lock.json'
    binary = source / 'yosh-execution-protocol'
    if lock.is_symlink() or binary.is_symlink() or not binary.is_file():
        raise ValueError('Regular MPP artifact files required')
    record = json.loads(lock.read_text())
    expected = {
        'kind': 'mpp-protocol-only', 'schemaVersion': 1, 'networkDenied': True,
        'paymentSent': False, 'signerUsed': False,
        'payRevision': '402f67c44dd8d41d7d1584fcb5d868006ce8c891',
        'payKitRevision': '7f1369180ca4b047aadff1bea77aed4525e10039',
        'binarySha256': builder.digest(binary),
        'wrapperSha256': builder.digest(ROOT / 'integration/pay-protocol-engine/main.rs'),
        'builderSha256': builder.digest(ROOT / 'scripts/build-mpp-protocol-engine.py'),
    }
    if any(record.get(key) != value for key, value in expected.items()):
        raise ValueError('MPP artifact provenance mismatch')
    shutil.copy2(binary, runtime / 'mpp-protocol-engine')
    builder.write_json(runtime / 'mpp-provenance.json', {**expected, 'sourceLockSha256': builder.digest(lock)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source_args = parser.add_mutually_exclusive_group(required=True)
    source_args.add_argument('--artifact', type=Path)
    source_args.add_argument('--dependencies', type=Path)
    parser.add_argument('--local-authorization', action='store_true', help='Build the isolated C Devnet runtime with trusted local setup')
    parser.add_argument('--mpp-artifact', type=Path, help='Reviewed protocol-only build')
    parser.add_argument('--mainnet-mpp', action='store_true', help='Include MPP in the verified Mainnet subset; requires explicit runtime upgrade')
    parser.add_argument('--retain-mainnet-runtime', type=Path, help='Preserve a verified installed Mainnet runtime during a Devnet-only update')
    parser.add_argument('--output', type=Path, default=ROOT / 'build.noindex/standalone-dev-0.1.0')
    args = parser.parse_args()
    if args.mpp_artifact and not args.local_authorization:
        raise ValueError('MPP requires --local-authorization')
    if args.retain_mainnet_runtime and not args.local_authorization:
        raise ValueError('Retaining Mainnet requires --local-authorization')
    if args.mainnet_mpp and (not args.mpp_artifact or args.retain_mainnet_runtime):
        raise ValueError('Mainnet MPP requires its artifact and cannot retain an older runtime')
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
    if args.mpp_artifact: copy_mpp_protocol(args.mpp_artifact.resolve(strict=True), runtime)
    shutil.copy2(provenance, output / 'dependency-provenance.json')
    env = {key: os.environ[key] for key in ['HOME', 'PATH', 'TMPDIR', 'LANG'] if key in os.environ}
    inputs = {}
    entries = [('standalone-dev.ts', 'standalone.cjs', False), ('pay-dev-mcp.ts', 'mcp.cjs', False)]
    if args.local_authorization:
        entries += [('local-plugin-mcp.ts', 'local-mcp.cjs', False)]
        if not args.retain_mainnet_runtime:
            entries += [('mainnet-standalone.ts', 'mainnet.cjs', True), ('pay-dev-mcp.ts', 'mainnet-mcp.cjs', True)]
    for source_name, name, mainnet in entries:
        metadata = output / (name + '.inputs.json')
        subprocess.run([str(runtime / 'node'), str(ROOT / 'node_modules/esbuild/bin/esbuild'),
            str(ROOT / 'scripts' / source_name), '--bundle', '--platform=node', '--target=node24', '--format=cjs',
            '--define:__YOSH_LOCAL_AUTH_DEV__=' + ('true' if args.local_authorization and not mainnet else 'false'),
            '--define:__YOSH_PLUGIN_DEV__=' + ('false' if mainnet else 'true'),
            '--define:__YOSH_STANDALONE_DEV__=' + ('false' if mainnet else 'true'),
            '--define:__YOSH_RC5__=' + ('true' if mainnet else 'false'),
            '--define:__YOSH_PLUGIN_VERSION__=' + json.dumps('0.2.13' if args.mainnet_mpp else '0.2.7' if args.mpp_artifact else '0.2.4'),
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
    if args.local_authorization and not args.retain_mainnet_runtime:
        # The standalone runtime neither reads nor executes the App bundle.
        shutil.copy2(ROOT / 'scripts/mainnet-runtime.sb', runtime / 'mainnet.sb')
        inputs['scripts/mainnet-runtime.sb'] = builder.digest(ROOT / 'scripts/mainnet-runtime.sb')
        builder.write_json(runtime / 'mainnet-manifest.json', {
            'kind': 'yosh-mainnet-standalone', 'apiVersion': 1, 'dataContract': 'existing-mainnet-v1',
            'mppProtocol': bool(args.mainnet_mpp),
            'profile': 'com.yosh.pay-development.v011rc5', 'version': '0.1.0-dev', 'productionEnabled': False,
            'sourceHead': builder.git(ROOT, 'rev-parse', 'HEAD').decode().strip(),
            'dependencyArtifactSha256': builder.digest(artifact),
            'files': {name: builder.digest(runtime / name) for name in
                      ['node', 'mainnet.cjs', 'mainnet-mcp.cjs', 'pay-mcp', 'pay-protocol-engine', 'mainnet.sb'] +
                      (['mpp-protocol-engine', 'mpp-provenance.json'] if args.mainnet_mpp else [])},
            'licenses': {name: builder.digest(runtime / 'licenses' / name) for name in
                         ['Node-LICENSE', 'Pay-LICENSE', 'pay-kit-LICENSE']},
        })
    if args.retain_mainnet_runtime:
        spec = importlib.util.spec_from_file_location('standalone_packager', ROOT / 'scripts/package-standalone-plugin.py')
        packager = importlib.util.module_from_spec(spec); spec.loader.exec_module(packager)
        retained = args.retain_mainnet_runtime.resolve(strict=True)
        packager.verify_mainnet(retained)
        for name in ['node', 'pay-mcp', 'pay-protocol-engine']:
            if builder.digest(retained / name) != builder.digest(runtime / name):
                raise ValueError('Retained Mainnet shared dependency differs')
        for name in packager.LICENSE_FILES:
            if builder.digest(retained / 'licenses' / name) != builder.digest(runtime / 'licenses' / name):
                raise ValueError('Retained Mainnet license differs')
        for name in ['mainnet.cjs', 'mainnet-mcp.cjs', 'mainnet.sb', 'mainnet-manifest.json']:
            shutil.copy2(retained / name, runtime / name)
    manifest = {'kind': 'yosh-local-devnet' if args.local_authorization else 'yosh-standalone-offline-dev', 'apiVersion': 2 if args.local_authorization else 1, 'dataContract': 'local-devnet-v1' if args.local_authorization else 'standalone-offline-v1',
        'productionEnabled': False, 'mainnetBridge': False, 'mainnetStandalone': bool(args.local_authorization),
        'mppProtocol': bool(args.mpp_artifact), 'mainnetMpp': bool(args.mainnet_mpp),
        'retainedMainnetManifestSha256': builder.digest(runtime / 'mainnet-manifest.json') if args.retain_mainnet_runtime else None,
        'signing': 'dependency-ad-hoc-only', 'version': '0.1.0-dev',
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
