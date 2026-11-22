import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const source = join(dirname(fileURLToPath(import.meta.url)), 'register-local-agents.mjs');
const runAsync = promisify(execFile);

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-install-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'private home');
  const binaries = join(root, 'bin');
  for (const directory of [home, binaries]) mkdirSync(directory, { mode: 0o700 });
  const env = { HOME: home, PATH: binaries + ':/usr/bin:/bin', CLAUDE_CONFIG_DIR: join(home, '.claude') };
  mkdirSync(env.CLAUDE_CONFIG_DIR);
  const fake = join(binaries, 'host.cjs');
  writeFileSync(fake, '#!' + process.execPath + '\n' + `
    const fs = require('node:fs'), path = require('node:path');
    const host = path.basename(process.argv[2]), args = process.argv.slice(3);
    const file = host === 'claude' ? path.join(process.env.CLAUDE_CONFIG_DIR,'.claude.json') : path.join(process.env.HOME, host + '.json');
    if (args[1] === 'add-json' && process.env.TEST_REJECT_NEW_LEGACY_CMD === 'yes' && JSON.parse(args.at(-1)).args.includes('install-mcp')) process.exit(9);
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { mcpServers: {}, unrelated:'keep' };
    if (args[1] === 'list') {
      console.log(JSON.stringify(Object.entries(data.mcpServers).map(([name, v]) => host === 'grok' ? { ...v, name, scope:'user' } : {name, enabled:true, transport:v})));
    } else {
      if (args[1] === 'remove') delete data.mcpServers.yosh;
      else if (args[1] === 'add-json' && !data.mcpServers.yosh) data.mcpServers.yosh = JSON.parse(args.at(-1));
      else if (args[1] === 'add' && host !== 'claude') {
        const cmd = args.slice(args.indexOf('--')+1);
        data.mcpServers.yosh = { command:cmd[0], args:cmd.slice(1) };
      } else process.exit(2);
      fs.writeFileSync(file,JSON.stringify(data));
    }
  `, { mode: 0o700 });
  const wrapper = join(root, 'test-host');
  const cc = join(root, 'test-host.c');
  writeFileSync(cc, `#include <stdlib.h>
#include <unistd.h>
int main(int argc, char** argv) {
  char** args = calloc(argc + 3, sizeof(char*));
  args[0] = ${JSON.stringify(process.execPath)}; args[1] = ${JSON.stringify(fake)};
  for (int i = 0; i < argc; i++) args[i + 2] = argv[i];
  execv(args[0], args); return 1;
}`);
  execFileSync('/usr/bin/cc', [cc, '-o', wrapper]);
  for (const host of ['claude', 'codex', 'grok']) cpSync(wrapper, join(binaries, host));
  const runtime = version => {
    const directory = join(root, version, 'runtime');
    mkdirSync(directory, { recursive: true });
    symlinkSync(process.execPath, join(directory, 'node'));
    writeFileSync(join(directory, 'first-use-mcp.cjs'), 'throw Error("installer must never launch MCP");');
    writeFileSync(join(directory, 'standalone.cjs'), 'throw Error("registration must not start service");');
    cpSync(source, join(directory, 'register-local-agents.mjs'));
    return join(directory, 'register-local-agents.mjs');
  };
  function file(host) { return host === 'claude' ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, host + '.json'); }
  const entries = host => JSON.parse(readFileSync(file(host), 'utf8')).mcpServers;
  const run = (script, ...args) => execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
  return { home, env, runtime, file, entries, run };
}

async function runInteractive(fixture, script, input, ...options) {
  const harness = `
import errno
import os
import pty
import subprocess
import sys

master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
pending = sys.argv[1].encode()
recent = b""
try:
    while True:
        try:
            chunk = os.read(master, 4096)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        if pending:
            recent = (recent + chunk)[-256:]
            if b"Enter numbers to toggle" in recent:
                os.write(master, pending)
                pending = b""
finally:
    os.close(master)
sys.exit(child.wait(timeout=3))
`;
  const result = await runAsync('/usr/bin/python3', ['-c', harness, input.join('\n') + '\n', process.execPath,
    script, '--interactive', ...options], { env: fixture.env, timeout: 10_000 });
  return result.stdout;
}

test('registers a separate stable identity for each host, keeps user data and migrates managed paths', t => {
  const f = fixture(t), first = f.runtime('version A'), second = f.runtime('version B');
  assert.match(f.run(first, '--dry-run'), /grok  would-register/);
  assert.equal(existsSync(f.file('grok')), false);
  assert.equal(existsSync(join(f.home,'Library')), false);
  const generic = JSON.parse(f.run(first, '--print-config', 'Local Research', '--executable', '/bin/cat')).mcpServers.yosh;
  assert.equal(generic.args.at(-1), 'Local Research');
  assert.match(f.run(first), /claude  registered/);
  const hosts = ['claude','grok','codex'];
  const ids = hosts.map(host => f.entries(host).yosh.args[2]);
  assert.equal(new Set(ids).size, 3);
  assert.match(f.run(first), /grok  already-registered/);
  assert.match(f.run(second), /claude  updated/);
  hosts.forEach((host,i) => {
    const def = f.entries(host).yosh;
    assert.equal(def.args[2], ids[i]);
    assert.equal(def.command, join(dirname(second), 'node'));
    assert.equal(JSON.parse(readFileSync(f.file(host))).unrelated,'keep');
  });
});

