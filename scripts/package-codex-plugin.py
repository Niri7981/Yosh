#!/usr/bin/env python3
"""Build a relocatable Yosh Dev plugin ZIP without app/user state or credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'plugins/yosh-dev'


def package(output, mainnet=False):
    plugin = ROOT / 'plugins/yosh-mainnet' if mainnet else PLUGIN
    name = 'yosh-mainnet' if mainnet else 'yosh-dev'
    manifest = json.loads((plugin / 'plugin.json').read_text())
    compatibility = json.loads((plugin / '.codex-plugin/plugin.json').read_text())
    if manifest['name'] != name or compatibility['name'] != manifest['name'] or compatibility['version'] != manifest['version']:
        raise ValueError('Plugin identity mismatch')
    servers = json.loads((plugin / 'mcp.json').read_text())['mcpServers']
    for server in servers.values():
        # Portable stdio uses its own strict schema, not Codex config.toml.
        # Invalid fields make a plugin appear installed with no MCP tools.
        if set(server) - {'type', 'command', 'args', 'env', 'cwd'} or server.get('type') != 'stdio':
            raise ValueError('Unsupported portable MCP configuration')
        command = server.get('command', '')
        if not command or command.startswith('/') or ('/' in command and not command.startswith('./')):
            raise ValueError('Portable MCP command must be a bare executable or contained relative path')
    if output.is_symlink() or not output.resolve().is_relative_to((ROOT / 'build.noindex').resolve()):
        raise ValueError('Plugin output must stay in this checkout/build.noindex')
    files = {}
    for path in sorted(plugin.rglob('*')):
        relative = path.relative_to(plugin)
        if path.is_symlink():
            raise ValueError('Plugin package cannot include symlinks: ' + str(relative))
        if not path.is_file():
            continue
        if path.name.startswith('.env') or path.suffix in ['.sqlite', '.key', '.pem'] or '__pycache__' in relative.parts:
            raise ValueError('Private or generated state cannot enter the plugin')
        files[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for relative in files:
            path = plugin / relative
            entry = zipfile.ZipInfo(name + '/' + relative, date_time=(1980, 1, 1, 0, 0, 0))
            entry.external_attr = (stat.S_IFREG | (path.stat().st_mode & 0o777)) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, path.read_bytes())
    record = {'schemaVersion': 1, 'name': manifest['name'], 'version': manifest['version'],
              'requiresApp': 'com.yosh.pay-development.v011rc5' if mainnet else 'com.yosh.codex-plugin-dev',
              'environments': ['mainnet'] if mainnet else ['offline', 'simulated'],
              'realFunds': mainnet, 'files': files, 'zipSha256': hashlib.sha256(output.read_bytes()).hexdigest()}
    output.with_suffix('.manifest.json').write_text(json.dumps(record, indent=2, sort_keys=True) + '\n')
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mainnet', action='store_true', help='Package the existing App authority bridge, never the Dev backend')
    parser.add_argument('--output', type=Path, default=ROOT / 'build.noindex/codex-plugin-package/yosh-dev.zip')
    args = parser.parse_args()
    print(package(args.output, mainnet=args.mainnet))
