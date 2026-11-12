#!/usr/bin/env python3
"""Prepare and build an isolated Codex-plugin Dev app from explicit local inputs.

This entry point never installs an app, edits Codex configuration, downloads a
toolchain, or consumes a previously built Pay executable. Frozen release
builders and manifests remain independent of this development workflow.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
BASE = 'd170d74d25c5d47f3e012cb3e22301a96a6add3d'
PAY = '402f67c44dd8d41d7d1584fcb5d868006ce8c891'
KIT = '7f1369180ca4b047aadff1bea77aed4525e10039'
KEYCHAIN = '44b479df245167ca3b3a4e04d6d907146306d342'
NODE_VERSION = '24.21.0'
NODE_SHA256 = '6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe'
NAME = 'Yosh Codex Plugin Dev'
IDENTITY = 'com.yosh.codex-plugin-dev'
OUTPUT = ROOT / 'build.noindex/codex-plugin-dev'
OVERLAYS = {
    'rust/crates/mcp/src/bin/yosh-controlled-mcp.rs':
        'integration/release-candidate/pay-overlay/yosh-controlled-mcp.rs',
    'rust/crates/mcp/tests/fixtures/agent402-mainnet-quote.json':
        'integration/release-candidate/pay-overlay/agent402-mainnet-quote.json',
}
OLD_DIRECTORIES = ['2049', 'Yosh', 'Yosh Pay Dev'] + [
    'Yosh Pay Dev v0.1.1-rc.' + str(number) for number in range(1, 6)]


def digest(path):
    hasher = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def git(path, *args):
    return subprocess.check_output(['git', *args], cwd=path)


def inventory(path, names=None, exclude=()):
    """Hash source bytes and link text without following directory symlinks."""
    names = names if names is not None else [p.relative_to(path).as_posix() for p in path.rglob('*')]
    files = {}
    for name in sorted(set(names)):
        relative = Path(name)
        if any(part in exclude for part in relative.parts):
            continue
        candidate = path / relative
        if candidate.is_symlink():
            if not candidate.resolve().is_relative_to(path.resolve()):
                raise ValueError('External source symlink: ' + name)
            files[name] = {'symlink': os.readlink(candidate)}
        elif candidate.is_file():
            files[name] = {'sha256': digest(candidate), 'mode': oct(candidate.stat().st_mode & 0o777)}
        elif names is not None and not candidate.is_dir():
            raise ValueError('Missing source file: ' + name)
    return files


def source_inventory(root):
    names = list(filter(None, git(root, 'ls-files', '-c', '-o', '--exclude-standard', '-z').decode().split('\0')))
    if any(Path(name).name.startswith('.env') and Path(name).name != '.env.example' for name in names):
        raise ValueError('Private environment files are not build inputs')
    return inventory(root, names)


def check_pay(pay):
    if git(pay, 'rev-parse', 'HEAD').decode().strip() != PAY:
        raise ValueError('Pay #530 pinned revision required')
    if git(pay, 'diff', '--name-only', 'HEAD').strip():
        raise ValueError('Pay tracked source must be clean')
    extras = set(filter(None, git(pay, 'ls-files', '-o', '--exclude-standard', '-z').decode().split('\0')))
    if extras - set(OVERLAYS):
        raise ValueError('Unexpected Pay source files: ' + ', '.join(sorted(extras - set(OVERLAYS))))
    manifest = git(pay, 'show', PAY + ':rust/Cargo.toml').decode()
    if f'rev = "{KIT}"' not in manifest:
        raise ValueError('Pay does not pin the expected pay-kit revision')


def kit_inventory(kit):
    if git(kit, 'rev-parse', 'HEAD').decode().strip() != KIT:
        raise ValueError('Pinned pay-kit revision required')
    modules = git(kit, 'submodule', 'status', '--recursive').decode().splitlines()
    if any(line and line[0] != ' ' for line in modules):
        raise ValueError('pay-kit submodule revision mismatch')
    result = {}
    for source in [kit] + [kit / line.split()[1] for line in modules if line]:
        if git(source, 'diff', '--name-only', '--ignore-submodules=all', 'HEAD').strip():
            raise ValueError('pay-kit tracked source must be clean')
        extras = list(filter(None, git(source, 'ls-files', '-o', '--exclude-standard', '-z').decode().split('\0')))
        if any(name != '.cargo-ok' or (source / name).read_bytes() != b'' for name in extras):
            raise ValueError('Unexpected pay-kit source files')
        prefix = source.relative_to(kit)
        names = list(filter(None, git(source, 'ls-files', '-z').decode().split('\0')))
        result.update({(prefix / name).as_posix(): value for name, value in inventory(source, names).items()})
    return result


def npm_inventory(root):
    lock = json.loads((root / 'package-lock.json').read_text())
    installed = json.loads((root / 'node_modules/.package-lock.json').read_text())
    for name, value in installed['packages'].items():
        expected = lock['packages'].get(name)
        if not expected or value.get('version') != expected.get('version') or value.get('integrity') != expected.get('integrity'):
            raise ValueError('Installed dependency differs from package-lock: ' + name)
        package = json.loads((root / name / 'package.json').read_text())
        if package.get('version') != expected.get('version'):
            raise ValueError('Installed package version differs from lock: ' + name)
    package = json.loads((root / 'package.json').read_text())
    for name in set(package['dependencies']) | set(package['devDependencies']) | {'esbuild'}:
        if 'node_modules/' + name not in installed['packages']:
            raise ValueError('Locked build dependency is missing: ' + name)
    return inventory(root / 'node_modules', exclude=('.cache', '.vite'))


def verify_kit_vendor(kit, vendor):
    expected = inventory(kit / 'rust/crates/kit/src')
    actual = inventory(vendor / 'solana-pay-kit/src')
    if not expected or expected != actual:
        raise ValueError('Vendored pay-kit source differs from the pinned checkout')


def inputs(args):
    try:
        git(ROOT, 'merge-base', '--is-ancestor', BASE, 'HEAD')
    except subprocess.CalledProcessError as error:
        raise ValueError('Codex-plugin Dev must descend from the approved Yosh baseline') from error
    check_pay(args.pay)
    if digest(args.node_archive) != NODE_SHA256:
        raise ValueError('Node archive checksum mismatch')
    config = args.cargo_home / 'config.toml'
    match = re.search(r'^directory\s*=\s*"([^"]+)"', config.read_text(), re.M)
    if not match:
        raise ValueError('An explicit offline Cargo vendor directory is required')
    vendor = Path(match.group(1)).resolve(strict=True)
    verify_kit_vendor(args.pay_kit, vendor)
    lock = ROOT / 'integration/release-candidate/final-source-lock.json'
    historical = json.loads(lock.read_text())['sources']['pay']['files']
    record = {
        'schemaVersion': 1, 'kind': 'codex-plugin-dev', 'productionEnabled': False,
        'identity': {'name': NAME, 'bundleIdentifier': IDENTITY, 'directoryName': NAME,
                     'keychainNamespace': IDENTITY, 'ports': [14449, 14450, 14451],
                     'environments': ['offline', 'simulated']},
        'yosh': {'base': BASE, 'head': git(ROOT, 'rev-parse', 'HEAD').decode().strip(), 'files': source_inventory(ROOT)},
        'pay': {'revision': PAY, 'tree': git(args.pay, 'rev-parse', PAY + '^{tree}').decode().strip(),
                'cargoLockSha256': hashlib.sha256(git(args.pay, 'show', PAY + ':rust/Cargo.lock')).hexdigest(),
                'overlays': {destination: {'source': source, 'sha256': digest(ROOT / source),
                              'frozenSha256': historical[destination]} for destination, source in OVERLAYS.items()}},
        'payKit': {'revision': KIT, 'files': kit_inventory(args.pay_kit)},
        'node': {'version': NODE_VERSION, 'archiveSha256': NODE_SHA256},
        'npm': {'packageLockSha256': digest(ROOT / 'package-lock.json'), 'files': npm_inventory(ROOT)},
        'cargo': {'inputConfigSha256': digest(config), 'vendor': str(vendor), 'files': inventory(vendor)},
    }
    return record


def safe_output(path):
    path = path.absolute()
    base = ROOT / 'build.noindex'
    if path == base or not path.resolve().is_relative_to(base.resolve()) or path.is_symlink():
        raise ValueError('Output must be a real child directory of this checkout/build.noindex')
    if any(parent.is_symlink() for parent in [path, *path.parents] if parent.is_relative_to(ROOT)):
        raise ValueError('Output path cannot contain symlinks')
    return path


def extract(archive, destination):
    with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
        for member in bundle.getmembers():
            target = destination / member.name
            if member.isdev() or not target.resolve().is_relative_to(destination.resolve()):
                raise ValueError('Unsafe archive path')
            if member.issym() and not (target.parent / member.linkname).resolve().is_relative_to(destination.resolve()):
                raise ValueError('Unsafe archive symlink')
            if member.islnk() and not (destination / member.linkname).resolve().is_relative_to(destination.resolve()):
                raise ValueError('Unsafe archive hard link')
        bundle.extractall(destination)


def limit_yosh_custody_version(pay):
    # This exported Pay build serves Yosh's V0 custody host. Leave the upstream
    # SDK and original merchant offer intact; declare the host's actual ceiling.
    path = pay / 'rust/crates/mcp/src/controlled.rs'
    source = path.read_text()
    before = """prepare_unsigned_payment(
                    &payer,
                    &rpc,
                    &requirements,
                    None,
                )"""
    if source.count(before) != 1:
        raise ValueError('Pinned Pay custody builder call changed')
    path.write_text(source.replace(before, before.replace('None,', 'Some(pay_kit::core::tx::TxVersion::V0),')))


def prepare(args, record):
    output = safe_output(args.output)
    if output.exists():
        raise ValueError('Preparation needs a new output directory; existing artifacts are preserved')
    output.mkdir(parents=True)
    pay = output / 'pay-source'
    pay.mkdir()
    # Export Git objects instead of copying a cached checkout's working overlays.
    extract(git(args.pay, 'archive', PAY), pay)
    for destination, source in OVERLAYS.items():
        target = pay / destination
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / source, target)
    limit_yosh_custody_version(pay)
    protocol = output / 'protocol-source/rust'
    shutil.copytree(pay / 'rust', protocol)
    shutil.copy2(ROOT / 'integration/pay-protocol-engine/main.rs', protocol / 'crates/mcp/src/bin/yosh-execution-protocol.rs')
    node = output / 'node-runtime'
    node.mkdir()
    extract(args.node_archive.read_bytes(), node)
    cargo = output / 'cargo-home'
    cargo.mkdir(mode=0o700)
    # Only source replacement is inherited. No cached credential, runner or
    # build configuration becomes an executable build input.
    (cargo / 'config.toml').write_text(
        '[source.crates-io]\nreplace-with = "vendored-sources"\n\n'
        '[source.vendored-sources]\ndirectory = ' + json.dumps(record['cargo']['vendor']) + '\n\n'
        '[source.pay-kit]\ngit = "https://github.com/Niri7981/pay-kit.git"\nrev = "' + KIT + '"\nreplace-with = "vendored-sources"\n\n'
        '[source.solana-keychain]\ngit = "https://github.com/solana-foundation/solana-keychain"\nrev = "' + KEYCHAIN + '"\nreplace-with = "vendored-sources"\n')
    record['prepared'] = {'pay': inventory(pay), 'protocol': inventory(protocol),
                          'node': inventory(node), 'cargoConfigSha256': digest(cargo / 'config.toml')}
    write_json(output / 'build-inputs.json', record)
    return record


def check_prepared(args, record):
    output = safe_output(args.output)
    prepared = json.loads((output / 'build-inputs.json').read_text())
    current = {k: v for k, v in prepared.items() if k != 'prepared'}
    if record != current:
        raise ValueError('Build inputs changed after preparation; use a new output directory')
    expected = prepared['prepared']
    actual = {'pay': inventory(output / 'pay-source'), 'protocol': inventory(output / 'protocol-source/rust'),
              'node': inventory(output / 'node-runtime'), 'cargoConfigSha256': digest(output / 'cargo-home/config.toml')}
    if expected != actual:
        raise ValueError('Prepared source or runtime changed; refusing cached artifacts')
    return prepared


def sandbox(output, args, record):
    private = [Path.home() / 'Library/Keychains', Path('/Library/Keychains'),
               Path.home() / '.config/pay', Path.home() / '.config/solana',
               Path.home() / '.codex/auth.json', Path.home() / '.codex/config.toml']
    private += [Path.home() / 'Library/Application Support' / name for name in OLD_DIRECTORIES + [NAME]]
    for path in [ROOT, Path.home() / 'Desktop/yosh']:
        private.append(path / '.data')
    text = '(version 1)\n(allow default)\n(deny network*)\n'
    text += '(deny process-exec (literal "/usr/bin/security"))\n(deny mach-lookup (global-name "com.apple.securityd"))\n'
    text += '(deny file-read* file-write* ' + ' '.join('(subpath ' + json.dumps(str(path)) + ')' for path in private) + ')\n'
    for path in [ROOT, args.pay, args.pay_kit, args.cargo_home, Path(record['cargo']['vendor'])]:
        text += '(deny file-write* (subpath ' + json.dumps(str(path)) + '))\n'
        pattern = '^' + re.escape(str(path)) + '/\\.env(\\.[^/]*)?$'
        text += '(deny file-read* (regex #' + json.dumps(pattern) + '))\n'
    text += '(allow file-write* (subpath ' + json.dumps(str(output)) + '))\n'
    path = output / 'build.sb'
    path.write_text(text)
    return path


def runtime_sandboxes(runtime):
    blocked = OLD_DIRECTORIES
    deny = '(deny file-read* file-write* ' + ' '.join(
        '(subpath (string-append (param "REAL_HOME") ' + json.dumps('/Library/Application Support/' + name) + '))'
        for name in blocked) + '\n (subpath (string-append (param "REAL_HOME") "/.config/pay"))\n (subpath (string-append (param "REAL_HOME") "/.config/solana")))\n'
    offline = '(version 1)\n(allow default)\n(deny network*)\n(allow network-bind (local ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))\n'
    offline += '(deny process-exec (literal "/usr/bin/security"))\n(deny mach-lookup (global-name "com.apple.securityd"))\n'
    offline += '(deny file-read* file-write* (subpath (string-append (param "REAL_HOME") "/Library/Keychains")) (subpath "/Library/Keychains"))\n'
    (runtime / 'pay-dev.sb').write_text(offline + deny)
    (runtime / 'pay-dev-simulated.sb').write_text(offline + deny +
        '(deny file-read* file-write* (subpath (string-append (param "REAL_HOME") "/Library/Application Support/' + NAME + '/Devnet")))\n')


def build(args, record):
    output = safe_output(args.output)
    if not output.exists():
        record = prepare(args, record)
    else:
        record = check_prepared(args, record)
    app = output / (NAME + '.app')
    if app.exists():
        raise ValueError('Existing Dev app is preserved; build into a new output directory')
    for directory in ['private-home', 'tmp', 'logs']:
        (output / directory).mkdir(mode=0o700, exist_ok=True)
    node = output / ('node-runtime/node-v' + NODE_VERSION + '-darwin-arm64/bin/node')
    env = {'PATH': str(node.parent) + ':' + os.environ.get('PATH', '/usr/bin:/bin'),
           'HOME': str(output / 'private-home'), 'TMPDIR': str(output / 'tmp'),
           'RUSTUP_HOME': os.environ.get('RUSTUP_HOME', str(Path.home() / '.rustup')),
           'RUSTUP_AUTO_INSTALL': '0', 'CARGO_HOME': str(output / 'cargo-home'),
           'CARGO_TARGET_DIR': str(output / 'rust-target'), 'CARGO_NET_OFFLINE': 'true',
           'CARGO_BUILD_JOBS': '4', 'CI': '1', 'NEXT_TELEMETRY_DISABLED': '1',
           'NODE_DISABLE_COMPILE_CACHE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
           'CLANG_MODULE_CACHE_PATH': str(output / 'clang-cache')}
    policy = sandbox(output, args, record)
    steps = []

    def run(label, command, cwd=ROOT):
        log = output / 'logs' / (label + '.log')
        invocation = ['/usr/bin/sandbox-exec', '-f', str(policy), *map(str, command)]
        print('START ' + label, flush=True)
        with log.open('w') as stream:
            code = subprocess.run(invocation, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT).returncode
        steps.append({'label': label, 'argv': list(map(str, command)), 'exitCode': code, 'logSha256': digest(log)})
        write_json(output / 'build-steps.json', steps)
        if code:
            raise RuntimeError(label + ' failed; inspect ' + str(log))
        print('PASS ' + label, flush=True)

    for label, command in [('node', [node, '--version']), ('cargo', ['cargo', '--version']),
                           ('rustc', ['rustc', '--version']), ('xcode', ['xcodebuild', '-version'])]:
        run('toolchain-' + label, command)
    run('pay-mcp', ['cargo', 'build', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-controlled-mcp'], output / 'pay-source/rust')
    run('protocol-engine', ['cargo', 'build', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-execution-protocol'], output / 'protocol-source/rust')
    run('native-app', ['xcodebuild', '-project', ROOT / 'apps/macos/Yosh/Yosh.xcodeproj', '-scheme', 'Yosh',
        '-configuration', 'Release', '-destination', 'platform=macOS,arch=arm64', '-derivedDataPath', output / 'native',
        '-disableAutomaticPackageResolution', 'ONLY_ACTIVE_ARCH=YES', 'CODE_SIGNING_ALLOWED=NO',
        'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox'])
    shutil.copytree(output / 'native/Build/Products/Release/Yosh.app', app, symlinks=True)
    info_path = app / 'Contents/Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    info.update(CFBundleName=NAME, CFBundleDisplayName=NAME, CFBundleIdentifier=IDENTITY,
                YoshPayDevelopment=True, YoshCodexPluginDevelopment=True)
    for key in ['YoshStableRelease', 'YoshReleaseCandidate', 'YoshCandidateIsolation']:
        info.pop(key, None)
    info_path.write_bytes(plistlib.dumps(info))
    runtime = app / 'Contents/Resources/Runtime'
    (runtime / 'backend/.next').mkdir(parents=True)
    (runtime / 'licenses').mkdir()
    (runtime / 'backend/.next/BUILD_ID').write_text('yosh-codex-plugin-dev\n')
    for entry, target in [('pay-dev-backend.ts', 'backend/server.js'), ('pay-dev-mcp.ts', 'mcp.cjs')]:
        run('bundle-' + Path(entry).stem, [ROOT / 'node_modules/.bin/esbuild', ROOT / 'scripts' / entry,
            '--bundle', '--platform=node', '--target=node24', '--format=cjs', '--define:__YOSH_PLUGIN_DEV__=true', '--outfile=' + str(runtime / target)])
    shutil.copy2(node, app / 'Contents/MacOS/YoshBackendNode')
    (runtime / 'node').symlink_to('../../MacOS/YoshBackendNode')
    for source, target in [('yosh-controlled-mcp', 'pay-mcp'), ('yosh-execution-protocol', 'pay-protocol-engine')]:
        shutil.copy2(output / 'rust-target/debug' / source, runtime / target)
    for source, target in [(node.parent.parent / 'LICENSE', 'Node-LICENSE'), (args.pay / 'LICENSE', 'Pay-LICENSE'),
                            (args.pay_kit / 'LICENSE', 'pay-kit-LICENSE')]:
        shutil.copy2(source, runtime / 'licenses' / target)
    runtime_sandboxes(runtime)
    write_json(runtime / 'codex-plugin-dev-source-manifest.json', record)
    for target in [app / 'Contents/MacOS/YoshBackendNode', runtime / 'pay-mcp', runtime / 'pay-protocol-engine', app]:
        run('sign-' + target.name, ['codesign', '--force', '--sign', '-', target])
    run('verify-signature', ['codesign', '--verify', '--deep', '--strict', app])
    # No executable is accepted merely because it existed in a cache. Both Rust
    # binaries above were compiled from the recorded, overlaid source snapshot.
    current = inputs(args)
    check_prepared(args, current)
    artifact = {'schemaVersion': 1, 'kind': 'codex-plugin-dev', 'productionEnabled': False,
                'sourceManifestSha256': digest(runtime / 'codex-plugin-dev-source-manifest.json'),
                'buildStepsSha256': digest(output / 'build-steps.json'), 'files': inventory(app)}
    write_json(output / 'dev-artifact.json', artifact)
    print('Built uninstalled Dev app: ' + str(app), flush=True)


def verify(output):
    output = safe_output(output)
    app = output / (NAME + '.app')
    artifact = json.loads((output / 'dev-artifact.json').read_text())
    runtime = app / 'Contents/Resources/Runtime'
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if artifact.get('kind') != 'codex-plugin-dev' or artifact.get('productionEnabled') is not False \
            or info.get('CFBundleIdentifier') != IDENTITY or info.get('YoshCodexPluginDevelopment') is not True \
            or info.get('YoshPayDevelopment') is not True or info.get('YoshStableRelease'):
        raise ValueError('Dev identity mismatch')
    if artifact['files'] != inventory(app) \
            or artifact['sourceManifestSha256'] != digest(runtime / 'codex-plugin-dev-source-manifest.json') \
            or artifact['buildStepsSha256'] != digest(output / 'build-steps.json'):
        raise ValueError('Dev artifact bytes changed')
    subprocess.run(['codesign', '--verify', '--deep', '--strict', app], check=True)
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'check', 'build', 'verify'])
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--pay', type=Path)
    parser.add_argument('--pay-kit', type=Path)
    parser.add_argument('--cargo-home', type=Path)
    parser.add_argument('--node-archive', type=Path)
    args = parser.parse_args()
    args.output = safe_output(args.output)
    if args.action == 'verify':
        print('Verified: ' + str(verify(args.output)))
        return
    for name in ['pay', 'pay_kit', 'cargo_home', 'node_archive']:
        value = getattr(args, name)
        if value is None:
            parser.error('--' + name.replace('_', '-') + ' is required')
        setattr(args, name, value.resolve(strict=True))
    record = inputs(args)
    if args.action == 'prepare':
        prepare(args, record)
        print('Prepared verified inputs: ' + str(args.output))
    elif args.action == 'check':
        if args.output.exists():
            check_prepared(args, record)
        print('Checked approved Yosh/Pay/pay-kit, current overlays, locked npm, offline Cargo and Node ' + NODE_VERSION)
    else:
        build(args, record)


if __name__ == '__main__':
    main()
