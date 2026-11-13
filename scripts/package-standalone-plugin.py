#!/usr/bin/env python3
"""Package a verified standalone Offline runtime as a relocatable local plugin.

Creates a separate marketplace/ZIP. Never registers it in the user's Codex home.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = 'yosh-standalone-dev'
MAINNET_FILES = ['node', 'mainnet.cjs', 'mainnet-mcp.cjs', 'pay-mcp', 'pay-protocol-engine', 'mainnet.sb']
LICENSE_FILES = ['Node-LICENSE', 'Pay-LICENSE', 'pay-kit-LICENSE']


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_mainnet(runtime):
    manifest = json.loads((runtime / 'mainnet-manifest.json').read_text())
    if manifest.get('kind') != 'yosh-mainnet-standalone' or manifest.get('apiVersion') != 1 \
            or manifest.get('dataContract') != 'existing-mainnet-v1' \
            or manifest.get('profile') != 'com.yosh.pay-development.v011rc5' \
            or manifest.get('productionEnabled') is not False \
            or set(manifest.get('files', {})) != set(MAINNET_FILES) \
            or set(manifest.get('licenses', {})) != set(LICENSE_FILES):
        raise ValueError('Mainnet runtime contract mismatch')
    for name, digest in manifest['files'].items():
        file = runtime / name
        if file.is_symlink() or not file.is_file() or sha(file) != digest:
            raise ValueError('Mainnet runtime integrity mismatch')
    for name, digest in manifest['licenses'].items():
        file = runtime / 'licenses' / name
        if file.is_symlink() or not file.is_file() or sha(file) != digest:
            raise ValueError('Mainnet runtime license mismatch')


def verify_runtime(package):
    runtime = package / 'runtime'
    manifest = json.loads((runtime / 'manifest.json').read_text())
    local = manifest.get('kind') == 'yosh-local-devnet'
    if manifest.get('productionEnabled') is not False or (local and (manifest.get('apiVersion') != 2 or manifest.get('dataContract') != 'local-devnet-v1')) \
            or (not local and (manifest.get('kind') != 'yosh-standalone-offline-dev' or manifest.get('apiVersion') != 1 or manifest.get('dataContract') != 'standalone-offline-v1')):
        raise ValueError('Verified local Devnet package required' if local else 'Standalone Offline package required')
    required = ['node', 'standalone.cjs', 'mcp.cjs', 'pay-mcp', 'pay-protocol-engine', 'offline.sb']
    standalone_mainnet = manifest.get('mainnetStandalone') is True
    if standalone_mainnet:
        if not local or manifest.get('mainnetBridge'):
            raise ValueError('Mainnet runtime cannot use the App bridge')
        required += ['mainnet.cjs', 'mainnet-mcp.cjs', 'mainnet-manifest.json', 'mainnet.sb']
    if local and manifest.get('mainnetBridge'): required += ['mainnet-launch.mjs', 'mainnet-launch.sh']
    if local: required += ['local-mcp.cjs', 'yosh-confirm', 'spirit-design-sheet.png', 'instrument-serif.woff2', 'Instrument-Serif-OFL.txt']
    if set(manifest['files']) != set(required): raise ValueError('Unexpected runtime file')
    for name in required:
        if name not in manifest['files']: raise ValueError('Incomplete runtime manifest')
    for name, digest in manifest['files'].items():
        if Path(name).name != name or (runtime / name).is_symlink() or sha(runtime / name) != digest:
            raise ValueError('Runtime integrity mismatch')
    if not (package / 'yosh-dev').is_file() or (package / 'yosh-dev').is_symlink(): raise ValueError('Launcher required')
    for name in LICENSE_FILES:
        file = runtime / 'licenses' / name
        if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(runtime.resolve()):
            raise ValueError('License path rejected')
    if standalone_mainnet: verify_mainnet(runtime)
    return manifest


def package(source, output):
    manifest = verify_runtime(source)
    local = manifest['kind'] == 'yosh-local-devnet'
    standalone_mainnet = manifest.get('mainnetStandalone') is True
    version = '0.2.4' if standalone_mainnet else '0.2.3' if local else '0.1.0'
    plugin_name = 'yosh-local-dev' if local else NAME
    output = output.absolute()
    if not output.resolve().is_relative_to((ROOT / 'build.noindex').resolve()) or output.is_symlink():
        raise ValueError('New private build output required')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    marketplace = output / 'marketplace'
    plugin = marketplace / 'plugins' / plugin_name
    plugin.mkdir(mode=0o700, parents=True)
    # Whitelist product files; never ship test state, logs, source checkout,
    # build provenance containing workstation paths, or Keychain probe files.
    (plugin / 'runtime').mkdir()
    for name in [*manifest['files'], 'manifest.json']:
        shutil.copy2(source / 'runtime' / name, plugin / 'runtime' / name)
    (plugin / 'runtime/licenses').mkdir()
    for name in LICENSE_FILES:
        shutil.copy2(source / 'runtime/licenses' / name, plugin / 'runtime/licenses' / name)
    shutil.copy2(source / 'yosh-dev', plugin / 'yosh-dev')
    (plugin / 'scripts').mkdir(); (plugin / 'assets').mkdir(); (plugin / '.codex-plugin').mkdir()
    shutil.copy2(ROOT / 'plugins/yosh-dev/assets/icon.png', plugin / 'assets/icon.png')
    (plugin / 'scripts/launch.sh').write_text('''#!/bin/sh
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
if [ -n "${YOSH_STANDALONE_DEV_DATA_DIR:-}" ]; then
  exec "$root/yosh-dev" install-mcp --data-dir "$YOSH_STANDALONE_DEV_DATA_DIR"
fi
exec "$root/yosh-dev" install-mcp
''')
    (plugin / 'scripts/launch.sh').chmod(0o755)
    interface = {'displayName': 'Yosh Standalone Dev — 免 App 测试版',
        'shortDescription': 'Run the isolated Yosh Offline backend without the App.',
        'longDescription': 'Includes the local Offline test backend and Pay MCP. No Yosh App installation is required. '
                           'Starts paused without a Grant. Real wallets, trusted web authorization and real payments are not enabled.',
        'developerName': 'Yosh', 'category': 'Developer tools', 'capabilities': ['Read', 'Write'],
        'brandColor': '#6582AA', 'composerIcon': './assets/icon.png', 'logo': './assets/icon.png',
        'defaultPrompt': ['Check the Yosh standalone Offline backend connection and pause state.']}
    if local:
        interface.update({'displayName': 'Yosh Dev — 开发验收版', 'shortDescription': '统一的开发验收入口；可选择主网或测试网。',
          'longDescription': 'One Yosh Dev plugin for all development and acceptance. Choose Mainnet or Devnet explicitly. Mainnet reuses the original App wallet and backend with real funds; Devnet has isolated test funds. Authorization requires user confirmation.',
          'defaultPrompt': ['Open Yosh local settings and check setup status.']})
        if standalone_mainnet:
            interface['longDescription'] = 'One Yosh Dev plugin for all development and acceptance. Choose Mainnet or Devnet explicitly. Mainnet uses a bundled standalone backend with the existing wallet, Grants and ledger; Yosh.app does not need to run. Devnet has isolated test funds. Authorization requires user confirmation.'
        skill = plugin / 'skills/connect-local-yosh'; skill.mkdir(parents=True)
        skill_content = '---\nname: connect-local-yosh\ndescription: Open the local Yosh setup page and check pairing without granting spending authority.\n---\n\nUse only this Yosh Dev plugin for development and acceptance; do not create separate Mainnet or Devnet plugins. Every wallet/API/purchase tool call must specify environment: mainnet or devnet. Never silently switch networks. Mainnet uses real funds and requires specific purchase authorization. Prefer get_spending_status for the original Yosh wallet balance. For Mainnet call open_local_settings with environment: mainnet; for Devnet use environment: devnet. Without a network the page waits for explicit selection before reading state. Give the user the returned local link. The user confirms exact changes in the native system window. Never manufacture consent or modify data files. After the user finishes, call local_setup_status to refresh Pay tools. If the host does not refresh tools, explain that reconnecting this Dev plugin is required. The Grant page offers Mainnet or Devnet. Mainnet requires the original backend with the web authorization bridge; it does not migrate the wallet or start a second mainnet service. Wallet creation remains isolated Devnet only. A Grant is created only after the user confirms its exact network, API, amounts and expiry. Do not fund or buy unless separately requested. Unknown payments keep the original purchase ID; recover_payment may execute the original payment and is not a read-only query.\n'
        if standalone_mainnet:
            skill_content = skill_content.replace('Mainnet requires the original backend with the web authorization bridge; it does not migrate the wallet or start a second mainnet service.', 'Mainnet uses the bundled standalone backend with the original wallet, Grants and ledger; no Yosh App is required. The backend verifies exclusive ownership and never migrates the wallet or starts a second service for the same ledger.')
        (skill / 'SKILL.md').write_text(skill_content)
    portable = {'$schema': 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
                'name': plugin_name, 'version': version, 'description': 'Unified Yosh development plugin with local settings and explicit Mainnet/Devnet routing.' if local else 'App-free isolated Yosh Offline development runtime.',
                'extensions': {'com.openai': {'interface': interface, 'requires_local_executor': True}}}
    compatibility = {'name': plugin_name, 'version': version, 'description': portable['description'],
                     'mcpServers': './.mcp.json', 'interface': interface, 'requires_local_executor': True}
    mcp = {'$schema': 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
           'mcpServers': {'yosh_standalone': {'type': 'stdio', 'command': 'bash',
            'args': ['${PLUGIN_ROOT}/scripts/launch.sh'], 'cwd': '${PLUGIN_ROOT}'}}}
    for path, data in [('plugin.json', portable), ('.codex-plugin/plugin.json', compatibility), ('mcp.json', mcp), ('.mcp.json', mcp)]:
        (plugin / path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    catalog = marketplace / '.agents/plugins'; catalog.mkdir(parents=True)
    (catalog / 'marketplace.json').write_text(json.dumps({'name': 'yosh-standalone-testing',
        'interface': {'displayName': 'Yosh Standalone Testing'}, 'plugins': [{'name': plugin_name,
            'source': {'source': 'local', 'path': './plugins/' + plugin_name},
            'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'}, 'category': 'Developer tools'}]}, indent=2) + '\n')
    archive = output / (plugin_name + '.zip')
    files = {}
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(marketplace.rglob('*')):
            if path.is_symlink(): raise ValueError('Plugin symlink rejected')
            if not path.is_file(): continue
            relative = path.relative_to(marketplace).as_posix()
            files[relative] = sha(path)
            entry = zipfile.ZipInfo('yosh-standalone-marketplace/' + relative, date_time=(1980, 1, 1, 0, 0, 0))
            entry.external_attr = (stat.S_IFREG | (path.stat().st_mode & 0o777)) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            bundle.writestr(entry, path.read_bytes())
    (output / 'package-evidence.json').write_text(json.dumps({'name': plugin_name, 'requiresApp': 'mainnet-only' if local and manifest.get('mainnetBridge') else False, 'realFunds': bool(local and (manifest.get('mainnetBridge') or standalone_mainnet)),
        'runtimeDigest': sha(source / 'runtime/manifest.json'), 'files': files, 'zipSha256': sha(archive),
        'zipBytes': archive.stat().st_size, 'signing': 'local-development-not-notarized'}, indent=2) + '\n')
    print('Standalone plugin: ' + str(archive))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-package', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    package(args.runtime_package.resolve(strict=True), args.output)
