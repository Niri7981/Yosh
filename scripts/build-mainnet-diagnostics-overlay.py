#!/usr/bin/env python3
"""Stage only payment diagnostics over the reproduced installed Mainnet backend."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('diagnostics_stable', ROOT / 'scripts/build-stable-release.py')
stable = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stable)


def replace(source, old, new):
    if source.count(old) != 1:
        raise ValueError('Installed source no longer matches the bounded diagnostics patch: ' + old[:60])
    return source.replace(old, new, 1)


def instrument_executor(source):
    source = "import { paymentFailure, type PaymentFailureStage } from './pay-controller-diagnostics';\n" + source
    source = replace(source, '    async prepare(context) {\n', "    async prepare(context) {\n      let stage: PaymentFailureStage = 'preparation';\n      try {\n")
    for anchor, stage in [
        ('const value = PreparedSchema.parse', 'unsigned_decode'), ('assertUnsignedPaymentBindings', 'unsigned_bindings'),
        ('await runPaymentPreflight', 'preflight'), ('const simulation = await solanaRpc', 'simulation'),
        ('const signer = await loadBuyerSigner', 'signer_load'), ('const unsigned = {', 'transaction_decode'),
        ('const signatures = await signer.signTransactions', 'signing'), ('if (signatures.length', 'signature_validation'),
        ('const transaction = getBase64EncodedWireTransaction', 'payload_encode'),
    ]:
        source = replace(source, '      ' + anchor, "      stage = '" + stage + "';\n      " + anchor)
    source = source.replace('      assertCurrent(context);', "      stage = 'signer_authorization';\n      assertCurrent(context);")
    source = replace(source, '    },\n    assertBeforeSubmission', "      } catch (error) { throw paymentFailure(error, stage, context.record.intent.idempotencyKey); }\n    },\n    assertBeforeSubmission")
    start = source.index('      try {\n', source.index('async prepare')) + len('      try {\n')
    end = source.index('      } catch (error)', start)
    return source[:start] + ''.join('  ' + line + '\n' for line in source[start:end].splitlines()) + source[end:]


def build(args):
    output = (ROOT / args.output).resolve()
    if not output.is_relative_to(ROOT / 'build.noindex') or output.exists():
        raise ValueError('Fresh local build output required')
    base = stable.verify_artifact(args.base_artifact.resolve())
    installed = args.installed_app.resolve(strict=True)
    stable.verify_bundle(installed)
    if stable.rc.tree_files(base) != stable.rc.tree_files(installed):
        raise ValueError('Installed bundle differs from accepted parent')
    output.mkdir(mode=0o700, parents=True)
    source = output / 'source'
    shutil.copytree(args.baseline_source, source, ignore=shutil.ignore_patterns('node_modules', 'candidate', 'baseline.js', 'installed.diff'))
    (source / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)

    def compile_backend(target):
        subprocess.run(['node', str(ROOT / 'node_modules/esbuild/bin/esbuild'), 'scripts/pay-dev-backend.ts',
                        '--bundle', '--platform=node', '--target=node24', '--format=cjs', '--define:__YOSH_RC5__=true',
                        '--minify-syntax', '--outfile=' + str(target)], cwd=source, check=True)

    def normalized(value):
        return re.sub(r'^(// |  ")(?:[^\n"]*/)?(node_modules/|src/|scripts/)', r'\1\2', value, flags=re.M)

    compile_backend(output / 'baseline.js')
    if normalized((output / 'baseline.js').read_text()) != normalized((installed / stable.BACKEND_BINARY).read_text()):
        raise ValueError('Installed backend baseline was not reproduced')
    for name in ['src/modules/payment/pay-controller-diagnostics.ts', 'src/modules/purchases/approved-payment.ts']:
        shutil.copy2(ROOT / name, source / name)
    name = 'src/modules/payment/mainnet-pay-execution.ts'
    (source / name).write_text(instrument_executor((source / name).read_text()))
    name = 'src/modules/payment/payment-preflight.ts'
    text = (source / name).read_text()
    text = "import { rpcFailure, copyPaymentFailure } from './pay-controller-diagnostics';\n" + text
    text = replace(text, 'init: RequestInit = {}): Promise<JsonObject>', 'init: RequestInit = {}, rpcMethod?: string): Promise<JsonObject>')
    text = replace(text, '      if (!response.ok) throw new Error();', "      if (!response.ok) throw rpcMethod ? rpcFailure(new Error(), rpcMethod, { rpcHttpStatus: response.status, rpcFailureCode: 'HTTP_ERROR' }) : new Error();")
    text = replace(text, '    } catch {\n      throw new Error(`${label} request failed or timed out`);', '    } catch (error) {\n      const failure = rpcMethod ? rpcFailure(error, rpcMethod) : error;\n      throw copyPaymentFailure(failure, new Error(`${label} request failed or timed out`));')
    text = replace(text, 'params }),\n    });', 'params }),\n    }, method);')
    text = replace(text, 'throw new Error(`RPC ${method} returned an error`);', "throw rpcFailure(new Error(`RPC ${method} returned an error`), method, { rpcFailureCode: response.error ? 'RPC_REJECTED' : 'INVALID_RESPONSE' });")
    (source / name).write_text(text)
    name = 'src/modules/payment/solana-payment.ts'
    text = (source / name).read_text()
    text = "import { rpcFailure } from './pay-controller-diagnostics';\n" + text
    text = replace(text, "  const response = config.mode === 'live_mainnet'", "  try {\n  const response = config.mode === 'live_mainnet'")
    text = replace(text, 'throw new Error(`RPC ${method} returned HTTP ${response.status}`);', "throw rpcFailure(new Error(`RPC ${method} returned HTTP ${response.status}`), method, { rpcHttpStatus: response.status, rpcFailureCode: 'HTTP_ERROR' });")
    text = replace(text, 'throw new Error(`RPC ${method} failed`);', "throw rpcFailure(new Error(`RPC ${method} failed`), method, { rpcFailureCode: typeof body === 'object' && body !== null && 'error' in body && body.error ? 'RPC_REJECTED' : 'INVALID_RESPONSE' });")
    text = replace(text, '  return body.result as T;', '  return body.result as T;\n  } catch (error) { throw rpcFailure(error, method); }')
    start = text.index('  try {\n', text.index('export async function solanaRpc')) + len('  try {\n')
    end = text.index('  } catch (error)', start)
    text = text[:start] + ''.join('  ' + line + '\n' for line in text[start:end].splitlines()) + text[end:]
    (source / name).write_text(text)
    # Tests exercise these exact installed-source modules, not the unrelated Dev implementation.
    for name in ['tests/unit/pay-controller-diagnostics.test.ts', 'tests/integration/pay-mainnet-controlled.test.ts']:
        shutil.copy2(ROOT / name, source / name)
    app = output / 'Yosh.app'
    shutil.copytree(installed, app, symlinks=True)
    compile_backend(app / stable.BACKEND_BINARY)
    shutil.copytree(args.base_artifact / 'pay-version-compatibility', output / 'pay-version-compatibility')
    evidence = output / 'payment-diagnostics'
    evidence.mkdir(mode=0o700)
    shutil.copy2(installed / stable.SOURCE_MANIFEST, evidence / 'base-source-manifest.json')
    shutil.copy2(args.base_artifact / 'stable-artifact.json', evidence / 'base-artifact.json')
    files = {name: stable.rc.digest(source / name) for name in sorted(stable.DIAGNOSTICS_SOURCES)}
    (evidence / 'source-changes.json').write_text(json.dumps({'baselineReproduced': True, 'files': files}, indent=2) + '\n')
    provenance = json.loads((app / stable.SOURCE_MANIFEST).read_text())
    if 'paymentDiagnosticsUpdate' in provenance:
        raise ValueError('Existing diagnostics update requires a new parent contract')
    provenance['paymentDiagnosticsUpdate'] = {
        'version': 1, 'kind': 'payment-diagnostics-v1', 'baseBackendSha256': stable.rc.digest(installed / stable.BACKEND_BINARY),
        'backendSha256': stable.rc.digest(app / stable.BACKEND_BINARY), 'files': files,
        'evidence': {p.name: stable.rc.digest(p) for p in evidence.iterdir()},
    }
    (app / stable.SOURCE_MANIFEST).write_text(json.dumps(provenance, indent=2) + '\n')
    subprocess.run(['codesign', '--force', '--sign', '-', app], check=True)
    (output / 'stable-artifact.json').write_text(json.dumps({'product': provenance['product'],
        'sourceManifestSha256': stable.rc.digest(app / stable.SOURCE_MANIFEST), 'files': stable.rc.tree_files(app)}, indent=2) + '\n')
    stable.verify_artifact(output)
    print('Verified diagnostic candidate: ' + str(app))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ['output', 'base-artifact', 'baseline-source', 'installed-app']:
        parser.add_argument('--' + argument, type=Path, required=True)
    build(parser.parse_args())
