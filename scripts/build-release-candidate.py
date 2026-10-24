#!/usr/bin/env python3
"""Freeze, rebuild and verify a source-identified, uninstalled macOS RC.

Only locked local dependency sources and a checksum-verified Node archive are
accepted. Build/test children have private state, no external network and no
access to product data. Existing apps and Codex configuration are never inputs.
"""
import argparse
import datetime
import difflib
import hashlib
import json
import os
import pathlib
import plistlib
import re
import shutil
import stat
import subprocess
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASELINE = ROOT / 'integration/release-candidate/reviewed-baseline.json'
HISTORICAL_LOCK = ROOT / 'integration/release-candidate/source-lock.json'
LOCK = ROOT / 'integration/release-candidate/final-source-lock.json'
PREDECESSOR_LOCK = ROOT / 'integration/release-candidate/rc4-source-lock.json'
PREDECESSOR_SHA = 'afd34e67df8c7f96cfc788ef9c963721d3aab26ef91108e6b00f61f26f2308b8'
ISOLATION = {
    'bundleIdentifier': 'com.yosh.pay-development.v011rc5',
    'applicationSupport': '~/Library/Application Support/Yosh Pay Dev v0.1.1-rc.5',
    'directoryName': 'Yosh Pay Dev v0.1.1-rc.5',
    'keychainNamespace': 'com.yosh.pay-development.v011rc5',
    'ports': {'backend': 13449, 'mockResource': 13450, 'protocolTest': 13451},
    'buildDefine': '__YOSH_RC5__=true',
}
HEADS = {'yosh': 'afeb2ddcea1da6b334bd8fc7183d5d3fa8fb1434',
         'pay': '402f67c44dd8d41d7d1584fcb5d868006ce8c891'}
KIT = '7f1369180ca4b047aadff1bea77aed4525e10039'
NODE_VERSION = '24.21.0'
NODE_HASH = '6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe'
RC5_FILES = {
    'tests/integration/pay-mainnet-live-preflight.test.ts',
    'tests/unit/pay-mainnet-acceptance.test.ts',
    'src/modules/purchases/purchase-ledger.ts',
    'src/modules/payment/pay-controller-diagnostics.ts',
    'tests/unit/pay-controller-contract.test.ts',
    'tests/unit/pay-controller-diagnostics.test.ts',
    'docs/reviews/rc5-controller-contract-20261023.md',
    'docs/releases/v0.1.1-rc.5-final-source.md',
    'integration/release-candidate/source-lock.json',
    'integration/release-candidate/pay-overlay/yosh-controlled-mcp.rs',
    'integration/release-candidate/pay-overlay/agent402-mainnet-quote.json',
    'tests/release/test_build_release_candidate.py',
    '.gitignore',
    'src/modules/payment/keychain.ts',
    'src/modules/app-wallet/product-wallet.ts',
    'src/modules/pay-dev/mainnet-signer-selection.ts',
    'tests/unit/legacy-mainnet-signer.test.ts',
    'package.json',
    'apps/macos/Yosh/Yosh.xcodeproj/project.pbxproj',
    'apps/macos/Yosh/YoshApp/Services/BackendLaunchConfiguration.swift',
    'src/modules/pay-dev/profile.ts',
    'src/modules/pay-dev/environment.ts',
    'scripts/pay-dev-backend.ts',
    'scripts/pay-dev-mcp.ts',
    'vitest.config.ts',
    'tests/native/BackendLaunchConfigurationTest.swift',
    'tests/native/pay-dev-host-gate.py',
    'tests/native/pay-dev-codex-config.py',
    'tests/integration/pay-dev-runtime.test.ts',
    'tests/integration/pay-dev-environments.test.ts',
    'tests/unit/pay-dev-offline-services.test.ts',
    'tests/unit/pay-dev-profile.test.ts',
    'tests/unit/pay-dev-keychain-namespace.test.ts',
    'tests/unit/pay-dev-namespace-input.test.ts',
    'scripts/build-release-candidate.py',
    'tests/release/test_rc2_isolation.py',
    'integration/README.md',
    'docs/releases/v0.1.1-rc.5.md',
    'integration/release-candidate/rc4-source-lock.json',
    'apps/macos/Yosh/YoshApp/Views/Card/DailyAuthorityContent.swift',
    'apps/macos/Yosh/YoshApp/Views/Card/PurchaseDetail.swift',
    'tests/native/UIAcceptanceRegression.swift',
    'tests/native/ui-acceptance-regression.sh',
    'src/modules/payment/pay-mainnet-control.ts',
    'src/modules/app/app-runtime.ts',
    'src/modules/pay-dev/offline-services.ts',
    'src/modules/payment/pay-unsigned-preflight.ts',
    'tests/unit/pay-unsigned-preflight.test.ts',
    'src/modules/purchases/execution-safety.ts',
    'tests/helpers/pay-production-fixture.ts',
    'tests/helpers/pay-production-crash-worker.ts',
    'tests/integration/pay-mcp-first.test.ts',
    'tests/integration/pay-mainnet-controlled.test.ts',
    'src/modules/payment/pay-authority-adapter.ts',
    'src/modules/pay-dev/management-server.ts',
    'tests/unit/pay-authorization-outcome.test.ts',
    'src/modules/payment/pay-authorization-outcome.ts',
    'tests/unit/product-release-contract.test.ts',
    'integration/release-candidate/rc4-source-lock.json',
    'tests/unit/pay-dev-profile.test.ts',
    'tests/unit/pay-dev-keychain-namespace.test.ts',
    'tests/unit/pay-dev-namespace-input.test.ts',
    'tests/unit/pay-dev-offline-services.test.ts',
    'tests/unit/legacy-mainnet-signer.test.ts',
}



def digest(path):
    hasher = hashlib.sha256()
    with pathlib.Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root)


