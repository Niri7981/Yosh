import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { acquireDataDirectoryOwnership } from '../app/data-directory-owner';
import { hash } from '../purchases/spending-policy';
import type { PaymentConfig } from './payment-config';
import { admitMainnetDevelopment, isMainnetDevelopment } from '../pay-dev/environment';
import { MAINNET_NETWORK, MAINNET_USDC_MINT } from './payment-environment';
import { SolanaPublicKeySchema } from '../resources/http-resource';

export function privatePayJson(directory: string, name: string): unknown {
  const folder = lstatSync(directory);
  const path = join(directory, name), info = lstatSync(path);
  if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== process.getuid?.() || (folder.mode & 0o777) !== 0o700
    || !info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 32_768)
    throw new Error('PAY_PRIVATE_CONTROL_REQUIRED');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
function writeControl(directory: string, name: string, value: unknown) {
  const temporary = join(directory, `.${randomUUID()}.json`);
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true });
  renameSync(temporary, join(directory, name));
  const handle = openSync(directory, 'r');
  try { fsyncSync(handle); } finally { closeSync(handle); }
}
export function writePayMainnetDescriptor(directory: string, origin: string, memberId: string) {
  writeControl(directory, 'pay-mainnet-runtime.json', { version: 1, profile: 'pay-mcp-mainnet', origin, memberId });
}
const Cutover = z.object({ version: z.literal(1), profile: z.literal('pay-mcp-mainnet'), directory: z.string(),
  stoppedPids: z.array(z.number().int().positive()).min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  backup: z.string(), state: z.enum(['prepared', 'admitted']) }).strict();
const sha = (path: string) => {
  const digest = createHash('sha256');
  // WAL/journal are durable economic evidence after a crash. SHM is only a
  // rebuildable index and must not be mistaken for authoritative payment data.
  for (const suffix of ['', '-wal', '-journal']) if (existsSync(path + suffix)) {
    const bytes = readFileSync(path + suffix);
    digest.update(`${suffix}:${bytes.length}:`).update(bytes);
  }
  return digest.digest('hex');
};
function assertStopped(pids: number[]) {
  for (const pid of pids) {
    try { process.kill(pid, 0); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') continue; throw error; }
    throw new Error('PAY_OLD_PROCESS_STILL_RUNNING');
  }
}
/** Run only after the existing graceful App shutdown. It never kills a process,
 * signs, recovers, migrates, or replaces a database. The lock excludes new owners
 * while a consistent archival copy and explicit cutover receipt are created. */
export function preparePayMainnetCutover(directory: string, stoppedPids: number[]) {
  if (!stoppedPids.length || stoppedPids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('PAY_STOPPED_PIDS_REQUIRED');
  assertStopped(stoppedPids);
  if (realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink() || (lstatSync(directory).mode & 0o777) !== 0o700)
    throw new Error('PAY_PRIVATE_CONTROL_REQUIRED');
  const lease = acquireDataDirectoryOwnership(directory);
  try {
    const ledgerPath = join(directory, 'app-ledger.sqlite');
    const info = lstatSync(ledgerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('PAY_STORAGE_REJECTED');
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(ledgerPath + suffix)) {
      const file = lstatSync(ledgerPath + suffix);
      if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.()) throw new Error('PAY_STORAGE_REJECTED');
    }
    const backup = `pre-pay-mainnet-${randomUUID()}.sqlite`;
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try { db.prepare('VACUUM INTO ?').run(join(directory, backup)); } finally { db.close(); }
    chmodSync(join(directory, backup), 0o600);
    assertStopped(stoppedPids);
    const receipt = Cutover.parse({ version: 1, profile: 'pay-mcp-mainnet', directory, stoppedPids,
      sourceSha256: sha(ledgerPath), backup, state: 'prepared' });
    writeControl(directory, 'pay-mainnet-cutover.json', receipt);
    return { prepared: true, backup, paymentEnabled: false };
  } finally { lease.release(); }
}
/** Called with the AppRuntime owner already held, BEFORE opening the Ledger.
 * Persist admission before migrations so a crash cannot make the old digest a
 * reason to replace evidence. Only the new version runs after this cutover. */
export function admitPayMainnetRuntime(directory: string) {
  if (process.env.YOSH_PAY_MCP_MAINNET !== '1') throw new Error('PAY_MAINNET_EXPLICIT_ENABLE_REQUIRED');
  if (isMainnetDevelopment(directory)) { admitMainnetDevelopment(directory); return; }
  const receipt = Cutover.parse(privatePayJson(directory, 'pay-mainnet-cutover.json'));
  if (receipt.directory !== realpathSync(directory)) throw new Error('PAY_CUTOVER_DIRECTORY_MISMATCH');
  if (receipt.state === 'prepared') {
    assertStopped(receipt.stoppedPids);
    if (sha(join(directory, 'app-ledger.sqlite')) !== receipt.sourceSha256) throw new Error('PAY_CUTOVER_LEDGER_CHANGED');
    writeControl(directory, 'pay-mainnet-cutover.json', { ...receipt, state: 'admitted' });
  }
}
const Acceptance = z.object({ version: z.literal(2), callerId: z.string().uuid(), operationId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
  resourceId: z.string().min(1).max(200), providerId: z.string().min(1).max(200), resourceUrl: z.url().refine(value => new URL(value).protocol === 'https:'),
  wallet: SolanaPublicKeySchema, network: z.literal(MAINNET_NETWORK), asset: z.literal(MAINNET_USDC_MINT), recipient: SolanaPublicKeySchema,
  amountAtomic: z.string().regex(/^[1-9]\d*$/).max(20),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), quoteHash: z.string().regex(/^[a-f0-9]{64}$/),
  challengeHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().safe() }).strict();
export function recordPayMainnetAcceptance(directory: string, raw: unknown) {
  const receipt = Acceptance.parse(raw);
  if (receipt.expiresAt <= Date.now()) throw new Error('PAY_MAINNET_ACCEPTANCE_EXPIRED');
  // The operator command is not exposed to MCP or any Agent-facing route.
  privatePayJson(directory, isMainnetDevelopment(directory) ? 'pay-development-mainnet.json' : 'pay-mainnet-cutover.json');
  writeControl(directory, 'pay-mainnet-acceptance.json', receipt);
}
/** A private operator receipt, never a model-supplied approved flag. It binds
 * exactly one operation; the existing Ledger prevents its second consumption. */
export function assertPayMainnetAcceptance(directory: string, config: PaymentConfig, facts: {
  caller_id: string; operation_id: string; request: unknown; accepted: unknown; payment_required: unknown;
  network: string; asset: string; recipient: string; amount_atomic: string;
}, resource: { resourceId: string; providerId: string; resourceUrl: string }) {
  const receipt = Acceptance.parse(privatePayJson(directory, 'pay-mainnet-acceptance.json'));
  if (receipt.expiresAt <= Date.now() || receipt.wallet !== config.buyer || receipt.callerId !== facts.caller_id
    || receipt.operationId !== facts.operation_id || receipt.network !== facts.network || receipt.asset !== facts.asset
    || receipt.network !== config.network || receipt.asset !== config.mint || receipt.recipient !== facts.recipient
    || receipt.amountAtomic !== facts.amount_atomic || receipt.requestHash !== hash(facts.request)
    || receipt.quoteHash !== hash(facts.accepted) || receipt.challengeHash !== hash(facts.payment_required)
    || receipt.resourceId !== resource.resourceId || receipt.providerId !== resource.providerId || receipt.resourceUrl !== resource.resourceUrl)
    throw new Error('PAY_MAINNET_ACCEPTANCE_REQUIRED');
}
