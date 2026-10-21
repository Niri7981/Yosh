"""Package the already-built candidate without installing, launching or accessing user data."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
output = root / 'build.noindex/mainnet-execution-delivery'
app = output / 'Yosh.app'
native = root / 'build.noindex/mainnet-execution-native/Build/Products/Release/Yosh.app'
if app.exists():
    raise SystemExit('Candidate already exists; preserve it and select a new staging directory explicitly.')
output.mkdir(parents=True, exist_ok=True)
subprocess.run(['xcodebuild', '-project', str(root / 'apps/macos/Yosh/Yosh.xcodeproj'), '-scheme', 'Yosh',
    '-configuration', 'Release', '-destination', 'platform=macOS,arch=arm64', '-derivedDataPath', str(root / 'build.noindex/mainnet-execution-native'),
    'ONLY_ACTIVE_ARCH=YES', 'CODE_SIGNING_ALLOWED=NO', 'build'], stdout=(output / 'native-build.log').open('w'), stderr=subprocess.STDOUT, check=True)
shutil.copytree(native, app, symlinks=True)
runtime = app / 'Contents/Resources/Runtime'
backend = runtime / 'backend'
backend.mkdir(parents=True, exist_ok=True)
standalone = root / '.next/standalone'
for name in ['server.js', 'package.json']:
    shutil.copy2(standalone / name, backend / name)
for name in ['node_modules', '.next']:
    shutil.copytree(standalone / name, backend / name, symlinks=True)
shutil.copytree(root / '.next/static', backend / '.next/static', symlinks=True, dirs_exist_ok=True)
if (root / 'public').is_dir():
    shutil.copytree(root / 'public', backend / 'public', symlinks=True)
node = root / 'build.noindex/node-runtime/node-v24.21.0-darwin-arm64/bin/node'
if not node.is_file():
    raise SystemExit('Verified bundled Node runtime is missing; no external runtime fallback.')
shutil.copy2(node, app / 'Contents/MacOS/YoshBackendNode')
shutil.copy2(root / 'build.noindex/pay-mcp-target/debug/yosh-controlled-mcp', runtime / 'pay-mcp')
subprocess.run([str(root / 'node_modules/.bin/esbuild'), str(root / 'scripts/pay-dev-mcp.ts'), '--bundle', '--platform=node',
    '--target=node24', '--format=cjs', "--banner:js=process.env.YOSH_PAY_MCP_MAINNET='1';", '--outfile=' + str(runtime / 'mcp.cjs')], check=True)
for name in ['prepare-pay-mainnet-cutover', 'confirm-pay-mainnet']:
    subprocess.run([str(root / 'node_modules/.bin/esbuild'), str(root / f'scripts/{name}.ts'), '--bundle', '--platform=node',
        '--target=node24', '--format=cjs', '--outfile=' + str(runtime / f'{name}.cjs')], check=True)
for binary in [app / 'Contents/MacOS/YoshBackendNode', runtime / 'pay-mcp', *backend.rglob('*.node')]:
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(binary)], check=True, stdout=subprocess.DEVNULL)
subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(app)], check=True)
subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(app)], check=True)
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
(output / 'manifest.json').write_text(json.dumps({'stagedOnly': True, 'installed': False, 'launched': False,
    'productionEnabled': False, 'requiresCutoverAndOperatorAcceptance': True,
    'paySha256': digest(runtime / 'pay-mcp'), 'mcpSha256': digest(runtime / 'mcp.cjs'),
    'nodeSha256': digest(app / 'Contents/MacOS/YoshBackendNode')}, indent=2) + '\n')
print('Candidate built and signed in build.noindex. Not installed or launched.')
