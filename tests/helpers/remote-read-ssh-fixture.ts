import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  await new Promise<void>(done => server.close(() => done()));
  if (!address || typeof address === 'string') throw new Error('TEST_PORT_REQUIRED');
  return address.port;
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
}
async function listening(port: number, child: ChildProcess) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('TEST_SSH_PROCESS_EXITED');
    const ready = await new Promise<boolean>(done => {
      const connection = createConnection({ host: '127.0.0.1', port });
      connection.once('connect', () => { connection.destroy(); done(true); });
      connection.once('error', () => done(false));
    });
    if (ready) return;
    await delay(25);
  }
  throw new Error('TEST_SSH_PORT_NOT_READY');
}

/** Use only ephemeral keys and loopback listeners. MaxSessions 0 disables
 * remote shells; this account is usable solely for the one permitted forward. */
export async function testingSshHost() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-read-sshd-')));
  let server: ChildProcess | undefined, client: ChildProcess | undefined;
  const stopLink = async () => { await stop(client); client = undefined; };
  const close = async () => { await stopLink(); await stop(server); rmSync(dir, { force: true, recursive: true }); };
  try {
    const port = await unusedPort(); let tunnelPort = await unusedPort();
    while (port === tunnelPort) tunnelPort = await unusedPort();
    for (const name of ['host', 'client']) execFileSync('/usr/bin/ssh-keygen', ['-q','-t','ed25519','-N','','-f', join(dir, name)]);
    writeFileSync(join(dir, 'known'), '[127.0.0.1]:' + port + ' ' + readFileSync(join(dir, 'host.pub'), 'utf8'), { mode: 0o600 });
    writeFileSync(join(dir, 'sshd_config'), [
      'Port ' + port, 'ListenAddress 127.0.0.1', 'HostKey ' + join(dir,'host'), 'PidFile ' + join(dir,'pid'),
      'AuthorizedKeysFile ' + join(dir,'client.pub'), 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
      'HostbasedAuthentication no', 'UsePAM no', 'AuthenticationMethods publickey', 'AllowTcpForwarding remote',
      'AllowStreamLocalForwarding no', 'MaxSessions 0', 'PermitTTY no', 'AllowAgentForwarding no', 'X11Forwarding no',
      'AllowUsers ' + userInfo().username, 'PermitListen 127.0.0.1:' + tunnelPort, '',
    ].join('\n'), { mode: 0o600 });
    server = spawn('/usr/sbin/sshd',['-D','-e','-f',join(dir,'sshd_config')], { stdio: 'ignore' });
    await listening(port, server);
    return { tunnelPort, stopLink, close, dropTransport() {
      if (!client?.pid) throw new Error('TEST_CONNECTOR_NOT_STARTED');
      const child = execFileSync('/usr/bin/pgrep', ['-P', String(client.pid), '-x', 'ssh'], { encoding:'utf8' }).trim();
      if (!/^[1-9]\d*$/.test(child)) throw new Error('TEST_SSH_CHILD_NOT_FOUND');
      process.kill(Number(child), 'SIGTERM');
    }, async connect(backendPort: number) {
      if (client) throw new Error('TEST_SSH_LINK_ALREADY_STARTED');
      client = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/remote-read-transport.ts'),
        'connect','--backend-port',String(backendPort),'--tunnel-port',String(tunnelPort),'--ssh-host','127.0.0.1',
        '--ssh-port',String(port),'--ssh-user',userInfo().username,'--known-hosts',join(dir,'known'),'--identity',join(dir,'client')],
      { cwd: dir, env: { HOME: dir, PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, stdio: 'ignore' });
      await listening(tunnelPort, client);
    } };
  } catch (error) { await close(); throw error; }
}
