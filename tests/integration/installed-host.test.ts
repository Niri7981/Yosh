import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { findHostBinding } from '../../src/modules/mcp/installed-host';

function which(name: string) {
  try { return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim(); } catch { return ''; }
}
const grok = which('grok'), claude = which('claude');

it.skipIf(process.platform !== 'darwin')('walks past its packaged Node through the macOS /private path alias and stops at a different Node', () => {
  const root = mkdtempSync('/private/tmp/yosh-host-path-');
  try {
    const runtime = join(root, 'bin'), helper = join(runtime, 'yosh-confirm');
    mkdirSync(runtime);
    const otherNode = realpathSync(process.execPath), packagedNode = join(runtime, 'node');
    copyFileSync(otherNode, packagedNode);
    // Homebrew Node loads libnode relative to bin; use its existing library in the temp package.
    symlinkSync(resolve(dirname(otherNode), '../lib'), join(root, 'lib'));
    execFileSync('/usr/bin/swiftc', ['-parse-as-library', resolve('scripts/native/LocalGrantConfirmation.swift'), '-o', helper,
      '-framework', 'AppKit', '-framework', 'LocalAuthentication', '-framework', 'CryptoKit']);
    const result = execFileSync(packagedNode, ['-e', "process.stdout.write(require('node:child_process').execFileSync(process.argv[1], ['--calling-host']))", helper], {encoding: 'utf8'});
    // The external caller here is the test runner, a different executable with the same node basename.
    expect(realpathSync(result.trim())).toBe(otherNode);
  } finally { rmSync(root, {recursive: true, force: true}); }
}, 60000);

it.skipIf(process.platform !== 'darwin' || !grok || !claude)('routes a shared MCP configuration to the actual registered macOS host before accessing any account', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-real-hosts-')));
  const profile = join(root, 'Library/Application Support/Yosh Agent Registration');
  const cli = join(root, 'fixture.cjs'), helper = join(root, 'yosh-confirm');
  const labels = new Map([[claude, 'Claude Code'], [grok, 'Grok']]);
  const legacyId = randomUUID(), ids = new Map<string, string>();
  try {
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const claudeConfig = root, grokConfig = join(root, '.grok');
    mkdirSync(grokConfig);
    const env = { NODE_ENV: 'test' as const, HOME: root, GROK_HOME: grokConfig, CLAUDE_CONFIG_DIR: claudeConfig,
      PATH: dirname(process.execPath) + ':/usr/bin:/bin', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' };
    for (const [host, label] of labels) {
      const registration = randomUUID();
      ids.set(label, registration);
      writeFileSync(join(profile, createHash('sha256').update(label).digest('hex') + '.peer.json'),
        JSON.stringify({ version: 1, label, registration, executables: [host], legacyMember: host === claude ? legacyId : null }), { mode: 0o600 });
    }
    expect(() => findHostBinding(profile, realpathSync(process.execPath))).toThrow('NOT_REGISTERED');
    execFileSync('/usr/bin/swiftc', ['-parse-as-library', resolve('scripts/native/LocalGrantConfirmation.swift'), '-o', helper,
      '-framework', 'AppKit', '-framework', 'LocalAuthentication', '-framework', 'CryptoKit']);
    symlinkSync(process.execPath, join(root, 'node'));
    const report = join(root, 'observation.json');
    const ownerProbe = join(root, 'owner.cjs');
    await build({ stdin: { resolveDir: process.cwd(), contents: `
      import { resolveInstalledHost } from './src/modules/mcp/installed-host';
      const peer = resolveInstalledHost(${JSON.stringify(root)}, ${JSON.stringify(profile)});
      process.stdout.write(JSON.stringify({label:peer.label,registration:peer.registration,legacyMember:peer.legacyMember}));
    ` }, outfile: ownerProbe, bundle: true, platform: 'node', format: 'cjs' });
    await build({ stdin: { resolveDir: process.cwd(), contents: `
      import { resolveInstalledHost } from './src/modules/mcp/installed-host';
      import { writeFileSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      import { execFileSync } from 'node:child_process';
      const peer = resolveInstalledHost(${JSON.stringify(root)}, ${JSON.stringify(profile)});
      const ownerPeer = JSON.parse(execFileSync(process.execPath, [${JSON.stringify(ownerProbe)}], {encoding:'utf8'}));
      if (ownerPeer.registration !== peer.registration) throw Error('LOCAL_HOST_BINDING_MISMATCH');
      writeFileSync(${JSON.stringify(report)}, JSON.stringify(ownerPeer));
      createInterface({input:process.stdin}).on('line', line => {
        const m = JSON.parse(line);
        if (!('id' in m)) return;
        const result = m.method === 'initialize' ? {protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'yosh-fixture',version:'1'}} : {tools:[{name:'fixture_only',inputSchema:{type:'object'}}]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
      });` }, outfile: cli, bundle: true, platform: 'node', format: 'cjs' });
    // Both programs receive byte-for-byte identical hints, including Claude's old member.
    const args = [cli, '--registration', ids.get('Claude Code')!, '--label', 'Claude Code'];
    const definition = { command: process.execPath, args, env: { YOSH_CARD_MEMBER_ID: legacyId } };
    writeFileSync(join(claudeConfig, '.claude.json'), JSON.stringify({mcpServers:{yosh:definition}}), {mode:0o600});
    const options = { env, cwd: root, stdio: 'pipe' as const, timeout: 20000 };
    execFileSync(claude, ['mcp', 'get', 'yosh'], options);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({label:'Claude Code', registration:ids.get('Claude Code'),legacyMember:legacyId});
    rmSync(report);
    // With no Grok entry, the actual host imports the Claude definition.
    const check = spawnSync(grok, ['mcp', 'doctor', 'yosh', '--json'], options);
    expect(check.status, String(check.stdout).slice(-1800)).toBe(0);
    expect(existsSync(report)).toBe(true);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({label:'Grok',registration:ids.get('Grok'),legacyMember:null});
  } finally { rmSync(root, {recursive:true,force:true}); }
}, 60000);
