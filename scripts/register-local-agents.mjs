// Installs one shared stdio entry through each host's user-level configuration.
// Host commands are invoked only during installation, never by MCP discovery.
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const runtime = dirname(script);
const hosts = { grok: 'Grok', claude: 'Claude Code', codex: 'Codex' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const memberUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cachedLauncher = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?(?:\+[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?\/scripts\/launch\.sh$/;
const profile = join(homedir(), 'Library', 'Application Support', 'Yosh Agent Registration');

function config(label, registration) {
  return { command: join(runtime, 'node'), args: [join(runtime, 'first-use-mcp.cjs'), '--registration', registration, '--label', label] };
}

function binaryFor(host) {
  const directories = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.grok/bin'),
    join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const directory of directories.filter(isAbsolute)) {
    const binary = join(directory, host);
    try {
      const resolved = realpathSync(binary);
      if (!lstatSync(resolved).isFile() || (lstatSync(realpathSync(directory)).mode & 0o002)) continue;
      accessSync(binary, constants.X_OK);
      return binary;
    } catch { /* Try the next installed location. */ }
  }
}

async function chooseConnections() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('INTERACTIVE_TERMINAL_REQUIRED');

  const choices = ['codex', 'claude', 'grok'].filter(binaryFor)
    .map(host => ({ host, label: host === 'grok' ? 'Grok CLI' : hosts[host] }));
  const manifest = join(runtime, 'manifest.json');
  if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).remoteStatements === true)
    choices.push({ host: 'dot', label: 'Dot in ChatGPT (OpenAI Tunnel, statement only)' });
  if (!choices.length) return [];

  const selected = new Set();
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  lines.once('SIGINT', () => {
    process.exitCode = 130;
    lines.close();
  });
  lines.setPrompt('Enter numbers to toggle, done to continue, or quit to cancel: ');
  const show = () => {
    console.log('Choose where to connect Yosh.');
    choices.forEach(({ host, label }, index) => {
      console.log(`  [${selected.has(host) ? 'x' : ' '}] ${index + 1}. ${label}`);
    });
    lines.prompt();
  };

  try {
    show();
    for await (const line of lines) {
      const answer = line.trim().toLowerCase();
      if (answer === 'quit') return [];
      if (answer === 'done') return choices.filter(({ host }) => selected.has(host)).map(({ host }) => host);
      const numbers = [...new Set(answer.split(/[\s,]+/))];
      if (numbers.some(number => !/^[1-9]\d*$/.test(number) || Number(number) > choices.length)) {
        console.log('Enter one or more numbers shown in the list.');
      } else {
        for (const number of numbers) {
          const { host } = choices[Number(number) - 1];
          if (selected.has(host)) selected.delete(host);
          else selected.add(host);
        }
      }
      show();
    }
    return [];
  } finally { lines.close(); }
}

function printDotInstructions() {
  console.log('To connect Dot, create an OpenAI Tunnel for your ChatGPT workspace.');
  console.log('With an existing Yosh Mainnet account, run this from the extracted package:');
  console.log('  ./Connect-Dot.command --tunnel-id tunnel_YOUR_ID');
  console.log('The connector can install the verified OpenAI tunnel client on Apple Silicon.');
  console.log('Then add a private Yosh MCP plugin in ChatGPT and select that tunnel.');
}

