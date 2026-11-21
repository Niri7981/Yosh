/** Run on the HTTPS relay or on the Mac; neither command reads Yosh credentials. */
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { startMacReadForwarder, startRemoteReadRelay } from '../src/modules/remote/forwarder';

function port(value: string | undefined) {
  if (!value || !/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) throw new Error('INVALID_PORT');
  return Number(value);
}
async function checkedFile(path: string | undefined, privateKey: boolean) {
  // SSH config expands percent, dollar, and quote syntax even in -o arguments.
  if (!path || !isAbsolute(path) || /[%$"\\\x00-\x1f\x7f]/.test(path)) throw new Error('INVALID_SSH_FILE');
  const info = await lstat(path);
  if (!info.isFile() || (privateKey ? (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    : ((info.uid !== 0 && info.uid !== process.getuid?.()) || (info.mode & 0o022) !== 0))) throw new Error('UNSAFE_SSH_FILE');
  return path;
}
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort()); process.once('SIGINT', () => stop.abort());

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'relay') {
    const {values} = parseArgs({args, options: {'listen-port': {type: 'string'}, 'tunnel-port': {type: 'string'}}});
    const relay = await startRemoteReadRelay({listenPort: port(values['listen-port']), tunnelPort: port(values['tunnel-port'])});
    process.stdout.write('Yosh read relay listening on loopback port ' + relay.port + '\n');
    try { await waitForStop(); } finally { await relay.close(); }
    return;
  }
  if (action !== 'connect') throw new Error('EXPECTED_RELAY_OR_CONNECT');
  const {values} = parseArgs({args, options: { 'backend-port': {type: 'string'}, 'tunnel-port': {type: 'string'},
    'ssh-host': {type: 'string'}, 'ssh-user': {type: 'string'}, 'ssh-port': {type: 'string', default: '22'},
    'known-hosts': {type: 'string'}, identity: {type: 'string'} } });
  const host = values['ssh-host'], user = values['ssh-user'];
  if (!host || host.length > 253 || !host.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
    || !user || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(user)) throw new Error('INVALID_SSH_PEER');
  const sshPort = port(values['ssh-port']), tunnelPort = port(values['tunnel-port']);
  const knownHosts = await checkedFile(values['known-hosts'], false), identity = await checkedFile(values.identity, true);
  const mac = await startMacReadForwarder({backendPort: port(values['backend-port'])});
  try {
    const ssh = ['-F', '/dev/null', '-T', '-n', '-N', '-a', '-x', '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'PreferredAuthentications=publickey',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UserKnownHostsFile="' + knownHosts + '"',
      '-o', 'UpdateHostKeys=no', '-o', 'ConnectTimeout=6', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
      '-o', 'ExitOnForwardFailure=yes', '-i', identity, '-p', String(sshPort), '-l', user,
      '-R', '127.0.0.1:' + tunnelPort + ':' + mac.socketPath, '--', host];
    process.stdout.write('Yosh read connector started; establishing pinned SSH tunnel.\n');
    let pause = 1000;
    while (!stop.signal.aborted) {
      const start = Date.now();
      const child = spawn('/usr/bin/ssh', ssh, { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C', NODE_ENV: 'production' } });
      const terminate = () => child.kill('SIGTERM');
      stop.signal.addEventListener('abort', terminate, {once: true});
      try { await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); }); }
      finally { stop.signal.removeEventListener('abort', terminate); }
      if (stop.signal.aborted) break;
      if (Date.now() - start >= 60_000) pause = 1000;
      process.stderr.write('Yosh read tunnel unavailable; retrying.\n');
      await sleep(pause, undefined, {signal: stop.signal}).catch(error => { if (!stop.signal.aborted) throw error; });
      pause = Math.min(30_000, pause * 2);
    }
  } finally { await mac.close(); }
}
function waitForStop() {
  return new Promise<void>(resolve => { if (stop.signal.aborted) resolve(); else stop.signal.addEventListener('abort', () => resolve(), {once:true}); });
}
void main().catch(() => { process.stderr.write('Yosh read transport failed; check command arguments, port and SSH configuration.\n'); process.exitCode = 1; });