def source_record(path):
    names = git(path, 'ls-files', '-c', '-o', '--exclude-standard', '-z').decode().split('\0')
    files = {}
    for name in sorted(set(filter(None, names))):
        if path == ROOT and name == str(LOCK.relative_to(ROOT)):
            continue  # The provenance binds the lock's own hash separately.
        if pathlib.Path(name).name.startswith('.env') and pathlib.Path(name).name != '.env.example':
            raise ValueError('Environment files are not release inputs')
        candidate = path / name
        if candidate.is_symlink():
            # Git tracks skill aliases as link text, not dereferenced files.
            target = os.readlink(candidate)
            if pathlib.Path(target).is_absolute() or not candidate.resolve().is_relative_to(path):
                raise ValueError(f'External source symlink: {name}')
            files[name] = hashlib.sha256(target.encode()).hexdigest()
            continue
        if not candidate.is_file():
            raise ValueError(f'Missing/non-file source input: {name}')
        files[name] = digest(candidate)
    patch = git(path, 'diff', '--binary', 'HEAD')
    return {'head': git(path, 'rev-parse', 'HEAD').decode().strip(),
            'dirty': bool(git(path, 'status', '--porcelain', '--untracked-files=all')),
            'trackedOverlaySha256': hashlib.sha256(patch).hexdigest(),
            'filesSha256': hashlib.sha256(canonical(files)).hexdigest(), 'files': files}


def check_version():
    package = json.loads((ROOT / 'package.json').read_text())
    if package['version'] != '0.1.1' or package['yoshRelease'] != {'candidate': '0.1.1-rc.5', 'buildNumber': '6'}:
        raise ValueError('RC product metadata mismatch')
    lock = json.loads((ROOT / 'package-lock.json').read_text())
    if lock['version'] != package['version'] or lock['packages']['']['version'] != package['version']:
        raise ValueError('Package lock version mismatch')
    project = (ROOT / 'apps/macos/Yosh/Yosh.xcodeproj/project.pbxproj').read_text()
    for setting in ['MARKETING_VERSION = 0.1.1;', 'CURRENT_PROJECT_VERSION = 6;',
                    'YOSH_RELEASE_CANDIDATE = "0.1.1-rc.5";']:
        if project.count(setting) != 2:
            raise ValueError(f'Both Xcode configurations must match: {setting}')
    return {'version': package['version'], 'releaseCandidate': package['yoshRelease']['candidate'], 'buildNumber': '6'}


def final_source_record(path, base):
    # The full file inventory is stable across staging and the archival commit.
    # The fixed, verified ancestor identifies provenance without a self-referential
    # commit hash or a diff that omits untracked source before staging.
    git(path, 'merge-base', '--is-ancestor', base, 'HEAD')
    record = source_record(path)
    modes = {name: '120000' if (path / name).is_symlink() else
             '100755' if (path / name).stat().st_mode & stat.S_IXUSR else '100644'
             for name in record['files']}
    return {'head': base, 'filesSha256': record['filesSha256'], 'files': record['files'], 'modes': modes}


def source_provenance(sources):
    return {name: {'baseCommit': spec['head'], 'filesSha256': spec['filesSha256'],
                   'modesSha256': hashlib.sha256(canonical(spec['modes'])).hexdigest()}
            for name, spec in sources.items()}


def record_predecessor_diff(previous_output, output, lock):
    if digest(previous_output / 'source-lock.json') != PREDECESSOR_SHA:
        raise ValueError('Predecessor output is not the frozen rc.4')
    previous = json.loads(PREDECESSOR_LOCK.read_text())
    old_files = {}
    with tarfile.open(previous_output / 'sources/yosh.tar.gz', 'r:gz') as archive:
        for member in archive.getmembers():
            relative = pathlib.PurePosixPath(member.name).relative_to('yosh').as_posix()
            data = member.linkname.encode() if member.issym() else archive.extractfile(member).read()
            if hashlib.sha256(data).hexdigest() != previous['sources']['yosh']['files'].get(relative):
                raise ValueError(f'Predecessor source archive mismatch: {relative}')
            old_files[relative] = data
    if set(old_files) != set(previous['sources']['yosh']['files']):
        raise ValueError('Incomplete predecessor source archive')
    patch = []
    for change in lock['differencesSinceRc4']:
        relative = change['path']
        if change['source'] != 'yosh':
            continue
        before = old_files.get(relative, b'').decode().splitlines(keepends=True)
        after = (ROOT / relative).read_text().splitlines(keepends=True)
        patch.extend(difflib.unified_diff(before, after, fromfile='rc.4/' + relative,
                                         tofile='rc.5/' + relative))
    (output / 'rc4-to-rc5.diff').write_text(''.join(patch))
    (output / 'rc4-to-rc5-files.json').write_text(json.dumps({
        'predecessorSourceLockSha256': PREDECESSOR_SHA,
        'differences': lock['differencesSinceRc4'],
        'payUnchanged': False, 'payKitRevision': KIT,
    }, indent=2) + '\n')


def verify_packaged_isolation(app):
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != ISOLATION['bundleIdentifier'] or info.get('YoshCandidateIsolation') != ISOLATION:
        raise ValueError('Packaged Native identity does not match rc.5')
    runtime = app / 'Contents/Resources/Runtime'
    if json.loads((runtime / 'candidate-isolation.json').read_text()) != ISOLATION:
        raise ValueError('Packaged runtime identity mismatch')
    # Inspect active entry points, not historical manifests which deliberately
    # preserve rc.3 source hashes. No candidate process is executed here.
    for name in ['backend/server.js', 'mcp.cjs', 'confirm-pay-mainnet.cjs']:
        text = (runtime / name).read_text()
        # The bundled URL dependency contains Unicode code-point mapping rows
        # with these numbers. They are data, not listeners or service targets.
        configuration = re.sub(r'\[\[\d+,\s*\d+\],\s*"mapped",\s*\[[\d,\s]+\]\]', '', text)
        configuration = re.sub(r'\[\[\d+,\s*\d+\],\s*"disallowed"\]', '', configuration)
        if re.search(r'(?<!\d)13[0123]49(?!\d)|(?<!\d)13[0123]5[01](?!\d)', configuration):
            raise ValueError(f'Old Dev port in packaged entry point: {name}')
        if 'com.yosh.pay-development.wallet.' in text.replace('com.yosh.pay-development.wallet.mainnet.v1', '') or 'com.yosh.pay-development.v011rc4.wallet.' in text or 'com.yosh.pay-development.v011rc3.wallet.' in text or 'com.yosh.pay-development.v011rc2.wallet.' in text:
            raise ValueError(f'Old Dev Keychain namespace in packaged entry point: {name}')
        if "\"Yosh Pay Dev\"" in text or "'Yosh Pay Dev'" in text or "Yosh Pay Dev v0.1.1-rc.4" in text or "Yosh Pay Dev v0.1.1-rc.3" in text or "Yosh Pay Dev v0.1.1-rc.2" in text:
            raise ValueError(f'Old Dev data directory in packaged entry point: {name}')
    for name in ['pay-dev.sb', 'pay-dev-mainnet.sb']:
        policy = (runtime / name).read_text()
        for old_directory in ['Yosh Pay Dev', 'Yosh Pay Dev v0.1.1-rc.2', 'Yosh Pay Dev v0.1.1-rc.3', 'Yosh Pay Dev v0.1.1-rc.4']:
            if '/Library/Application Support/' + old_directory + '\"' not in policy:
                raise ValueError('Candidate sandbox does not deny predecessor state')


