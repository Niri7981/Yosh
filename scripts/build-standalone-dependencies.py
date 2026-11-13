#!/usr/bin/env python3
"""Rebuild standalone Node/Pay dependencies from locked sources, without an App.

Reuse the existing Dev input verification/preparation. Historical release rules
are unchanged. A fresh target directory and offline Cargo prevent undocumented
binary caches from becoming build inputs.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('dev_inputs', ROOT / 'scripts/build-codex-plugin-dev.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def inputs(args):
    record = builder.inputs(args)
    record['kind'] = 'standalone-dependencies'
    record.pop('identity')
    # Only these Yosh files contribute to the dependency build. Frontend/docs
    # edits during a long Rust compile cannot alter its frozen input snapshot.
    names = [*builder.OVERLAYS.values(), 'integration/pay-protocol-engine/main.rs',
             'scripts/build-codex-plugin-dev.py', 'scripts/build-standalone-dependencies.py']
    record['yosh']['files'] = builder.inventory(ROOT, names)
    record.pop('npm')  # npm is not executed by this dependency-only build.
    return record


def verify(output):
    output = builder.safe_output(output)
    artifact = json.loads((output / 'dependencies-artifact.json').read_text())
    if artifact.get('kind') != 'standalone-dependencies' or artifact.get('productionEnabled') is not False:
        raise ValueError('Standalone dependency identity mismatch')
    runtime = output / 'runtime'
    if artifact['files'] != builder.inventory(runtime) or artifact['sourceSha256'] != builder.digest(output / 'build-inputs.json') \
            or artifact['stepsSha256'] != builder.digest(output / 'build-steps.json'):
        raise ValueError('Standalone dependency artifact changed')
    for name in ['node', 'pay-mcp', 'pay-protocol-engine']:
        subprocess.run(['codesign', '--verify', '--strict', runtime / name], check=True)
    return runtime


def build(args):
    record = inputs(args)
    output = builder.safe_output(args.output)
    if not output.exists(): record = builder.prepare(args, record)
    else: record = builder.check_prepared(args, record)
    if (output / 'runtime').exists(): raise ValueError('Existing output preserved; select a new directory')
    for name in ['private-home', 'tmp', 'logs', 'clang-cache']:
        (output / name).mkdir(mode=0o700, exist_ok=True)
    node = output / ('node-runtime/node-v' + builder.NODE_VERSION + '-darwin-arm64/bin/node')
    env = {'PATH': str(node.parent) + ':' + os.environ.get('PATH', '/usr/bin:/bin'),
           'HOME': str(output / 'private-home'), 'TMPDIR': str(output / 'tmp'),
           'RUSTUP_HOME': os.environ.get('RUSTUP_HOME', str(Path.home() / '.rustup')), 'RUSTUP_AUTO_INSTALL': '0',
           'CARGO_HOME': str(output / 'cargo-home'), 'CARGO_TARGET_DIR': str(output / 'rust-target'),
           'CARGO_NET_OFFLINE': 'true', 'CARGO_BUILD_JOBS': '4', 'CI': '1',
           'CLANG_MODULE_CACHE_PATH': str(output / 'clang-cache')}
    policy = builder.sandbox(output, args, record)
    # A compile uses Xcode's toolchain, but never Yosh application bundles.
    with policy.open('a') as stream:
        for name in ['Yosh.app', 'Yosh Codex Plugin Dev.app']:
            stream.write('(deny file-read* file-write* (subpath ' + json.dumps(str(Path.home() / 'Applications' / name)) + '))\n')
        stream.write('(deny file-read* file-write* (subpath ' + json.dumps(str(Path.home() / 'Library/Application Support/Yosh Standalone Plugin Dev')) + '))\n')
    steps = []
    def run(label, command, cwd=ROOT):
        log = output / 'logs' / (label + '.log')
        print('START ' + label, flush=True)
        with log.open('w') as stream:
            result = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(policy), *map(str, command)],
                cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT)
        steps.append({'label': label, 'argv': list(map(str, command)), 'exitCode': result.returncode, 'logSha256': builder.digest(log)})
        builder.write_json(output / 'build-steps.json', steps)
        if result.returncode: raise RuntimeError('Dependency build failed: ' + str(log))
        print('PASS ' + label, flush=True)
    for label, command in [('node', [node, '--version']), ('cargo', ['cargo', '--version']), ('rustc', ['rustc', '--version'])]:
        run('toolchain-' + label, command)
    run('pay-mcp', ['cargo', 'build', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-controlled-mcp'], output / 'pay-source/rust')
    run('protocol-engine', ['cargo', 'build', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-execution-protocol'], output / 'protocol-source/rust')
    runtime = output / 'runtime'; runtime.mkdir(mode=0o700)
    (runtime / 'licenses').mkdir()
    shutil.copy2(node, runtime / 'node')
    for source, name in [('yosh-controlled-mcp', 'pay-mcp'), ('yosh-execution-protocol', 'pay-protocol-engine')]:
        shutil.copy2(output / 'rust-target/debug' / source, runtime / name)
    for source, name in [(node.parent.parent / 'LICENSE', 'Node-LICENSE'), (args.pay / 'LICENSE', 'Pay-LICENSE'), (args.pay_kit / 'LICENSE', 'pay-kit-LICENSE')]:
        shutil.copy2(source, runtime / 'licenses' / name)
    for name in ['node', 'pay-mcp', 'pay-protocol-engine']:
        run('sign-' + name, ['codesign', '--force', '--sign', '-', runtime / name])
    builder.check_prepared(args, inputs(args))
    builder.write_json(output / 'dependencies-artifact.json', {'kind': 'standalone-dependencies', 'productionEnabled': False,
        'sourceSha256': builder.digest(output / 'build-inputs.json'), 'stepsSha256': builder.digest(output / 'build-steps.json'),
        'files': builder.inventory(runtime)})
    verify(output)
    print('Standalone dependencies: ' + str(output), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['build', 'verify'])
    parser.add_argument('--output', type=Path, required=True)
    for name in ['pay', 'pay-kit', 'cargo-home', 'node-archive']: parser.add_argument('--' + name, type=Path)
    args = parser.parse_args()
    args.output = builder.safe_output(args.output)
    if args.action == 'verify': print(verify(args.output)); return
    for name in ['pay', 'pay_kit', 'cargo_home', 'node_archive']:
        if getattr(args, name) is None: parser.error('--' + name.replace('_', '-') + ' required')
        setattr(args, name, getattr(args, name).resolve(strict=True))
    build(args)


if __name__ == '__main__': main()
