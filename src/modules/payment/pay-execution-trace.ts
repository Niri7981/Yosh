import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync, fsyncSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { hash } from '../purchases/spending-policy';

export const PayTraceStage = z.enum(['paid_fetch_entered', 'x402_quote_selected', 'authority_requested',
  'authority_allowed', 'authority_denied', 'authority_unavailable', 'authority_timeout', 'controlled_started',
  'unsigned_prepared', 'controlled_replay', 'controlled_response', 'protocol_interpreted', 'protocol_failed']);
const Identity = z.object({ callerId: z.uuid(), operationId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/), attemptId: z.uuid() });
const Event = Identity.extend({ version: z.literal(1), stage: PayTraceStage, at: z.number().int().nonnegative(),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Identity = z.infer<typeof Identity>;
const MAX_BYTES = 32_768;
const buildStages = ['paid_fetch_entered', 'x402_quote_selected', 'authority_requested', 'authority_allowed',
  'controlled_started', 'unsigned_prepared', 'controlled_response', 'protocol_interpreted'];

function tracePath(directory: string, identity: Identity) {
  return join(directory, 'pay-execution-traces', `${hash(Identity.parse(identity))}.jsonl`);
}
function assertPrivate(metadata: Stats, directory = false) {
  if ((directory ? !metadata.isDirectory() : !metadata.isFile()) || metadata.isSymbolicLink()
    || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error('PAY_TRACE_STORAGE_REJECTED');
}

/** Observational metadata only, never an authorization, receipt or second ledger.
 * Capture fixed fields from the actual Pay process's filtered tracing stream.
 * Failure to record evidence must not rewrite an original payment outcome. */
export function recordPayTrace(directory: string, callerId: string, binarySha256: string, line: string) {
  if (Buffer.byteLength(line) > 2048) return;
  let parsed: unknown;
  try { parsed = JSON.parse(line) as unknown; } catch { return; }
  const input = z.object({ target: z.literal('pay_execution'), fields: z.object({ version: z.literal(1),
    caller_id: z.uuid(), operation_id: Identity.shape.operationId, attempt_id: z.uuid(), stage: PayTraceStage }).strict() }).passthrough().safeParse(parsed);
  if (!input.success || input.data.fields.caller_id !== callerId) return;
  const fields = input.data.fields;
  const event = Event.parse({ version: 1, callerId, operationId: fields.operation_id, attemptId: fields.attempt_id,
    stage: fields.stage, at: Date.now(), binarySha256 });
  assertPrivate(lstatSync(directory), true);
  const folder = join(directory, 'pay-execution-traces'); mkdirSync(folder, { mode: 0o700, recursive: true });
  assertPrivate(lstatSync(folder), true);
  const file = openSync(tracePath(directory, event), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const metadata = fstatSync(file); assertPrivate(metadata);
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
    if (metadata.size + bytes.length > MAX_BYTES) throw new Error('PAY_TRACE_LIMIT');
    writeSync(file, bytes); fsyncSync(file);
  } finally { closeSync(file); }
}

export function readPayTrace(directory: string, identity: Identity) {
  try {
    assertPrivate(lstatSync(directory), true);
    assertPrivate(lstatSync(join(directory, 'pay-execution-traces')), true);
    const file = openSync(tracePath(directory, identity), constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const metadata = fstatSync(file); assertPrivate(metadata);
      if (metadata.size > MAX_BYTES) return;
      text = readFileSync(file, 'utf8');
    } finally { closeSync(file); }
    const events = text.trim().split('\n').map(line => Event.parse(JSON.parse(line)));
    if (!events.length || events.some(event => event.callerId !== identity.callerId || event.operationId !== identity.operationId
      || event.attemptId !== identity.attemptId || event.binarySha256 !== events[0].binarySha256)) return;
    const stages = events.map(event => event.stage);
    return { traceId: identity.attemptId, operationId: identity.operationId, binarySha256: events[0].binarySha256,
      complete: JSON.stringify(stages) === JSON.stringify(buildStages), events: events.map(({ stage, at }) => ({ stage, at })) };
  } catch { return; } // Missing/corrupt historical evidence is unavailable, never invented.
}
