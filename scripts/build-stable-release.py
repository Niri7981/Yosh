#!/usr/bin/env python3
"""Promote the frozen final rc.5 implementation; retain its persisted identity.

Builds are isolated from real data, Keychain and external network. Installation
only accepts a verified staged bundle and never provisions product state.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import plistlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('frozen_rc5_builder', ROOT / 'scripts/build-release-candidate.py')
rc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rc)
BASE = '505831010a9de5edd8f0ea3ab3b6b438fb92dda2'
VERSION = '0.1.1'
BUILD = '7'
# Only branding, metadata, packaging, their regressions and current navigation
# may differ. No payment, custody, runtime-profile or financial source is here.
PROMOTION_FILES = {
    'package.json', 'apps/macos/Yosh/Yosh.xcodeproj/project.pbxproj',
    'apps/macos/Yosh/YoshApp/App/CardApplicationDelegate.swift',
    'apps/macos/Yosh/YoshApp/Views/Card/CardSettingsBody.swift',
    'apps/macos/Yosh/YoshApp/Views/Card/CardSettingsView.swift',
    'apps/macos/Yosh/YoshApp/Views/Card/WalletsView.swift',
    'scripts/build-stable-release.py', 'scripts/install-macos-app.sh',
    'tests/release/test_stable_release.py', 'tests/release/test_rc2_isolation.py',
    'tests/unit/product-release-contract.test.ts',
    'README.md', 'integration/README.md', 'docs/releases/v0.1.1.md',
}


def verify_metadata():
    package = json.loads((ROOT / 'package.json').read_text())
    history = [json.loads(p.read_text())['product'] for p in
               (ROOT / 'integration/release-candidate').glob('*source-lock.json')]
    previous = max(int(p['buildNumber']) for p in history if p['version'] == VERSION)
    if package['version'] != VERSION or package['yoshRelease'] != {'candidate': '', 'buildNumber': BUILD} or int(BUILD) <= previous:
        raise ValueError('Stable metadata must follow every frozen candidate build')
    project = (ROOT / 'apps/macos/Yosh/Yosh.xcodeproj/project.pbxproj').read_text()
    for setting in [f'MARKETING_VERSION = {VERSION};', f'CURRENT_PROJECT_VERSION = {BUILD};', 'YOSH_RELEASE_CANDIDATE = "";']:
        if project.count(setting) != 2:
            raise ValueError('Native stable metadata mismatch: ' + setting)
    return {'name': 'Yosh', 'version': VERSION, 'buildNumber': BUILD, 'channel': 'stable'}


def check_differences(current, frozen, allowed):
    differences = sorted(p for p in set(current['files']) | set(frozen['files'])
                         if current['files'].get(p) != frozen['files'].get(p)
                         or current['modes'].get(p) != frozen['modes'].get(p))
    unexpected = set(differences) - allowed
    if unexpected or set(frozen['files']) - set(current['files']):
        raise ValueError('Change outside stable promotion scope: ' + ', '.join(sorted(unexpected or set(frozen['files']) - set(current['files']))))
    return differences


def verify_sources(pay):
    rc.git(ROOT, 'merge-base', '--is-ancestor', BASE, 'HEAD')
    if rc.LOCK.read_bytes() != rc.git(ROOT, 'show', BASE + ':' + str(rc.LOCK.relative_to(ROOT))):
        raise ValueError('Historical final rc.5 manifest changed')
    lock = json.loads(rc.LOCK.read_text())
    rc.verify_pay_contract(pay)
    if rc.final_source_record(pay, rc.HEADS['pay']) != lock['sources']['pay']:
        raise ValueError('Restored Pay differs from final rc.5 source')
    current = rc.final_source_record(ROOT, rc.HEADS['yosh'])
    differences = check_differences(current, lock['sources']['yosh'], PROMOTION_FILES)
    return {'schemaVersion': 1, 'product': verify_metadata(),
            'canonicalBase': BASE, 'buildHead': rc.git(ROOT, 'rev-parse', 'HEAD').decode().strip(),
            'promotedFrom': {'candidate': '0.1.1-rc.5', 'finalSourceLockSha256': rc.digest(rc.LOCK)},
            'paymentCoreUnchanged': True, 'promotionFiles': differences,
            'persistedIdentity': rc.ISOLATION,
            'sources': {'yosh': current, 'pay': lock['sources']['pay']}}


def verify_bundle(app):
    if app.is_symlink() or app.name != 'Yosh.app':
        raise ValueError('Expected a real Yosh.app directory')
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    expected = {'CFBundleName': 'Yosh', 'CFBundleDisplayName': 'Yosh',
                'CFBundleShortVersionString': VERSION, 'CFBundleVersion': BUILD,
                'CFBundleIdentifier': rc.ISOLATION['bundleIdentifier'],
                'CFBundleExecutable': 'Yosh', 'YoshStableRelease': True, 'YoshPayDevelopment': True}
    if any(info.get(k) != v for k, v in expected.items()) or 'YoshReleaseCandidate' in info:
        raise ValueError('Stable bundle identity mismatch')
    rc.verify_packaged_isolation(app)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', app], check=True)
    provenance = json.loads((app / 'Contents/Resources/Runtime/stable-source-manifest.json').read_text())
    if provenance['canonicalBase'] != BASE or provenance['product'] != verify_metadata() or not provenance['paymentCoreUnchanged']:
        raise ValueError('Stable source provenance mismatch')
    return info


def verify_artifact(output):
    app = output / 'Yosh.app'
    verify_bundle(app)
    record = json.loads((output / 'stable-artifact.json').read_text())
    if record['files'] != rc.tree_files(app):
        raise ValueError('Staged bundle changed after acceptance build')
    if record['sourceManifestSha256'] != rc.digest(app / 'Contents/Resources/Runtime/stable-source-manifest.json'):
        raise ValueError('Stable source manifest identity mismatch')
    return app


def build(args):
    pay = args.pay.resolve(strict=True)
    source = verify_sources(pay)
    output = args.output.resolve()
    if output.exists():
        raise ValueError('Preserve previous output; select a fresh staging directory')
    output.mkdir(parents=True)
    (output / 'logs').mkdir()
    kit = args.pay_kit.resolve(strict=True)
    if rc.git(kit, 'rev-parse', 'HEAD').decode().strip() != rc.KIT:
        raise ValueError('Pinned pay-kit revision required')
    kit_source = rc.pay_kit_source(kit)
    vendor_match = re.search(r'^directory\s*=\s*"([^"]+)"', (args.cargo_home / 'config.toml').read_text(), re.M)
    if not vendor_match:
        raise ValueError('Explicit offline Cargo vendor directory required')
    vendor = pathlib.Path(vendor_match.group(1)).resolve(strict=True)
    for path in (vendor / 'solana-pay-kit/src').rglob('*'):
        if path.is_file() and not path.name.startswith('._') and path.read_bytes() != (kit / 'rust/crates/kit/src' / path.relative_to(vendor / 'solana-pay-kit/src')).read_bytes():
            raise ValueError('Vendored SDK source differs from pinned checkout')
    vendor_files = rc.tree_files(vendor)
    npm_files = rc.tree_files(ROOT / 'node_modules', excluded=('.vite', '.cache'))
    inputs = {'payKitRevision': rc.KIT,
              'payKitSourceSha256': hashlib.sha256(rc.canonical(kit_source)).hexdigest(),
              'cargoVendorSha256': hashlib.sha256(rc.canonical(vendor_files)).hexdigest(),
              'npmInstalledFilesSha256': hashlib.sha256(rc.canonical(npm_files)).hexdigest(),
              'npmLockSha256': rc.digest(ROOT / 'package-lock.json'), 'nodeArchiveSha256': rc.NODE_HASH}
    (output / 'build-inputs.json').write_text(json.dumps(inputs, indent=2) + '\n')
    node = rc.safe_extract_node(args.node_archive.resolve(strict=True), output)
    env = rc.environment(output, args.cargo_home.resolve(strict=True), node / 'bin/node')
    profiles = [rc.sandbox_profile(output), rc.sandbox_profile(output, True), rc.sandbox_profile(output, True, True)]
    evidence = []

    def run(label, command, cwd=ROOT, loopback=False, pay_free=False, self_sandboxed=False):
        profile = profiles[2 if pay_free else int(loopback)]
        child = env.copy()
        if self_sandboxed:
            child['YOSH_PAY_TEST_SANDBOX_PROFILE'] = str(profile)
        invocation = list(map(str, command))
        if not self_sandboxed:
            invocation = ['/usr/bin/sandbox-exec', '-f', str(profile), *invocation]
        print('START ' + label, flush=True)
        log = output / 'logs' / (label + '.log')
        with log.open('w') as stream:
            code = subprocess.run(invocation, cwd=cwd, env=child, stdout=stream, stderr=subprocess.STDOUT).returncode
        evidence.append({'label': label, 'argv': list(map(str, command)), 'exitCode': code,
                         'logSha256': rc.digest(log), 'sandboxSha256': rc.digest(profile)})
        (output / 'build-steps.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print(('PASS ' if code == 0 else 'FAIL ') + label, flush=True)
        if code:
            raise RuntimeError(f'{label} failed: {log}')

    # Historic test fixtures expect a sibling Pay. The alias is build-only and
    # removed in finally; no packaged executable uses this checkout path.
    sibling = ROOT.parent / 'pay'
    if sibling.exists() or sibling.is_symlink():
        raise ValueError('Preserve existing sibling Pay; a temporary test alias cannot replace it')
    sibling.symlink_to(pay, target_is_directory=True)
    try:
        run('pay-mcp-build', ['cargo', 'build', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-controlled-mcp'], pay / 'rust')
        protocol = output / 'protocol-source'
        shutil.copytree(pay / 'rust', protocol / 'rust', ignore=shutil.ignore_patterns('target', '.git'))
        shutil.copy2(ROOT / 'integration/pay-protocol-engine/main.rs', protocol / 'rust/crates/mcp/src/bin/yosh-execution-protocol.rs')
        run('protocol-engine-build', ['cargo', 'build', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-execution-protocol'], protocol / 'rust')
        for binary, destination in [('yosh-controlled-mcp', ROOT / 'build.noindex/pay-mcp-target/debug/yosh-controlled-mcp'),
                                    ('yosh-execution-protocol', ROOT / 'build.noindex/pay-protocol-engine/yosh-execution-protocol')]:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(output / 'rust-target/debug' / binary, destination)
        run('release-packaging-tests', ['python3', '-B', '-m', 'unittest', 'discover', '-s', 'tests/release', '-p', 'test_*.py'])
        run('default-tests', ['npm', 'test'], loopback=True, pay_free=True)
        run('typecheck', ['npm', 'run', 'typecheck'])
        # The repository carries local runtime databases under .data; they are
        # deliberately outside the source tree lint contract and may be
        # unreadable inside the build sandbox.
        run('lint', ['npm', 'run', 'lint', '--', '--ignore-pattern=.data/**'])
        # Webpack avoids Turbopack's file-system traversal into private runtime
        # data that this isolated build intentionally cannot read.
        run('production-build', ['npm', 'run', 'build', '--', '--webpack'])
        run('native-release-build', ['xcodebuild', '-project', ROOT / 'apps/macos/Yosh/Yosh.xcodeproj', '-scheme', 'Yosh',
            '-configuration', 'Release', '-destination', 'platform=macOS,arch=arm64', '-derivedDataPath', output / 'native',
            'ONLY_ACTIVE_ARCH=YES', 'CODE_SIGNING_ALLOWED=NO', 'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox'])
        run('native-launch-regressions', ['bash', 'tests/native/backend-launch-configuration.sh'], loopback=True)
        run('native-ui-regressions', ['bash', 'tests/native/ui-acceptance-regression.sh'])
        app = output / 'Yosh.app'
        shutil.copytree(output / 'native/Build/Products/Release/Yosh.app', app, symlinks=True)
        plist = app / 'Contents/Info.plist'
        info = plistlib.loads(plist.read_bytes())
        info.update(CFBundleName='Yosh', CFBundleDisplayName='Yosh', CFBundleIdentifier=rc.ISOLATION['bundleIdentifier'],
                    YoshPayDevelopment=True, YoshStableRelease=True, YoshCandidateIsolation=rc.ISOLATION)
        info.pop('YoshReleaseCandidate', None)
        plist.write_bytes(plistlib.dumps(info))
        runtime = app / 'Contents/Resources/Runtime'
        (runtime / 'backend/.next').mkdir(parents=True)
        (runtime / 'licenses').mkdir()
        (runtime / 'backend/.next/BUILD_ID').write_text('yosh-stable-v0.1.1\n')
        for label, entry, target in [('backend', 'pay-dev-backend.ts', 'backend/server.js'),
                                    ('mcp', 'pay-dev-mcp.ts', 'mcp.cjs'),
                                    ('confirmation', 'confirm-pay-mainnet.ts', 'confirm-pay-mainnet.cjs')]:
            run('package-' + label, [ROOT / 'node_modules/.bin/esbuild', ROOT / 'scripts' / entry, '--bundle', '--platform=node',
                '--target=node24', '--format=cjs', '--define:__YOSH_RC5__=true', '--minify-syntax', '--outfile=' + str(runtime / target)])
        shutil.copy2(node / 'bin/node', app / 'Contents/MacOS/YoshBackendNode')
        (runtime / 'node').symlink_to('../../MacOS/YoshBackendNode')
        for source_path, name in [(node / 'LICENSE', 'Node-LICENSE'), (pay / 'LICENSE', 'Pay-LICENSE'),
                                  (kit / 'LICENSE', 'pay-kit-LICENSE')]:
            shutil.copy2(source_path, runtime / 'licenses' / name)
        for binary, name in [('yosh-controlled-mcp', 'pay-mcp'), ('yosh-execution-protocol', 'pay-protocol-engine')]:
            shutil.copy2(output / 'rust-target/debug' / binary, runtime / name)
        old = (ROOT / 'scripts/build-yosh-pay-dev.sh').read_text()
        for name in ['pay-dev.sb', 'pay-dev-mainnet.sb']:
            policy = old.split(f'cat > "$runtime/{name}" <<\'SB\'\n', 1)[1].split('\nSB\n', 1)[0]
            for predecessor in ['Yosh Pay Dev', 'Yosh Pay Dev v0.1.1-rc.2', 'Yosh Pay Dev v0.1.1-rc.3', 'Yosh Pay Dev v0.1.1-rc.4']:
                policy += '\n(deny file-read* file-write* (subpath (string-append (param "REAL_HOME") ' + json.dumps('/Library/Application Support/' + predecessor) + ')))'
            (runtime / name).write_text(policy + '\n')
        (runtime / 'candidate-isolation.json').write_text(json.dumps(rc.ISOLATION, indent=2) + '\n')
        fixture = ROOT / 'build.noindex/pay-dev-delivery/Yosh Pay Dev.app/Contents/Resources/Runtime'
        fixture.parent.mkdir(parents=True, exist_ok=True)
        fixture.symlink_to(runtime, target_is_directory=True)
        run('pay-rust-regressions', ['cargo', 'test', '--offline', '--locked', '-p', 'pay-mcp', '--lib', '--test', 'external_authority', '--test', 'curl_http_e2e', '--bin', 'yosh-controlled-mcp'], pay / 'rust', loopback=True)
        run('protocol-engine-regressions', ['cargo', 'test', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-execution-protocol'], protocol / 'rust', loopback=True)
        run('pay-release-regressions', ['npm', 'run', 'test:pay'], loopback=True, self_sandboxed=True)
        run('codex-host-configuration', ['python3', '-B', 'tests/native/pay-dev-host-gate.py'], loopback=True)
        run('codex-isolation-configuration', ['python3', '-B', 'tests/native/pay-dev-codex-config.py'], loopback=True)
        final_source = verify_sources(pay)
        if final_source != source:
            raise ValueError('Source changed during stable build')
        if rc.pay_kit_source(kit) != kit_source or rc.tree_files(vendor) != vendor_files or rc.tree_files(ROOT / 'node_modules', excluded=('.vite', '.cache')) != npm_files:
            raise ValueError('Dependency source changed during stable build')
        (runtime / 'stable-source-manifest.json').write_text(json.dumps(source, indent=2) + '\n')
        shutil.copy2(output / 'build-inputs.json', runtime / 'build-inputs.json')
        for binary in [app / 'Contents/MacOS/YoshBackendNode', runtime / 'pay-mcp', runtime / 'pay-protocol-engine', app]:
            run('sign-' + binary.name, ['codesign', '--force', '--sign', '-', binary])
        verify_bundle(app)
        artifact = {'product': source['product'], 'sourceManifestSha256': rc.digest(runtime / 'stable-source-manifest.json'),
                    'files': rc.tree_files(app), 'buildStepsSha256': rc.digest(output / 'build-steps.json')}
        (output / 'stable-artifact.json').write_text(json.dumps(artifact, indent=2) + '\n')
        print('Stable staging ready: ' + str(app), flush=True)
    finally:
        if sibling.is_symlink() and sibling.resolve() == pay:
            sibling.unlink()


def install(output, applications):
    app = verify_artifact(output)
    target = applications / 'Yosh.app'
    if target.exists() or target.is_symlink():
        raise ValueError('Existing Yosh.app requires review; refusing replacement')
    # Never replace a running candidate or start a second owner of its state.
    if subprocess.run(['pgrep', '-x', 'Yosh'], stdout=subprocess.DEVNULL).returncode == 0:
        raise ValueError('Quit Yosh normally before installing')
    for port in rc.ISOLATION['ports'].values():
        if subprocess.run(['lsof', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN'], stdout=subprocess.DEVNULL).returncode == 0:
            raise ValueError('Wait for the existing backend to stop safely')
    applications.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.yosh-stable-', dir=applications) as temporary:
        staged = pathlib.Path(temporary) / 'Yosh.app'
        shutil.copytree(app, staged, symlinks=True)
        verify_bundle(staged)
        if rc.tree_files(staged) != rc.tree_files(app):
            raise ValueError('Installation copy differs from staged artifact')
        staged.rename(target)
    subprocess.run(['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', '-f', target], check=True)
    print('Installed verified stable: ' + str(target))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'build', 'verify', 'install'])
    parser.add_argument('--pay', type=pathlib.Path)
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'build.noindex/release/v0.1.1-stable-build7')
    parser.add_argument('--node-archive', type=pathlib.Path)
    parser.add_argument('--cargo-home', type=pathlib.Path)
    parser.add_argument('--pay-kit', type=pathlib.Path)
    parser.add_argument('--applications', type=pathlib.Path, default=pathlib.Path.home() / 'Applications')
    args = parser.parse_args()
    if args.action in ['check', 'build'] and args.pay is None:
        parser.error('--pay is required')
    if args.action == 'check':
        result = verify_sources(args.pay.resolve(strict=True))
        print(json.dumps({k: v for k, v in result.items() if k != 'sources'}, indent=2))
    elif args.action == 'build':
        if not all([args.node_archive, args.cargo_home, args.pay_kit]):
            parser.error('build requires --node-archive, --cargo-home and --pay-kit')
        build(args)
    elif args.action == 'verify':
        print('Verified: ' + str(verify_artifact(args.output.resolve(strict=True))))
    else:
        install(args.output.resolve(strict=True), args.applications.resolve(strict=True))


if __name__ == '__main__':
    main()
