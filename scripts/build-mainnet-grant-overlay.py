#!/usr/bin/env python3
"""Build a minimal backend candidate from HEAD, excluding unrelated Dev work.
Does not install, launch a backend, open user data or alter the native App.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import shutil
import re

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', default='build.noindex/mainnet-grant-minimal-20261111')
parser.add_argument('--baseline-source', type=Path, required=True)
parser.add_argument('--installed-app', type=Path, required=True)
args = parser.parse_args()
OUT = (ROOT / args.output).resolve()
if not OUT.is_relative_to((ROOT / 'build.noindex').resolve()): raise ValueError('Build directory required')

def current(name): return (ROOT / name).read_text()
def block(text, start, end):
    assert text.count(start) == 1 and text.count(end) == 1
    return text[text.index(start):text.index(end)]
def replace(text, old, new):
    assert text.count(old) == 1, old[:80]
    return text.replace(old, new, 1)
def write(name, text):
    file = OUT / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_text(text)

# Reproduce the installed backend before adding the bounded Grant interface.
# HEAD may contain other unreleased changes and is not an installed baseline.
shutil.copytree(args.baseline_source, OUT, ignore=shutil.ignore_patterns('node_modules', 'baseline.js', 'installed.diff'))
(OUT / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
def compile_backend(target):
    subprocess.run(['node', str(ROOT / 'node_modules/esbuild/bin/esbuild'), 'scripts/pay-dev-backend.ts', '--bundle', '--platform=node', '--target=node24', '--format=cjs', '--define:__YOSH_RC5__=true', '--minify-syntax', '--outfile=' + str(target)], cwd=OUT, check=True)
def normalized_bundle(value):
    return re.sub(r'^(// |  ")(?:[^\n"]*/)?(node_modules/|src/|scripts/)', r'\1\2', value, flags=re.M)
compile_backend(OUT / 'baseline.js')
installed_backend = args.installed_app / 'Contents/Resources/Runtime/backend/server.js'
if normalized_bundle((OUT / 'baseline.js').read_text()) != normalized_bundle(installed_backend.read_text()):
    raise ValueError('Baseline does not reproduce the installed backend')
baseline_hash = hashlib.sha256(installed_backend.read_bytes()).hexdigest()
for name in ['src/modules/authority/local-grant-approval.ts', 'src/modules/authority/mainnet-local-grants.ts']:
    write(name, current(name))
name = 'src/modules/app/app-runtime.ts'
s = (OUT / name).read_text()
s = "import type { LocalGrantConfirmation } from '../authority/local-grant-approval';\n" + s
methods = block(current(name), '  localGrantEnvironment():', '  createSpendGrant(raw:')
methods = methods.replace('this.registeredLive', 'this.environment.isProduction')
methods = replace(methods, '    return this.localAuthorizationEnvironment();', "    throw new Error('LOCAL_WEB_ENVIRONMENT_UNAVAILABLE');")
methods = methods.replace('this.registeredResource(resourceId)', 'this.activeResourceDefinitions().find(item => item.resourceId === resourceId)').replace('this.registeredResource(frozen.request.binding.scope.resourceId)', 'this.activeResourceDefinitions().find(item => item.resourceId === frozen.request.binding.scope.resourceId)')
s = replace(s, '  createSpendGrant(raw:', methods + '  createSpendGrant(raw:')
s = replace(s, 'createSpendGrant(raw: unknown, memberId = this.ledger.defaultCardMember().id)', 'createSpendGrant(raw: unknown, memberId = this.ledger.defaultCardMember().id, confirmation?: LocalGrantConfirmation)')
check = block(current(name), '      if (confirmation) {\n        const frozen', '      return this.ledger.createSpendGrant(input, principal, {')
s = replace(s, '      return this.ledger.createSpendGrant(input, principal, {', check + '      return this.ledger.createSpendGrant(input, principal, {')
s = replace(s, '      }, now, mode);', '      }, confirmation ? (this.dependencies.now?.() ?? Date.now()) : now, mode, confirmation);')
write(name, s)
name = 'src/modules/purchases/purchase-ledger.ts'
s = (OUT / name).read_text()
s = "import { LocalGrantApprovals, type LocalGrantConfirmation } from '../authority/local-grant-approval';\n" + s
s = replace(s, 'export class PurchaseLedger {', '''export class PurchaseLedger {
  private localApprovals?: LocalGrantApprovals;
  localGrantApprovals() { return this.localApprovals ??= new LocalGrantApprovals(this.db); }''')
start, end = '  createSpendGrant(raw:', '  revokeActiveSpendGrant('
s = replace(s, block(s, start, end), block(current(name), start, '  revokeActiveSpendGrant('))
write(name, s)
name = 'src/modules/pay-dev/management-server.ts'
s = (OUT / name).read_text()
s = "import { mainnetLocalGrants } from '../authority/mainnet-local-grants';\n" + s
s = replace(s, 'const routes = new Map<string, Handler>([', "const routes = new Map<string, Handler>([\n    ['POST /api/app/local-grants', request => mainnetLocalGrants(request, app)],")
write(name, s)
# Include the same current compatibility tests, omitting only the unified-web
# harness: that controller is delivered in the separate plugin package.
name = 'tests/unit/mainnet-product-entry.test.ts'
s = current(name).replace("import { startLocalAuthorization } from '../../src/modules/authority/local-authorization-server';\n", '')
s = s[:s.index("it('routes mainnet web requests through trusted confirmation")]
s = s.replace('const browserFetch = globalThis.fetch;\n', '')
write(name, s)
# The installed Grant hotfix superseded the historical operator-receipt tests.
write('tests/integration/pay-mainnet-controlled.test.ts', current('tests/integration/pay-mainnet-controlled.test.ts'))
subprocess.run(['node', str(ROOT / 'node_modules/esbuild/bin/esbuild'), str(OUT / 'scripts/pay-dev-backend.ts'), '--bundle', '--platform=node', '--target=node24', '--format=cjs', '--define:__YOSH_RC5__=true', '--minify-syntax', '--outfile=' + str(OUT / 'candidate/server.js')], cwd=OUT, check=True)
changed = ['src/modules/authority/local-grant-approval.ts', 'src/modules/authority/mainnet-local-grants.ts', 'src/modules/app/app-runtime.ts', 'src/modules/purchases/purchase-ledger.ts', 'src/modules/pay-dev/management-server.ts']
(OUT / 'candidate/provenance.json').write_text(json.dumps({'baseBackendSha256':baseline_hash,'baselineReproduced':True,'base':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'overlay':{name:hashlib.sha256((OUT/name).read_bytes()).hexdigest() for name in changed},'installed':False},indent=2)+'\n')
print(OUT)