test('preserves Claude explicit member but installs Grok own user registration; leaves foreign names intact', t => {
  const f = fixture(t), first = f.runtime('a');
  const claude = { command:'/bin/bash', args:['/user/plugins/yosh-local-dev/old/scripts/launch.sh'], env:{ YOSH_CARD_MEMBER_ID:'existing' } };
  writeFileSync(f.file('claude'), JSON.stringify({ mcpServers:{ yosh:claude } }));
  const conflict = { command:'/bin/other', args:[] };
  writeFileSync(f.file('codex'), JSON.stringify({ mcpServers:{ yosh:conflict } }));
  assert.match(f.run(first, '--host','claude','--host','grok'), /claude  preserved-existing/);
  assert.deepEqual(f.entries('claude').yosh,claude);
  assert.equal(f.entries('grok').yosh.args.at(-1),'Grok');
  assert.throws(() => f.run(first, '--host','codex'), error => error.status === 1 && error.stdout.includes('name-in-use'));
  assert.deepEqual(f.entries('codex').yosh,conflict);
});

test('concurrent installers reuse one registration', async t => {
  const f = fixture(t), first = f.runtime('v1');
  const run = () => runAsync(process.execPath,[first,'--host','grok'],{ env:f.env });
  const [a,b] = await Promise.all([run(), run()]);
  assert.deepEqual([a.stdout.trim(),b.stdout.trim()].sort(),['grok  already-registered','grok  registered']);
});

test('explicitly migrates only the official paired legacy launcher, preserving membership and other settings', t => {
  const f = fixture(t), script = f.runtime('new');
  const old = { type:'stdio', command:'/bin/bash', args:[join(f.home,'.codex/plugins/cache/yosh-standalone-testing/yosh-local-dev/0.2.14/scripts/launch.sh')],
    env:{ YOSH_CARD_MEMBER_ID:'49d78118-eb1a-47b7-b126-db43675557df', USER_CHOICE:'keep' } };
  const file = f.file('claude');
  const extra = { preference: true };
  const save = d => writeFileSync(file, JSON.stringify({ extra, mcpServers: { yosh:d, other:{command:'true'} } }));
  const upgrade = ['--host','claude','--upgrade-legacy-clients'];
  save(old);
  assert.match(f.run(script,'--host','claude'),/preserved-existing/);
  assert.match(f.run(script,...upgrade,'--dry-run'),/would-upgrade-legacy/);
  assert.deepEqual(f.entries('claude').yosh,old);
  f.env.TEST_REJECT_NEW_LEGACY_CMD = 'yes';
  assert.throws(() => f.run(script,...upgrade), e => e.status === 1 && e.stderr.includes('HOST_UPDATE_FAILED'));
  assert.deepEqual(f.entries('claude').yosh,old);
  delete f.env.TEST_REJECT_NEW_LEGACY_CMD;
  assert.match(f.run(script,...upgrade), /upgraded-legacy/);
  const next = { ...old, command:join(dirname(script),'node'), args:[join(dirname(script),'standalone.cjs'),'install-mcp'] };
  assert.deepEqual(f.entries('claude').yosh,next);
  assert.deepEqual(JSON.parse(readFileSync(file)).extra,extra);
  assert.deepEqual(f.entries('claude').other,{command:'true'});
  assert.match(f.run(script,...upgrade), /legacy-already-current/);
  const standin = { ...old, args:old.args.map(arg => arg.replace('yosh-standalone-testing','yosh-custom')) };
  for (const definition of [
    { ...old, customHostSetting:true },
    { ...old, env:{ ...old.env, YOSH_STANDALONE_DEV_DATA_DIR:'/Users/test/sandbox' } }, standin
  ]) {
    save(definition);
    assert.match(f.run(script,...upgrade), /preserved-/);
    assert.deepEqual(f.entries('claude').yosh, definition);
  }
});

test('interactive registration uses only the confirmed local selections', async t => {
  const f = fixture(t), script = f.runtime('interactive');
  const output = await runInteractive(f, script, ['9', '1, 2', '1', 'done']);
  assert.match(output, /Enter one or more numbers shown in the list/);
  assert.match(output, /\[x\] 2\. Claude Code/);
  assert.match(output, /claude  registered/);
  assert.equal(f.entries('claude').yosh.args.at(-1), 'Claude Code');
  assert.equal(existsSync(f.file('codex')), false);
  assert.equal(existsSync(f.file('grok')), false);
  assert.doesNotMatch(output, /Dot in ChatGPT/);
});

test('interactive Dot selection shows connection instructions without registering local hosts', async t => {
  const f = fixture(t), script = f.runtime('with Dot');
  writeFileSync(join(dirname(script), 'manifest.json'), JSON.stringify({ remoteStatements: true }));
  const output = await runInteractive(f, script, ['4', 'done']);
  assert.match(output, /\[x\] 4\. Dot in ChatGPT/);
  assert.match(output, /\.\/Connect-Dot\.command --tunnel-id tunnel_YOUR_ID/);
  assert.equal(existsSync(join(f.home, 'Library', 'Application Support', 'Yosh Agent Registration')), false);
  assert.doesNotMatch(output, /registered|paused|purchase/);
});

test('interactive cancellation and dry runs preserve host settings', async t => {
  const f = fixture(t), script = f.runtime('preview');
  assert.match(await runInteractive(f, script, ['1', 'quit']), /No connections selected/);
  assert.match(await runInteractive(f, script, ['3', 'done'], '--dry-run'), /grok  would-register/);
  assert.equal(existsSync(f.file('grok')), false);
  assert.equal(existsSync(join(f.home, 'Library', 'Application Support', 'Yosh Agent Registration')), false);
  assert.throws(() => f.run(script, '--interactive'), e => e.status === 1 && e.stderr.includes('INTERACTIVE_TERMINAL_REQUIRED'));
  assert.throws(() => f.run(script, '--interactive', '--host', 'codex'), e => e.status === 1 && e.stderr.includes('INTERACTIVE_HOST_CONFLICT'));
});