def predecessor_differences(sources):
    if digest(PREDECESSOR_LOCK) != PREDECESSOR_SHA:
        raise ValueError('rc.4 source identity changed')
    previous = json.loads(PREDECESSOR_LOCK.read_text())
    differences = []
    for name, current in sources.items():
        old = previous['sources'][name]
        if current['head'] != HEADS[name]:
            raise ValueError(f'{name} revision differs from rc.4')
        for file in sorted(set(old['files']) | set(current['files'])):
            before, after = old['files'].get(file), current['files'].get(file)
            if before == after:
                continue
            allowed = RC5_FILES if name == 'yosh' else set(old['files']) | set(current['files'])
            if file not in allowed or (name == 'yosh' and after is None):
                raise ValueError(f'Change outside rc.5 lifecycle/release scope: {name}/{file}')
            differences.append({'source': name, 'path': file, 'beforeSha256': before,
                                'afterSha256': after, 'kind': 'deleted' if after is None else 'added' if before is None else 'changed'})
    return differences


def verify_pay_contract(pay):
    if git(pay, 'rev-parse', 'HEAD').decode().strip() != HEADS['pay']:
        raise ValueError('Final upstream #530 revision required')
    git(pay, 'merge-base', '--is-ancestor', '898135e5404018e61daa2644f30952507947e990', HEADS['pay'])
    overlay = {'rust/crates/mcp/src/bin/yosh-controlled-mcp.rs',
               'rust/crates/mcp/tests/fixtures/agent402-mainnet-quote.json'}
    for name in overlay:
        snapshot = ROOT / 'integration/release-candidate/pay-overlay' / pathlib.Path(name).name
        if digest(pay / name) != digest(snapshot):
            raise ValueError('Private custody overlay differs from archived source: ' + name)
    for name in filter(None, git(pay, 'ls-files', '-c', '-o', '--exclude-standard', '-z').decode().split('\0')):
        if name in overlay:
            continue
        if (pay / name).read_bytes() != git(pay, 'show', 'HEAD:' + name):
            raise ValueError('Unexpected upstream Pay source overlay: ' + name)


def freeze(pay):
    verify_pay_contract(pay)
    if LOCK.exists():
        raise ValueError('Source lock already exists; preserve it before a new freeze')
    sources = {name: final_source_record(path, HEADS[name]) for name, path in [('yosh', ROOT), ('pay', pay)]}
    differences = predecessor_differences(sources)
    value = {'schemaVersion': 3, 'recordKind': 'final-rc5-source', 'product': check_version(), 'payKitRevision': KIT,
             'historicalSourceLockSha256': digest(HISTORICAL_LOCK),
             'reviewedBaselineSha256': digest(BASELINE), 'predecessorSourceLockSha256': PREDECESSOR_SHA,
             'isolation': ISOLATION, 'differencesSinceRc4': differences, 'sources': sources,
             'note': 'Final rc.5 complete file inventory, including validated consent/recovery/controller repairs. Historical freeze is preserved. Identity excludes only this manifest; fixed ancestor plus exact file set/hashes remains valid before and after the archival commit.'}
    LOCK.write_text(json.dumps(value, indent=2) + '\n')
    print(f'Frozen {LOCK}; sha256={digest(LOCK)}', flush=True)


def verify_sources(pay):
    verify_pay_contract(pay)
    lock = json.loads(LOCK.read_text())
    if lock.get('schemaVersion') != 3 or lock.get('recordKind') != 'final-rc5-source':
        raise ValueError('Final rc.5 source record required')
    if lock.get('historicalSourceLockSha256') != digest(HISTORICAL_LOCK):
        raise ValueError('Historical rc.5 freeze changed')
    check_version()
    if lock.get('isolation') != ISOLATION or lock.get('differencesSinceRc4') != predecessor_differences(lock['sources']):
        raise ValueError('RC isolation or predecessor differences changed')
    if lock['reviewedBaselineSha256'] != digest(BASELINE) or lock['payKitRevision'] != KIT:
        raise ValueError('Reviewed baseline identity changed')
    for name, path in [('yosh', ROOT), ('pay', pay)]:
        current = final_source_record(path, HEADS[name])
        expected = lock['sources'][name]
        if current != expected:
            raise ValueError(f'{name} changed after source freeze')
    return lock


def verify_source_archive(path, prefix, expected, modes=None):
    actual = {}
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive.getmembers():
            relative = pathlib.PurePosixPath(member.name).relative_to(prefix).as_posix()
            if relative in actual or relative not in expected or not (member.isfile() or member.issym()):
                raise ValueError('Unexpected source archive member: ' + member.name)
            data = member.linkname.encode() if member.issym() else archive.extractfile(member).read()
            actual[relative] = hashlib.sha256(data).hexdigest()
            mode = '120000' if member.issym() else '100755' if member.mode & stat.S_IXUSR else '100644'
            if modes is not None and mode != modes.get(relative):
                raise ValueError('Source archive mode differs from final inventory: ' + relative)
    if actual != expected:
        raise ValueError('Source archive differs from final inventory')


