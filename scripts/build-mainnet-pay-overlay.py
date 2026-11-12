#!/usr/bin/env python3
"""Stage the bounded V0 custody compatibility update on the verified installed App.

Copies the current bundle; changes only Pay, provenance and the App signature.
Does not install, launch, access a wallet or open product data.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


stable = module('pay_overlay_stable', 'build-stable-release.py')
dependencies = module('pay_overlay_dependencies', 'build-standalone-dependencies.py')


def build(args):
    output = dependencies.builder.safe_output(args.output)
    if output.exists():
        raise ValueError('Preserve previous output; select a fresh staging directory')
    base = stable.verify_artifact(args.base_artifact)
    installed = args.installed_app.resolve(strict=True)
    if args.installed_app.is_symlink() or args.installed_app.absolute() != installed:
        raise ValueError('Installed App path must be canonical')
    stable.verify_bundle(installed)
    if stable.rc.tree_files(installed) != stable.rc.tree_files(base):
        raise ValueError('Installed App differs from verified base artifact')
    runtime = dependencies.verify(args.dependencies)
    inputs = json.loads((args.dependencies / 'build-inputs.json').read_text())
    sources = {name: inputs['yosh']['files'][name]['sha256'] for name in stable.PAY_COMPATIBILITY_SOURCES}
    if sources != {name: stable.rc.digest(ROOT / name) for name in stable.PAY_COMPATIBILITY_SOURCES}:
        raise ValueError('Pay dependency sources differ from current compatibility fix')
    provenance = json.loads((installed / stable.SOURCE_MANIFEST).read_text())
    if 'payVersionCompatibilityUpdate' in provenance:
        raise ValueError('Existing Pay update requires a new explicit parent contract')
    output.mkdir(parents=True, mode=0o700)
    app = output / 'Yosh.app'
    shutil.copytree(installed, app, symlinks=True)
    evidence = output / 'pay-version-compatibility'
    evidence.mkdir(mode=0o700)
    shutil.copy2(installed / stable.SOURCE_MANIFEST, evidence / 'base-source-manifest.json')
    shutil.copy2(args.base_artifact / 'stable-artifact.json', evidence / 'base-artifact.json')
    for name in ['dependencies-artifact.json', 'build-inputs.json', 'build-steps.json']:
        shutil.copy2(args.dependencies / name, evidence / name)
    previous = stable.rc.digest(app / stable.PAY_BINARY)
    shutil.copy2(runtime / 'pay-mcp', app / stable.PAY_BINARY)
    provenance['payVersionCompatibilityUpdate'] = {
        'version': 1, 'kind': 'pay-v0-compatibility-v1',
        'basePayMcpSha256': previous, 'payMcpSha256': stable.rc.digest(app / stable.PAY_BINARY),
        'evidence': {name: stable.rc.digest(evidence / name) for name in sorted(stable.PAY_COMPATIBILITY_EVIDENCE)},
        'sources': sources,
    }
    (app / stable.SOURCE_MANIFEST).write_text(json.dumps(provenance, indent=2) + '\n')
    subprocess.run(['codesign', '--force', '--sign', '-', app], check=True)
    record = {'product': provenance['product'], 'sourceManifestSha256': stable.rc.digest(app / stable.SOURCE_MANIFEST),
              'files': stable.rc.tree_files(app)}
    (output / 'stable-artifact.json').write_text(json.dumps(record, indent=2) + '\n')
    stable.verify_artifact(output)
    print('Verified Mainnet Pay compatibility candidate: ' + str(app))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['output', 'base-artifact', 'installed-app', 'dependencies']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    for name in ['base_artifact', 'dependencies']:
        setattr(args, name, getattr(args, name).resolve(strict=True))
    build(args)


if __name__ == '__main__':
    main()
