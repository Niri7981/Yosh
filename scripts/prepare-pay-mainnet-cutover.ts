import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { preparePayMainnetCutover } from '../src/modules/payment/pay-mainnet-control';

// Operator-only, AFTER the native App's existing normal Quit has drained the
// backend. No process is killed and no production enablement is written here.
const [flag, directory, nativePid, backendPid, port = '3049', ...extra] = process.argv.slice(2);
if (flag !== '--prepare-stopped-upgrade' || !directory || extra.length || ![nativePid, backendPid, port].every(value => /^\d+$/.test(value ?? '')))
  throw new Error('PAY_CUTOVER_ARGUMENTS_REQUIRED');
try {
  execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'], { stdio: ['ignore', 'pipe', 'pipe'] });
  throw new Error('PAY_OLD_SERVICE_STILL_LISTENING');
} catch (error) {
  if (!(error instanceof Error && 'status' in error && error.status === 1)) throw new Error('PAY_OLD_SERVICE_NOT_VERIFIED_STOPPED');
}
const result = preparePayMainnetCutover(realpathSync(directory), [Number(nativePid), Number(backendPid)]);
process.stdout.write(`${JSON.stringify(result)}\n`);