def archive_sources(pay, output):
    lock = verify_sources(pay)
    output.mkdir(parents=True, exist_ok=False)
    for name, path in [('yosh', ROOT), ('pay', pay)]:
        target = output / (name + '.tar.gz')
        with tarfile.open(target, 'w:gz') as archive:
            for relative in lock['sources'][name]['files']:
                archive.add(path / relative, arcname=f'{name}/{relative}', recursive=False)
        verify_source_archive(target, name, lock['sources'][name]['files'], lock['sources'][name]['modes'])
    shutil.copy2(LOCK, output / 'final-source-lock.json')
    verify_sources(pay)
    print('Final rc.5 source archives match the complete inventories; no build, installation or payment performed')


def sandbox_profile(output, loopback=False, pay_free=False):
    real_home = pathlib.Path.home()
    private = [real_home / item for item in ['Library/Keychains', '.config/pay', '.config/solana',
               'Library/Application Support/2049', 'Library/Application Support/Yosh',
               'Library/Application Support/Yosh Pay Dev', 'Library/Application Support/Yosh Pay Dev v0.1.1-rc.3', 'Library/Application Support/Yosh Pay Dev v0.1.1-rc.4', 'Library/Application Support/Yosh Pay Dev v0.1.1-rc.5', 'Library/Application Support/Yosh Pay Dev v0.1.1-rc.2', '.codex/auth.json', '.codex/config.toml', 'Desktop/yosh/.data']]
    private.append(pathlib.Path('/Library/Keychains'))
    text = '(version 1)\n(allow default)\n(deny network*)\n'
    if loopback:
        text += '(allow network-bind (local ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))\n'
    text += '(deny process-exec (literal "/usr/bin/security"))\n(deny mach-lookup (global-name "com.apple.securityd"))\n'
    text += '(deny file-read* file-write* ' + ' '.join(f'(subpath {json.dumps(str(p))})' for p in private) + ')\n'
    # Deny real workspace environment files while permitting disposable unit
    # test fixtures under output/tmp. Those fixtures never load real config.
    for source_root in [ROOT, ROOT.parent / 'pay', real_home / 'Desktop/yosh']:
        pattern = '^' + re.escape(str(source_root)) + '/\\.env(\\.[^/]*)?$'
        text += '(deny file-read* (regex #' + json.dumps(pattern) + '))\n'
    if pay_free:
        text += '(deny file-read* ' + ' '.join(f'(subpath {json.dumps(str(p))})' for p in
            [ROOT.parent / 'pay', ROOT.parent / 'round2-baseline', ROOT / 'build.noindex/pay-mcp-target',
             ROOT / 'build.noindex/pay-protocol-engine', ROOT / 'build.noindex/pay-dev-delivery']) + ')\n'
    path = output / ('default-tests.sb' if pay_free else 'loopback.sb' if loopback else 'build.sb')
    path.write_text(text)
    return path


def environment(output, cargo_home, node_bin):
    home = output / 'private-home'
    home.mkdir(mode=0o700)
    temporary = output / 'tmp'
    temporary.mkdir(mode=0o700)
    return {'PATH': str(node_bin.parent) + ':' + os.environ.get('PATH', '/usr/bin:/bin'),
            'HOME': str(home), 'TMPDIR': str(temporary), 'CI': '1', 'NEXT_TELEMETRY_DISABLED': '1',
            'NODE_DISABLE_COMPILE_CACHE': '1', 'PYTHONDONTWRITEBYTECODE': '1', 'CARGO_HOME': str(cargo_home),
            'RUSTUP_HOME': os.environ.get('RUSTUP_HOME', str(pathlib.Path.home() / '.rustup')),
            'CARGO_NET_OFFLINE': 'true', 'CARGO_BUILD_JOBS': '4',
            'CARGO_TARGET_DIR': str(output / 'rust-target'),
            'CLANG_MODULE_CACHE_PATH': str(output / 'clang-cache')}


def tree_files(path, excluded=()):
    result = {}
    for file in sorted(path.rglob('*')):
        relative = file.relative_to(path).as_posix()
        if any(part in excluded for part in file.relative_to(path).parts):
            continue
        if file.is_symlink():
            result[relative] = {'symlink': os.readlink(file)}
        elif file.is_file():
            result[relative] = {'sha256': digest(file), 'mode': oct(file.stat().st_mode & 0o777)}
    return result


def pay_kit_source(kit):
    # Cargo adds an empty .cargo-ok even to nested checkouts. It is cache
    # metadata; every tracked file, submodule revision and other new file is
    # still checked. No source or Git configuration is changed here.
    modules = git(kit, 'submodule', 'status', '--recursive').decode().splitlines()
    if any(line and line[0] != ' ' for line in modules):
        raise ValueError('pay-kit submodule revision differs from its commit')
    roots = [kit] + [kit / line.split()[1] for line in modules if line]
    files, markers, revisions = {}, [], {}
    for root in roots:
        if git(root, 'diff', '--binary', '--ignore-submodules=all', 'HEAD'):
            raise ValueError('pay-kit tracked source must remain unchanged')
        prefix = root.relative_to(kit)
        revisions[str(prefix)] = git(root, 'rev-parse', 'HEAD').decode().strip()
        extras = list(filter(None, git(root, 'ls-files', '-o', '--exclude-standard', '-z').decode().split('\0')))
        for name in extras:
            if name != '.cargo-ok' or (root / name).read_bytes() != b'':
                raise ValueError(f'Unexpected pay-kit untracked source: {prefix / name}')
            markers.append(str(prefix / name))
        for name in filter(None, git(root, 'ls-files', '-z').decode().split('\0')):
            source = root / name
            if source.is_file():
                files[(prefix / name).as_posix()] = digest(source)
    return {'files': files, 'submoduleRevisions': revisions, 'excludedEmptyCargoCacheMarkers': markers}