function cli(binary, args) {
  const result = spawnSync(binary, args, { cwd: homedir(), encoding: 'utf8', timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error('HOST_COMMAND_FAILED');
  return result.stdout;
}

function entries(host, binary) {
  if (host === 'claude') {
    // "claude mcp list" performs live health checks. Installation must not start servers.
    const file = join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
    let value;
    try { value = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error('HOST_CONFIG_UNREADABLE');
    }
    const servers = value?.mcpServers ?? {};
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('HOST_CONFIG_UNREADABLE');
    return Object.entries(servers).map(([name, definition]) => ({ name, definition }));
  }
  const values = JSON.parse(cli(binary, ['mcp', 'list', '--json']));
  if (!Array.isArray(values)) throw new Error('HOST_CONFIG_UNREADABLE');
  if (host === 'grok' && values.some(value => value.name === 'yosh' && !['user', 'project'].includes(value.scope))) throw new Error('HOST_CONFIG_SCOPE_UNKNOWN');
  // Grok auto-imports Claude's configuration. Only its own user registration counts.
  return values.filter(value => host !== 'grok' || value.scope === 'user')
    .map(value => ({ name: value.name, enabled: value.enabled, timeout: value.startup_timeout_sec ?? value.tool_timeout_sec,
      definition: host === 'codex' ? value.transport : value }));
}

function add(host, binary, definition) {
  if (host === 'claude') return cli(binary, ['mcp', 'add-json', '--scope', 'user', 'yosh', JSON.stringify(definition)]);
  const scope = host === 'grok' ? ['--scope', 'user'] : [];
  return cli(binary, ['mcp', 'add', ...scope, 'yosh', '--', definition.command, ...definition.args]);
}

function managed(entry, registration, label) {
  const d = entry?.definition;
  if (!registration || !d || typeof d.command !== 'string' || !isAbsolute(d.command)) return false;
  const args = d.args;
  return basename(d.command) === 'node' && Array.isArray(args) && args.length === 5
    && args[0] === join(dirname(d.command), 'first-use-mcp.cjs') && args[1] === '--registration'
    && args[2] === registration && args[3] === '--label' && args[4] === label;
}

function privateState() {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const stat = lstatSync(profile);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('REGISTRATION_STATE_NOT_PRIVATE');
}

function receipt(host) {
  try {
    const file = join(profile, host + '.id');
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size !== 37) throw new Error('INVALID_REGISTRATION_RECEIPT');
    const id = readFileSync(file, 'utf8').trim();
    if (!uuid.test(id)) throw new Error('INVALID_REGISTRATION_RECEIPT');
    return id;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function stableRegistration(host) {
  const previous = receipt(host);
  if (previous) return previous;
  const id = randomUUID();
  writeFileSync(join(profile, host + '.id'), id + '\n', { flag: 'wx', mode: 0o600 });
  return id;
}

function hostExecutables(host, binary) {
  const primary = realpathSync(binary);
  const paths = [binary, primary];
  // Codex's npm command is a Node wrapper around a native binary. Only bind
  // the actual CLI binary and the installed Desktop distribution to Codex.
  if (host === 'codex') {
    const arch = process.arch === 'arm64' ? ['arm64', 'aarch64'] : ['x64', 'x86_64'];
    const cli = join(dirname(primary), '../node_modules/@openai', 'codex-darwin-' + arch[0],
      'vendor', arch[1] + '-apple-darwin/bin/codex');
    paths.push(cli, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Applications/Codex.app/Contents/Resources/codex');
  }
  const native = paths.filter(path => {
    if (!existsSync(path)) return false;
    const executable = realpathSync(path);
    if (/^(?:node|bun|deno|python[.0-9]*|sh|bash|zsh|electron|ruby|perl)$/i.test(basename(executable))) return false;
    const fd = openSync(executable, 'r');
    try {
      const magic = Buffer.alloc(4);
      // Only a dedicated native image can appear as a distinct macOS process.
      return readSync(fd, magic, 0, 4, 0) === 4 && ['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic.toString('hex'));
    } finally { closeSync(fd); }
  });
  if (!native.length) throw new Error('HOST_DEDICATED_EXECUTABLE_REQUIRED');
  return [...new Set(native)];
}

function bindExecutable(key, label, binary, legacyMember) {
  const executables = hostExecutables(key, binary);
  const registration = stableRegistration(key);
  const binding = JSON.stringify({ version: 1, registration, label, executables, legacyMember }) + '\n';
  const file = join(profile, key + '.peer.json');
  const temporary = file + '.' + randomUUID();
  writeFileSync(temporary, binding, { flag:'wx', mode:0o600 }); renameSync(temporary, file);
  return registration;
}

function isPackagedCodexEntry(entry) {
  const args = entry.definition?.args;
  if (entry.name !== 'yosh_standalone' || entry.enabled === false || !Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string') return false;
  const prefix = join(homedir(), '.codex/plugins/cache/yosh-standalone-testing/yosh-local-dev') + '/';
  return args[0].startsWith(prefix) && cachedLauncher.test(args[0].slice(prefix.length));
}

function knownYosh(entry) {
  const d = entry.definition;
  if (!Array.isArray(d?.args)) return false;
  return d.args.some(arg => typeof arg === 'string' && (
    /(?:^|\/)yosh[^/]*\/.*(?:launch\.sh|mcp\.cjs|first-use-mcp\.cjs)$/i.test(arg) ||
    /\/Yosh[^/]*\.app\/.*mcp\.cjs$/i.test(arg)));
}

// Migrate only the exact previously paired user entry. The old shell
// launcher may redirect to another profile. Keep such definitions untouched.
function classifyLegacyClaude(d) {
  const selected = d?.env?.YOSH_CARD_MEMBER_ID;
  if (typeof selected !== 'string' || !memberUuid.test(selected) || !Array.isArray(d.args)
    || (d.type && d.type !== 'stdio') || Object.hasOwn(d.env, 'YOSH_STANDALONE_DEV_DATA_DIR')
    || (d.env.APP2049_CARD_MEMBER_ID && d.env.APP2049_CARD_MEMBER_ID !== selected)) return;
  const cache = join(homedir(), '.codex/plugins/cache/yosh-standalone-testing/yosh-local-dev') + '/';
  if (['/bin/bash', 'bash', '/bin/sh', 'sh'].includes(d.command) && d.args.length === 1
    && typeof d.args[0] === 'string' && d.args[0].startsWith(cache)
    && cachedLauncher.test(d.args[0].slice(cache.length))) return 'old-launcher';
  if (typeof d.command !== 'string' || !isAbsolute(d.command) || basename(d.command) !== 'node' || d.args.length !== 2
    || d.args[0] !== join(dirname(d.command), 'standalone.cjs') || d.args[1] !== 'install-mcp') return;
  if (d.command === join(runtime, 'node')) return 'current';
  const oldRuntime = dirname(d.command);
  if (dirname(oldRuntime) === dirname(runtime) && /^[0-9a-f]{64}$/.test(basename(oldRuntime))
    && basename(dirname(oldRuntime)) === 'Yosh Local Authorization Runtime Dev') return 'old-runtime';
}

const legacyJournal = join(profile, 'claude-legacy-update.json');
function recoverLegacyClaude(binary, dry) {
  if (!existsSync(legacyJournal)) return;
  const stat = lstatSync(legacyJournal);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 1024 * 1024) throw new Error('INVALID_LEGACY_UPGRADE_JOURNAL');
  const { original, next } = JSON.parse(readFileSync(legacyJournal, 'utf8'));
  const current = () => entries('claude', binary).find(entry => entry.name === 'yosh')?.definition;
  const persisted = current();
  if (!persisted) {
    if (dry) throw new Error('LEGACY_UPGRADE_RECOVERY_NEEDED');
    add('claude', binary, original);
    if (!isDeepStrictEqual(current(), original)) throw new Error('HOST_ROLLBACK_FAILED');
  } else if (!isDeepStrictEqual(persisted, original) && !isDeepStrictEqual(persisted, next)) {
    throw new Error('HOST_ENTRY_CHANGED_DURING_UPDATE');
  }
  if (!dry) unlinkSync(legacyJournal);
}

function replaceLegacyClaude(binary, original, next) {
  const current = () => entries('claude', binary).find(entry => entry.name === 'yosh')?.definition;
  const staged = legacyJournal + '.' + randomUUID();
  writeFileSync(staged, JSON.stringify({ original, next }), { flag: 'wx', mode: 0o600, flush: true });
  renameSync(staged, legacyJournal);
  if (!isDeepStrictEqual(original, current())) throw new Error('HOST_ENTRY_CHANGED');
  try {
    cli(binary, ['mcp', 'remove', '--scope', 'user', 'yosh']);
    add('claude', binary, next);
    if (!isDeepStrictEqual(next, current())) throw new Error('HOST_REGISTRATION_NOT_CONFIRMED');
  } catch {
    // A concurrent claimed name is preserved. An interrupted remove is reversible.
    recoverLegacyClaude(binary, false);
    if (isDeepStrictEqual(next, current())) return;
    throw new Error('HOST_UPDATE_FAILED');
  }
  unlinkSync(legacyJournal);
}

function handle(host, dry, upgradeLegacy) {
  const label = hosts[host];
  const binary = binaryFor(host);
  if (!binary) return 'not-installed';
  if (host === 'claude') recoverLegacyClaude(binary, dry);
  const list = entries(host, binary);
  const old = list.find(entry => entry.name === 'yosh');
  if (old?.enabled === false) return 'preserved-disabled';
  const legacy = host === 'claude' && classifyLegacyClaude(old?.definition);
  if (legacy) {
    if (!dry) bindExecutable(host, label, binary, old.definition.env.YOSH_CARD_MEMBER_ID);
    if (!upgradeLegacy) return 'preserved-existing';
    if (legacy === 'current') return 'legacy-already-current';
    // Claude add-json strips undocumented fields; leave customized entries intact.
    if (Object.keys(old.definition).some(key => !['command', 'args', 'env', 'type'].includes(key))) return 'preserved-custom-settings';
    if (!existsSync(join(runtime, 'standalone.cjs'))) throw new Error('YOSH_RUNTIME_INCOMPLETE');
    if (dry) return 'would-upgrade-legacy';
    replaceLegacyClaude(binary, old.definition, { ...old.definition, command: join(runtime, 'node'),
      args: [join(runtime, 'standalone.cjs'), 'install-mcp'] });
    return 'upgraded-legacy';
  }
  const id = receipt(host);
  if (!managed(old, id, label)) {
    if (host === 'codex' && list.some(isPackagedCodexEntry) && !dry) bindExecutable(host, label, binary, 'default');
    if (list.some(entry => ['yosh', 'yosh_standalone', 'yosh_pay_rc5'].includes(entry.name) && knownYosh(entry))) return 'preserved-existing';
    if (old) return 'name-in-use';
  } else {
    if (old.definition.command === join(runtime, 'node')) {
      if (!dry) bindExecutable(host, label, binary, null);
      return 'already-registered';
    }
    const interchangeable = new Set(['command', 'args', 'name', 'enabled', 'scope', 'type']);
    const custom = Object.entries(old.definition).some(([key, value]) => !interchangeable.has(key)
      && value != null && (typeof value !== 'object' || Object.keys(value).length > 0));
    if (custom || old.timeout != null) return 'preserved-custom-settings';
  }
  if (dry) return old ? 'would-update' : 'would-register';
  const registration = bindExecutable(host, label, binary, null);
  const next = config(label, registration);
  if (old && host === 'claude') {
    // Claude has no replace operation. Restore its original definition on failure.
    cli(binary, ['mcp', 'remove', '--scope', 'user', 'yosh']);
    try { add(host, binary, next); }
    catch {
      if (!entries(host, binary).some(entry => entry.name === 'yosh')) add(host, binary, old.definition);
      throw new Error('HOST_UPDATE_FAILED');
    }
  } else {
    add(host, binary, next);
  }
  const installed = entries(host, binary).find(entry => entry.name === 'yosh');
  if (!managed(installed, registration, label) || installed.definition.command !== next.command) throw new Error('HOST_REGISTRATION_NOT_CONFIRMED');
  return old ? 'updated' : 'registered';
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Register Yosh with installed local agents. Use --interactive to choose connections in a terminal.');
    console.log('Options: --host grok|claude|codex, --dry-run, --upgrade-legacy-clients, --print-config LABEL --executable /absolute/path/to/native-host.');
    console.log('Copy printed config once per independent host.');
    return;
  }
  if ((args.length === 2 || (args.length === 4 && args[2] === '--executable')) && args[0] === '--print-config') {
    const label = args[1];
    if (!label || label !== label.trim() || label.length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label)) throw new Error('INVALID_LABEL');
    const executable = args[3];
    if (!executable || !isAbsolute(executable) || !lstatSync(realpathSync(executable)).isFile()) throw new Error('HOST_EXECUTABLE_REQUIRED');
    accessSync(executable, constants.X_OK);
    const key = 'custom-' + createHash('sha256').update(realpathSync(executable)).digest('hex');
    privateState();
    const registration = bindExecutable(key, label, executable, null);
    console.log(JSON.stringify({ mcpServers: { yosh: config(label, registration) } }, null, 2));
    return;
  }
  let selected = [];
  let dry = false;
  let upgradeLegacy = false;
  let interactive = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--dry-run') dry = true;
    else if (args[index] === '--upgrade-legacy-clients') upgradeLegacy = true;
    else if (args[index] === '--interactive') interactive = true;
    else if (args[index] === '--host' && Object.hasOwn(hosts, args[index + 1])) selected.push(args[++index]);
    else throw new Error('UNKNOWN_ARGUMENT');
  }
  if (interactive && selected.length) throw new Error('INTERACTIVE_HOST_CONFLICT');
  if (!existsSync(join(runtime, 'node')) || !existsSync(join(runtime, 'first-use-mcp.cjs'))) throw new Error('YOSH_RUNTIME_INCOMPLETE');
  if (interactive) {
    const connections = await chooseConnections();
    const dot = connections.includes('dot');
    if (dot) printDotInstructions();
    selected = connections.filter(host => host !== 'dot');
    if (!selected.length) {
      if (!dot && process.exitCode !== 130) console.log('No connections selected.');
      return;
    }
    // The lock holder receives only the selected hosts, so it does not prompt again
    // or fall back to registering every installed host.
    args = [...selected.flatMap(host => ['--host', host]), ...(upgradeLegacy ? ['--upgrade-legacy-clients'] : [])];
  }
  if (!dry && process.env.YOSH_HOST_REGISTRATION_LOCK !== script) {
    privateState();
    // macOS lockf releases the OS lock on crash; keep the inode for concurrent installers.
    const lock = spawnSync('/usr/bin/lockf', ['-k', '-t', '75', join(profile, '.lock'), process.execPath, script, ...args],
      { stdio: 'inherit', env: { ...process.env, YOSH_HOST_REGISTRATION_LOCK: script } });
    process.exitCode = lock.status ?? 1;
    return;
  }
  for (const host of new Set(selected.length ? selected : Object.keys(hosts))) {
    try {
      const status = handle(host, dry, upgradeLegacy);
      console.log(host + '  ' + status);
      if (status === 'name-in-use' || (selected.length && status === 'not-installed')) process.exitCode = 1;
    } catch (error) {
      const reason = /^[A-Z_]+$/.test(error.message) ? error.message : 'HOST_CONFIG_UNREADABLE';
      console.error(host + '  ' + reason);
      process.exitCode = 1;
    }
  }
}
process.umask(0o077);
main(process.argv.slice(2)).catch(error => {
  console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_REGISTRATION_FAILED');
  process.exitCode = 1;
});
