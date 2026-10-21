"""Build the opt-in Rust helper from explicit, preserved forks without changing them.

No dependency resolution, signing, wallet or network operation is performed.
All copied sources, build artifacts and Cargo home live under build.noindex.
"""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--archive', required=True, type=pathlib.Path)
parser.add_argument('--test', action='store_true', help='run the wrapper unit tests too')
options = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
archive = options.archive.resolve(strict=True)
output = root / 'build.noindex/pay-protocol-engine'
output.mkdir(parents=True, exist_ok=True)
os.chmod(output, 0o700)

# Verify every source/dependency file consumed, against the preserved manifest.
manifest = dict(line.split('  ', 1)[::-1] for line in (archive / 'SHA256SUMS').read_text().splitlines())
source_roots = ['sources/pay/rust', 'sources/pay-kit/rust', 'vendor/rust']
for source_root in source_roots:
    for path in (archive / source_root).rglob('*'):
        if not path.is_file():
            continue
        if path.is_symlink():
            raise SystemExit('BLOCKED: symlink in preserved dependency source')
        relative = path.relative_to(archive).as_posix()
        if hashlib.sha256(path.read_bytes()).hexdigest() != manifest.get(relative):
            raise SystemExit(f'BLOCKED: preserved source identity mismatch: {relative}')

for source_name in ['pay', 'pay-kit']:
    destination = output / 'sources' / source_name / 'rust'
    shutil.copytree(archive / 'sources' / source_name / 'rust', destination, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('*.ts', '*.tsx', 'node_modules', 'target'))
# Remove only older generated example files copied by an earlier builder version;
# TypeScript must not discover dependency examples as part of Yosh's own sources.
for pattern in ['*.ts', '*.tsx']:
    for path in (output / 'sources').rglob(pattern):
        path.unlink()

workspace = output / 'sources/pay/rust'
wrapper = root / 'integration/pay-protocol-engine/main.rs'
destination = workspace / 'crates/mcp/src/bin/yosh-execution-protocol.rs'
shutil.copy2(wrapper, destination)
vendor = output / 'vendor/rust'
vendor.parent.mkdir(exist_ok=True)
if not vendor.exists():
    vendor.symlink_to(archive / 'vendor/rust', target_is_directory=True)
elif vendor.resolve() != archive / 'vendor/rust':
    raise SystemExit('BLOCKED: local vendor source does not match explicit archive')

home = output / 'isolated-home'
home.mkdir(exist_ok=True)
os.chmod(home, 0o700)
profile = output / 'build.sb'
if not pathlib.Path('/usr/bin/sandbox-exec').is_file():
    raise SystemExit('BLOCKED: this isolated build requires macOS sandbox-exec')
def quoted(path):
    return json.dumps(str(path))
profile.write_text('(version 1)\n(allow default)\n(deny network*)\n'
    '(deny process-exec (literal "/usr/bin/security"))\n'
    f'(deny file-read* file-write* (subpath {quoted(pathlib.Path.home() / "Library/Keychains")}) '
    f'(subpath {quoted(pathlib.Path.home() / "Library/Application Support/Yosh")}) '
    f'(subpath {quoted(pathlib.Path.home() / "Library/Application Support/2049")}) '
    f'(subpath {quoted(pathlib.Path.home() / ".config/solana")}) '
    f'(subpath {quoted(pathlib.Path.home() / ".config/pay")}) '
    '(subpath "/Users/irin/Desktop/yosh/.data") '
    '(subpath "/Users/irin/Desktop/open-source/pay"))\n'
    f'(deny file-write* (subpath {quoted(archive)}))\n')
environment = {
    'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
    'HOME': str(home),
    'RUSTUP_HOME': os.environ.get('RUSTUP_HOME', str(pathlib.Path.home() / '.rustup')),
    'CARGO_HOME': str(home / 'cargo'),
    'CARGO_TARGET_DIR': str(output / 'target'),
    'CARGO_NET_OFFLINE': 'true',
}
commands = [['cargo', 'build', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-execution-protocol']]
if options.test:
    commands.append(['cargo', 'test', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-execution-protocol'])
for command in commands:
    subprocess.run(['/usr/bin/sandbox-exec', '-f', str(profile), *command], cwd=workspace, env=environment, check=True)
binary = output / 'yosh-execution-protocol'
shutil.copy2(output / 'target/debug/yosh-execution-protocol', binary)
(output / 'provenance.json').write_text(json.dumps({
    'archive': str(archive),
    'archiveManifestSha256': hashlib.sha256((archive / 'SHA256SUMS').read_bytes()).hexdigest(),
    'payBase': 'df57843e1f728fcc8ff8e42db78e0ad99372cd9d',
    'payKitBase': 'f8ef055b1d1c8ca8245f19bbca819faed9cfa058',
    'source': str(wrapper.relative_to(root)),
    'wrapperSha256': hashlib.sha256(wrapper.read_bytes()).hexdigest(),
    'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
    'commands': commands,
    'offline': True,
}, indent=2) + '\n')
print(binary)