def safe_extract_node(archive, output):
    if digest(archive) != NODE_HASH:
        raise ValueError('Node archive checksum mismatch')
    destination = output / 'node-runtime'
    destination.mkdir()
    with tarfile.open(archive, 'r:xz') as bundle:
        # The archive is checksum pinned. Validate member paths on Python 3.9
        # too, where tarfile's newer extraction filter is not available.
        for member in bundle.getmembers():
            target = destination / member.name
            if not target.resolve().is_relative_to(destination.resolve()) or member.isdev():
                raise ValueError('Unsafe Node archive member')
            if member.issym() and not (target.parent / member.linkname).resolve().is_relative_to(destination.resolve()):
                raise ValueError('Unsafe Node archive link')
            if member.islnk() and not (destination / member.linkname).resolve().is_relative_to(destination.resolve()):
                raise ValueError('Unsafe Node archive hard link')
        bundle.extractall(destination)
    return destination / f'node-v{NODE_VERSION}-darwin-arm64'


def build(args):
    pay = args.pay.resolve(strict=True)
    lock = verify_sources(pay)
    output = args.output.resolve()
    # A failed run is retained. A new run must choose a fresh directory.
    if output.exists():
        raise ValueError('Output already exists; select a fresh candidate output directory')
    output.mkdir(parents=True)
    logs = output / 'logs'
    logs.mkdir()
    commands = []
    node = safe_extract_node(args.node_archive.resolve(strict=True), output)
    env = environment(output, args.cargo_home.resolve(strict=True), node / 'bin/node')
    profiles = [sandbox_profile(output), sandbox_profile(output, True), sandbox_profile(output, True, True)]

    def run(label, command, cwd=ROOT, loopback=False, pay_free=False, self_sandboxed=False):
        logfile = logs / f'{label}.log'
        print(f'START {label}', flush=True)
        selected_profile = profiles[2 if pay_free else int(loopback)]
        child_environment = env.copy()
        if self_sandboxed:
            # This entry point always creates its own OS sandbox. Give it the
            # exact RC profile rather than trying to nest sandbox-exec.
            child_environment['YOSH_PAY_TEST_SANDBOX_PROFILE'] = str(selected_profile)
            invocation = list(map(str, command))
        else:
            invocation = ['/usr/bin/sandbox-exec', '-f', str(selected_profile), *map(str, command)]
        with logfile.open('w') as stream:
            code = subprocess.run(invocation, cwd=cwd, env=child_environment, stdout=stream, stderr=subprocess.STDOUT).returncode
        commands.append({'label': label, 'argv': list(map(str, command)), 'cwd': str(cwd),
                         'isolation': 'entry-point sandbox' if self_sandboxed else 'outer sandbox',
                         'sandboxProfileSha256': digest(selected_profile),
                         'exitCode': code, 'log': str(logfile.relative_to(output)), 'logSha256': digest(logfile)})
        (output / 'build-steps.json').write_text(json.dumps(commands, indent=2) + '\n')
        print(f'{"PASS" if code == 0 else "FAIL"} {label}: {logfile}', flush=True)
        if code:
            raise RuntimeError(f'{label} failed; inspect {logfile}')

    kit_paths = list((args.cargo_home / 'git/checkouts').glob('pay-kit-*/7f13691'))
    if len(kit_paths) != 1 or git(kit_paths[0], 'rev-parse', 'HEAD').decode().strip() != KIT:
        raise ValueError('Locked pay-kit checkout missing or revision mismatch')
    kit = kit_paths[0].resolve()
    kit_source = pay_kit_source(kit)
    kit_files = kit_source['files']
    (output / 'pay-kit-source-files.json').write_text(json.dumps(kit_files, indent=2) + '\n')
    (output / 'pay-kit-checkout.json').write_text(json.dumps(kit_source, indent=2) + '\n')
    package_lock = json.loads((ROOT / 'package-lock.json').read_text())
    installed_lock = json.loads((ROOT / 'node_modules/.package-lock.json').read_text())
    for name, spec in installed_lock['packages'].items():
        expected = package_lock['packages'].get(name)
        if not expected or expected.get('version') != spec.get('version'):
            raise ValueError(f'Installed package is outside the locked dependency set: {name}')
        installed = json.loads((ROOT / name / 'package.json').read_text())
        if installed.get('version') != expected.get('version'):
            raise ValueError(f'Installed package version differs from lock: {name}')
    # Cached dependencies are explicit inputs, never presented as an npm ci.
    # Vitest and bundler caches are generated state, not dependency source.
    dependency_files = tree_files(ROOT / 'node_modules', excluded=('.vite', '.cache'))
    (output / 'node-modules-files.json').write_text(json.dumps(dependency_files, indent=2) + '\n')
    cargo_configuration = args.cargo_home / 'config.toml'
    vendor_match = re.search(r'^directory\s*=\s*"([^"]+)"', cargo_configuration.read_text(), re.M)
    if not vendor_match:
        raise ValueError('Offline Cargo vendor directory is not explicitly configured')
    vendor = pathlib.Path(vendor_match.group(1)).resolve(strict=True)
    vendor_files = tree_files(vendor)
    (output / 'cargo-vendor-files.json').write_text(json.dumps(vendor_files, indent=2) + '\n')

    snapshots = output / 'sources'
    snapshots.mkdir()
    for name, path in [('yosh', ROOT), ('pay', pay)]:
        with tarfile.open(snapshots / f'{name}.tar.gz', 'w:gz') as archive:
            for rel in lock['sources'][name]['files']:
                archive.add(path / rel, arcname=f'{name}/{rel}', recursive=False)
        verify_source_archive(snapshots / f'{name}.tar.gz', name, lock['sources'][name]['files'], lock['sources'][name]['modes'])
        (snapshots / f'{name}-tracked-overlay.patch').write_bytes(git(path, 'diff', '--binary', 'HEAD'))
    with tarfile.open(snapshots / 'pay-kit.tar.gz', 'w:gz') as archive:
        for rel in kit_files:
            archive.add(kit / rel, arcname=f'pay-kit/{rel}', recursive=False)
    shutil.copy2(LOCK, output / 'source-lock.json')
    shutil.copy2(BASELINE, output / 'reviewed-baseline.json')
    record_predecessor_diff(args.predecessor_output.resolve(strict=True), output, lock)

    # Empty target directory: no prebuilt application binary is accepted.
    run('pay-mcp-build', ['cargo', 'build', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-controlled-mcp'], pay / 'rust')
    protocol_source = output / 'protocol-source'
    for rel in lock['sources']['pay']['files']:
        if rel.startswith('rust/'):
            target = protocol_source / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(pay / rel, target)
    wrapper = ROOT / 'integration/pay-protocol-engine/main.rs'
    shutil.copy2(wrapper, protocol_source / 'rust/crates/mcp/src/bin/yosh-execution-protocol.rs')
    run('protocol-engine-build', ['cargo', 'build', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-execution-protocol'], protocol_source / 'rust')
    # Existing tests use these conventional paths, populated only from this run.
    for source, destination in [(output / 'rust-target/debug/yosh-controlled-mcp', ROOT / 'build.noindex/pay-mcp-target/debug/yosh-controlled-mcp'),
                                (output / 'rust-target/debug/yosh-execution-protocol', ROOT / 'build.noindex/pay-protocol-engine/yosh-execution-protocol')]:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)

    run('release-builder-tests', ['python3', '-m', 'unittest', 'discover', '-s', 'tests/release', '-p', 'test_*.py'])
    run('default-tests', ['npm', 'test'], loopback=True, pay_free=True)
    run('typecheck', ['npm', 'run', 'typecheck'])
    run('lint', ['npm', 'run', 'lint'])
    run('production-backend-build', ['npm', 'run', 'build'])
    production = tree_files(ROOT / '.next/standalone')
    (output / 'production-backend-files.json').write_text(json.dumps(production, indent=2) + '\n')

    derived = output / 'native'
    run('native-release-build', ['xcodebuild', '-project', ROOT / 'apps/macos/Yosh/Yosh.xcodeproj', '-scheme', 'Yosh',
        '-configuration', 'Release', '-destination', 'platform=macOS,arch=arm64', '-derivedDataPath', derived,
        'ONLY_ACTIVE_ARCH=YES', 'CODE_SIGNING_ALLOWED=NO', 'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox'])
    run('native-ui-acceptance-regression', ['bash', 'tests/native/ui-acceptance-regression.sh'])
    # Swift macro subprocesses inherit the outer build sandbox. Disable their
    # nested sandbox setup, which macOS rejects, without weakening the outer
    # network, product-data or Keychain restrictions.
    app = output / 'Yosh Pay Dev v0.1.1-rc.5.app'
    shutil.copytree(derived / 'Build/Products/Release/Yosh.app', app, symlinks=True)
    plist = app / 'Contents/Info.plist'
    info = plistlib.loads(plist.read_bytes())
    if (info.get('CFBundleShortVersionString'), info.get('CFBundleVersion'), info.get('YoshReleaseCandidate')) != ('0.1.1', '6', '0.1.1-rc.5'):
        raise ValueError('Native build version does not match source lock')
    info.update(CFBundleIdentifier=ISOLATION['bundleIdentifier'], CFBundleDisplayName=ISOLATION['directoryName'],
                CFBundleName=ISOLATION['directoryName'], YoshPayDevelopment=True, YoshCandidateIsolation=ISOLATION)
    plist.write_bytes(plistlib.dumps(info))
    runtime = app / 'Contents/Resources/Runtime'
    (runtime / 'backend/.next').mkdir(parents=True)
    (runtime / 'licenses').mkdir()
    (runtime / 'backend/.next/BUILD_ID').write_text('yosh-pay-offline-development-v1\n')
    for label, entry, target in [('packaged-backend', 'pay-dev-backend.ts', runtime / 'backend/server.js'),
                                 ('packaged-mcp', 'pay-dev-mcp.ts', runtime / 'mcp.cjs'),
                                 ('packaged-confirmation', 'confirm-pay-mainnet.ts', runtime / 'confirm-pay-mainnet.cjs')]:
        run(label, [ROOT / 'node_modules/.bin/esbuild', ROOT / 'scripts' / entry, '--bundle', '--platform=node',
                    '--target=node24', '--format=cjs', '--define:__YOSH_RC5__=true', '--minify-syntax', '--outfile=' + str(target)])
    shutil.copy2(node / 'bin/node', app / 'Contents/MacOS/YoshBackendNode')
    (runtime / 'node').symlink_to('../../MacOS/YoshBackendNode')
    shutil.copy2(node / 'LICENSE', runtime / 'licenses/Node-LICENSE')
    shutil.copy2(pay / 'LICENSE', runtime / 'licenses/Pay-LICENSE')
    shutil.copy2(kit / 'LICENSE', runtime / 'licenses/pay-kit-LICENSE')
    shutil.copy2(ROOT / 'scripts/run-pay-dev-codex.py', runtime / 'run-pay-dev-codex.py')
    shutil.copy2(output / 'rust-target/debug/yosh-controlled-mcp', runtime / 'pay-mcp')
    shutil.copy2(output / 'rust-target/debug/yosh-execution-protocol', runtime / 'pay-protocol-engine')
    # Preserve the reviewed Dev sandbox and additionally deny the old Dev store.
    old_script = (ROOT / 'scripts/build-yosh-pay-dev.sh').read_text()
    for name in ['pay-dev.sb', 'pay-dev-mainnet.sb']:
        block = old_script.split(f'cat > "$runtime/{name}" <<\'SB\'\n', 1)[1].split('\nSB\n', 1)[0]
        # Candidate runtime must not open old Dev state in either environment.
        block += '\n(deny file-read* file-write* (subpath (string-append (param \"REAL_HOME\") \"/Library/Application Support/Yosh Pay Dev\")))'
        block += '\n(deny file-read* file-write* (subpath (string-append (param \"REAL_HOME\") \"/Library/Application Support/Yosh Pay Dev v0.1.1-rc.3\")))'
        block += '\n(deny file-read* file-write* (subpath (string-append (param \"REAL_HOME\") \"/Library/Application Support/Yosh Pay Dev v0.1.1-rc.2\")))'
        block += '\n(deny file-read* file-write* (subpath (string-append (param \"REAL_HOME\") \"/Library/Application Support/Yosh Pay Dev v0.1.1-rc.4\")))'
        (runtime / name).write_text(block + '\n')
    (runtime / 'candidate-isolation.json').write_text(json.dumps(ISOLATION, indent=2) + '\n')
    verify_packaged_isolation(app)
    fixture = ROOT / 'build.noindex/pay-dev-delivery/Yosh Pay Dev.app/Contents/Resources/Runtime'
    fixture.parent.mkdir(parents=True, exist_ok=True)
    if fixture.is_symlink():
        previous = fixture.resolve()
        if not previous.is_relative_to(ROOT / 'build.noindex/release') or previous.name != 'Runtime':
            raise ValueError('Existing test Runtime is not owned by this RC flow')
        fixture.unlink()  # Replace only our fixture link; retain prior output.
    elif fixture.exists():
        raise ValueError('Existing test Runtime must be preserved; use a new worktree')
    fixture.symlink_to(runtime, target_is_directory=True)

    run('pay-rust-tests', ['cargo', 'test', '--offline', '--locked', '-p', 'pay-mcp', '--lib', '--test', 'external_authority', '--test', 'curl_http_e2e', '--bin', 'yosh-controlled-mcp'], pay / 'rust', True)
    run('pay-quote-regression', ['cargo', 'test', '--offline', '--locked', '-p', 'pay-mcp', '--lib', 'controlled::tests'], pay / 'rust', True)
    run('protocol-engine-tests', ['cargo', 'test', '--offline', '--locked', '-p', 'pay-mcp', '--bin', 'yosh-execution-protocol'], protocol_source / 'rust', True)
    run('pay-host-config-tests', ['python3', 'tests/native/pay-dev-host-gate.py'], loopback=True)
    run('isolated-codex-config-tests', ['python3', 'tests/native/pay-dev-codex-config.py'], loopback=True)
    run('pay-integration-tests', ['npm', 'run', 'test:pay'], loopback=True, self_sandboxed=True)
    run('rc4-packaged-isolation-tests', ['python3', ROOT / 'scripts/build-release-candidate.py', 'inspect', '--output', output])
    run('native-launch-tests', ['bash', 'tests/native/backend-launch-configuration.sh'], loopback=True)
    verify_sources(pay)
    if tree_files(ROOT / 'node_modules', excluded=('.vite', '.cache')) != dependency_files:
        raise ValueError('Installed dependency source changed during the build')
    if tree_files(vendor) != vendor_files or pay_kit_source(kit) != kit_source:
        raise ValueError('Cargo dependency source changed during the build')
    raw_components = {'nativeExecutable': digest(app / 'Contents/MacOS/Yosh'),
        'payMcp': digest(output / 'rust-target/debug/yosh-controlled-mcp'),
        'protocolEngine': digest(output / 'rust-target/debug/yosh-execution-protocol'),
        'node': digest(node / 'bin/node')}
    for label, executable in [('node-sign', app / 'Contents/MacOS/YoshBackendNode'), ('pay-sign', runtime / 'pay-mcp'), ('engine-sign', runtime / 'pay-protocol-engine')]:
        run(label, ['/usr/bin/codesign', '--force', '--sign', '-', executable])

    tools = {}
    for label, command in [('node', [node / 'bin/node', '--version']), ('rustc', ['rustc', '--version']),
                           ('cargo', ['cargo', '--version']), ('xcode', ['xcodebuild', '-version'])]:
        tools[label] = subprocess.check_output(list(map(str, command)), env=env, text=True).strip()
    codex_host = pathlib.Path('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
    host_tool = {'path': str(codex_host), 'sha256': digest(codex_host),
        'version': subprocess.check_output(['/usr/bin/sandbox-exec', '-f', str(profiles[0]), str(codex_host), '--version'], env=env, text=True).strip()}
    provenance = {'schemaVersion': 1, 'product': lock['product'], 'builtAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'profile': 'pay-dev-environments', 'isolation': ISOLATION,
        'predecessorSourceLockSha256': PREDECESSOR_SHA,
        'sourceDifferencesSha256': digest(output / 'rc4-to-rc5-files.json'),
        'sourceDiffPatchSha256': digest(output / 'rc4-to-rc5.diff'), 'installed': False, 'launched': False, 'productionEnabledByBuild': False,
        'sourceLockSha256': digest(LOCK), 'sources': source_provenance(lock['sources']),
        'payKit': {'revision': KIT, 'dirty': False, 'filesManifestSha256': digest(output / 'pay-kit-source-files.json'),
                   'checkoutManifestSha256': digest(output / 'pay-kit-checkout.json'),
                   'cacheMetadataNote': 'Only pre-existing empty .cargo-ok markers excluded; tracked files, recursive submodule SHAs and all other untracked files checked'},
        'node': {'version': NODE_VERSION, 'archiveSha256': NODE_HASH}, 'toolchain': tools,
        'testHost': host_tool,
        'commands': commands.copy(), 'protocolWrapperSha256': digest(wrapper),
        'rawComponentsBeforePackagingSignature': raw_components,
        'componentsBeforeBundleSignature': {'nativeExecutable': digest(app / 'Contents/MacOS/Yosh'), 'backend': digest(runtime / 'backend/server.js'),
                       'mcpWrapper': digest(runtime / 'mcp.cjs'), 'payMcp': digest(runtime / 'pay-mcp'),
                       'protocolEngine': digest(runtime / 'pay-protocol-engine'), 'node': digest(app / 'Contents/MacOS/YoshBackendNode')},
        'productionBackendFilesSha256': digest(output / 'production-backend-files.json'),
        'productionBackendRole': 'Separately validated Next production build; the Dev App ships the esbuild backend listed in componentsBeforeBundleSignature.backend',
        'dependencyInputs': {'packageLockSha256': digest(ROOT / 'package-lock.json'),
                             'installedPackageLockSha256': digest(ROOT / 'node_modules/.package-lock.json'),
                             'installedDependencyFilesSha256': digest(output / 'node-modules-files.json'),
                             'installedDependencyMode': 'Existing local cache; every installed package version checked against lock and all non-cache files fingerprinted before and after build',
                             'payCargoLockSha256': digest(pay / 'rust/Cargo.lock'),
                             'cargoConfigurationSha256': digest(cargo_configuration),
                             'cargoConfiguration': cargo_configuration.read_text(),
                             'cargoVendorDirectory': str(vendor),
                             'cargoVendorFilesSha256': digest(output / 'cargo-vendor-files.json')},
        'sourceArchives': {p.name: digest(p) for p in snapshots.iterdir()},
        'limitations': ['Ad-hoc signed; not notarized', 'No installation, GUI launch, production data or funded acceptance',
                        'Pay GET profile only; Pay and SDK forks retain independent versions', 'Dirty source is identified by source lock and complete source archives']}
    (runtime / 'build-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    shutil.copy2(LOCK, runtime / 'source-lock.json')
    run('app-sign', ['/usr/bin/codesign', '--force', '--sign', '-', app])
    run('app-signature-verify', ['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
    # A signed executable seals its Resources, so its own final digest cannot
    # be embedded inside those resources. The outer manifest binds both.
    provenance['embeddedProvenanceSha256'] = digest(runtime / 'build-provenance.json')
    provenance['finalComponents'] = {'nativeExecutable': digest(app / 'Contents/MacOS/Yosh'),
        'backend': digest(runtime / 'backend/server.js'), 'mcpWrapper': digest(runtime / 'mcp.cjs'),
        'payMcp': digest(runtime / 'pay-mcp'), 'protocolEngine': digest(runtime / 'pay-protocol-engine'),
        'node': digest(app / 'Contents/MacOS/YoshBackendNode')}
    provenance['commands'] = commands.copy()
    provenance['signatureVerified'] = True
    (output / 'build-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    files = tree_files(app)
    (output / 'bundle-files.json').write_text(json.dumps(files, indent=2) + '\n')
    (output / 'candidate.json').write_text(json.dumps({'app': str(app), 'product': lock['product'],
        'isolation': ISOLATION, 'sourceLockSha256': digest(LOCK), 'provenanceSha256': digest(output / 'build-provenance.json'),
        'buildStepsSha256': digest(output / 'build-steps.json'),
        'bundleFilesSha256': digest(output / 'bundle-files.json'), 'verified': True,
        'installed': False, 'launched': False, 'requiresManualAcceptance': True}, indent=2) + '\n')
    print(f'RC READY: {app}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['freeze', 'check', 'archive', 'build', 'verify', 'inspect'])
    parser.add_argument('--pay', type=pathlib.Path, default=ROOT.parent / 'pay')
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'build.noindex/release/v0.1.1-rc.5')
    parser.add_argument('--predecessor-output', type=pathlib.Path)
    parser.add_argument('--cargo-home', type=pathlib.Path, default=ROOT.parent / 'cargo-home')
    parser.add_argument('--node-archive', type=pathlib.Path)
    args = parser.parse_args()
    if args.action == 'freeze':
        freeze(args.pay.resolve(strict=True))
    elif args.action == 'check':
        verify_sources(args.pay.resolve(strict=True))
        print('Frozen source inputs match')
    elif args.action == 'archive':
        archive_sources(args.pay.resolve(strict=True), args.output.resolve())
    elif args.action == 'build':
        if not args.node_archive or not args.predecessor_output:
            parser.error('build requires --node-archive and --predecessor-output')
        build(args)
    elif args.action == 'inspect':
        verify_packaged_isolation(args.output.resolve(strict=True) / 'Yosh Pay Dev v0.1.1-rc.5.app')
        print('Packaged RC identity, paths, namespace and ports verified without execution')
    else:
        output = args.output.resolve(strict=True)
        candidate = json.loads((output / 'candidate.json').read_text())
        provenance = json.loads((output / 'build-provenance.json').read_text())
        files = json.loads((output / 'bundle-files.json').read_text())
        verify_packaged_isolation(pathlib.Path(candidate['app']))
        if candidate['isolation'] != ISOLATION or provenance['isolation'] != ISOLATION:
            raise ValueError('Candidate isolation identity changed')
        for name, key in [('rc4-to-rc5-files.json', 'sourceDifferencesSha256'), ('rc4-to-rc5.diff', 'sourceDiffPatchSha256')]:
            if digest(output / name) != provenance[key]:
                raise ValueError('Predecessor differences changed')
        if digest(output / 'build-provenance.json') != candidate['provenanceSha256'] or digest(output / 'bundle-files.json') != candidate['bundleFilesSha256']:
            raise ValueError('Candidate manifest identity mismatch')
        if digest(output / 'build-steps.json') != candidate['buildStepsSha256']:
            raise ValueError('Final build and signature steps changed')
        if tree_files(pathlib.Path(candidate['app'])) != files:
            raise ValueError('Packaged application changed')
        if digest(pathlib.Path(candidate['app']) / 'Contents/Resources/Runtime/build-provenance.json') != provenance['embeddedProvenanceSha256']:
            raise ValueError('Embedded provenance changed')
        if digest(output / 'source-lock.json') != candidate['sourceLockSha256']:
            raise ValueError('Source manifest changed')
        for name, sha in provenance['sourceArchives'].items():
            if digest(output / 'sources' / name) != sha:
                raise ValueError('Source archive changed')
        for name, key in [('node-modules-files.json', 'installedDependencyFilesSha256'), ('cargo-vendor-files.json', 'cargoVendorFilesSha256')]:
            if digest(output / name) != provenance['dependencyInputs'][key]:
                raise ValueError('Dependency manifest changed')
        subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', candidate['app']], check=True)
        print('RC integrity, complete sources and signature verified; no installation or launch performed')


if __name__ == '__main__':
    main()
