#!/usr/bin/env python3
"""Build the MPP protocol-only helper from pinned Git objects, without networking.

Donor checkouts/vendor/cache are read-only inputs. Every build uses a fresh output
directory and records source inventories and executable hashes, including when
an explicit compiler cache is cloned to save recompilation.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
PAY = '402f67c44dd8d41d7d1584fcb5d868006ce8c891'
KIT = '7f1369180ca4b047aadff1bea77aed4525e10039'
KEYCHAIN = '44b479df245167ca3b3a4e04d6d907146306d342'


def git(path, *args):
    return subprocess.check_output(['git', *args], cwd=path)


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(path):
    files = {}
    for candidate in sorted(path.rglob('*')):
        if candidate.is_symlink():
            raise ValueError('Source symlinks are not accepted')
        if candidate.is_file():
            files[candidate.relative_to(path).as_posix()] = sha(candidate)
    return files


def build(args):
    output = args.output.absolute()
    base = ROOT / 'build.noindex'
    if output.exists() or output == base or not output.resolve().is_relative_to(base.resolve()):
        raise ValueError('Use a fresh child directory of this checkout/build.noindex')
    if any(parent.is_symlink() for parent in [output, *output.parents] if parent.is_relative_to(ROOT)):
        raise ValueError('Build output cannot traverse a symlink')
    manifest = git(args.pay, 'show', PAY + ':rust/Cargo.toml').decode()
    if f'rev = "{KIT}"' not in manifest:
        raise ValueError('Pay does not pin the expected kit revision')
    # Git objects, not checkout HEAD or a version string, identify the kit source.
    kit_prefix = 'rust/crates/kit/src/'
    names = git(args.pay_kit, 'ls-tree', '-r', '--name-only', KIT, kit_prefix).decode().splitlines()
    expected = {name.removeprefix(kit_prefix): hashlib.sha256(git(args.pay_kit, 'show', KIT + ':' + name)).hexdigest() for name in names}
    if not expected or inventory(args.vendor / 'solana-pay-kit/src') != expected:
        raise ValueError('Vendored kit differs from the pinned Git source')
    vendor_files = inventory(args.vendor)
    output.mkdir(parents=True, mode=0o700)
    source = output / 'pay'
    source.mkdir()
    archive = git(args.pay, 'archive', PAY, 'rust')
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar.getmembers():
            if member.isdev() or member.issym() or member.islnk() or not (source / member.name).resolve().is_relative_to(source):
                raise ValueError('Unsafe source archive member')
        tar.extractall(source)
    wrapper = ROOT / 'integration/pay-protocol-engine/main.rs'
    destination = source / 'rust/crates/mcp/src/bin/yosh-execution-protocol.rs'
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(wrapper, destination)
    cargo = output / 'cargo-home'
    cargo.mkdir(mode=0o700)
    (cargo / 'config.toml').write_text(
        '[source.crates-io]\nreplace-with = "vendored-sources"\n'
        '[source.vendored-sources]\ndirectory = ' + json.dumps(str(args.vendor)) + '\n'
        '[source.pay-kit]\ngit = "https://github.com/Niri7981/pay-kit.git"\nrev = "' + KIT + '"\nreplace-with = "vendored-sources"\n'
        '[source.solana-keychain]\ngit = "https://github.com/solana-foundation/solana-keychain"\nrev = "' + KEYCHAIN + '"\nreplace-with = "vendored-sources"\n')
    target = output / 'rust-target'
    if args.target_cache:
        # APFS cloning preserves donor bytes; Cargo must still build the target.
        subprocess.run(['/bin/cp', '-cR', str(args.target_cache), str(target)], check=True)
    profile = output / 'build.sb'
    read_only = [args.pay, args.pay_kit, args.vendor]
    if args.target_cache:
        read_only.append(args.target_cache)
    private = [Path.home() / 'Library/Keychains', Path.home() / '.config/solana', Path.home() / '.config/pay',
               Path.home() / 'Library/Application Support/Yosh', ROOT / '.data']
    profile.write_text('(version 1)\n(allow default)\n(deny network*)\n'
        '(deny process-exec (literal "/usr/bin/security"))\n'
        '(deny file-read* file-write* ' + ' '.join('(subpath ' + json.dumps(str(path)) + ')' for path in private) + ')\n'
        '(deny file-write* ' + ' '.join('(subpath ' + json.dumps(str(path)) + ')' for path in read_only) + ')\n')
    source_files = inventory(source)
    env = {key: value for key, value in os.environ.items() if key in ['PATH', 'RUSTUP_HOME', 'SDKROOT', 'DEVELOPER_DIR']}
    env.update({'CARGO_HOME': str(cargo), 'CARGO_TARGET_DIR': str(target), 'CARGO_NET_OFFLINE': 'true', 'RUSTUP_AUTO_INSTALL': '0'})
    # A cached executable is never an accepted output. Keep dependency objects,
    # but force the protocol wrapper package to compile and link from this source.
    commands = [['cargo', 'clean', '--offline', '--locked', '-p', 'pay-mcp'],
                ['cargo', 'build', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-execution-protocol']]
    if args.test:
        commands.append(['cargo', 'test', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-execution-protocol'])
    for command in commands:
        subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile), *command], cwd=source / 'rust', env=env, check=True)
    if inventory(source) != source_files or inventory(args.vendor) != vendor_files:
        raise ValueError('Source input changed during build')
    binary = output / 'yosh-execution-protocol'
    shutil.copy2(target / 'debug/yosh-execution-protocol', binary)
    (output / 'source-lock.json').write_text(json.dumps({
        'schemaVersion': 1, 'kind': 'mpp-protocol-only', 'networkDenied': True,
        'builderSha256': sha(Path(__file__)),
        'payRevision': PAY, 'payTree': git(args.pay, 'rev-parse', PAY + '^{tree}').decode().strip(),
        'payKitRevision': KIT, 'wrapperSha256': sha(wrapper), 'cargoLockSha256': sha(source / 'rust/Cargo.lock'),
        'sourceFiles': source_files, 'vendorFiles': vendor_files, 'commands': commands,
        'binarySha256': sha(binary), 'signerUsed': False, 'paymentSent': False,
    }, indent=2, sort_keys=True) + '\n')
    print(binary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['pay', 'pay-kit', 'vendor']:
        parser.add_argument('--' + name, required=True, type=lambda value: Path(value).resolve(strict=True))
    parser.add_argument('--output', type=Path, default=ROOT / 'build.noindex/mpp-protocol-engine')
    parser.add_argument('--target-cache', type=lambda value: Path(value).resolve(strict=True))
    parser.add_argument('--test', action='store_true')
    build(parser.parse_args())
