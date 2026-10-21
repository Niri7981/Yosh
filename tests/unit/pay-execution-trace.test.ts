import { mkdtempSync, readFileSync, rmSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { readPayTrace, recordPayTrace } from '../../src/modules/payment/pay-execution-trace';

const stages = ['paid_fetch_entered', 'x402_quote_selected', 'authority_requested', 'authority_allowed',
  'controlled_started', 'unsigned_prepared', 'controlled_response', 'protocol_interpreted'];
it('correlates actual process fields to one caller/operation/attempt, retains evidence across reopen, and cannot infer missing stages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pay-trace-'));
  const id = { callerId: randomUUID(), operationId: 'one-operation', attemptId: randomUUID() };
  const emit = (stage: string, fields = {}) => recordPayTrace(dir, id.callerId, 'a'.repeat(64), JSON.stringify({ target: 'pay_execution',
    fields: { version: 1, caller_id: id.callerId, operation_id: id.operationId, attempt_id: id.attemptId, stage, ...fields } }));
  try {
    expect(readPayTrace(dir, id)).toBeUndefined();
    emit(stages[0]); expect(readPayTrace(dir, id)?.complete).toBe(false);
    emit('protocol_interpreted', { caller_id: randomUUID() });
    emit('protocol_interpreted', { credential: 'secret-must-never-be-stored' });
    for (const stage of stages.slice(1)) emit(stage);
    expect(readPayTrace(dir, id)).toMatchObject({ complete: true, traceId: id.attemptId, binarySha256: 'a'.repeat(64) });
    expect(readPayTrace(dir, id)?.events.map(event => event.stage)).toEqual(stages);
    expect(readPayTrace(dir, { ...id, attemptId: randomUUID() })).toBeUndefined();
    const file = join(dir, 'pay-execution-traces', readdirSync(join(dir, 'pay-execution-traces'))[0]);
    expect(readFileSync(file, 'utf8')).not.toContain('secret');
    writeFileSync(file, '{}\n', { flag: 'a' });
    expect(readPayTrace(dir, id)).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('rejects redirected trace storage and bounds per-attempt evidence without changing a ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pay-trace-'));
  const target = mkdtempSync(join(tmpdir(), 'pay-trace-target-'));
  const id = { callerId: randomUUID(), operationId: 'bounded', attemptId: randomUUID() };
  const line = JSON.stringify({ target: 'pay_execution', fields: { version: 1, caller_id: id.callerId,
    operation_id: id.operationId, attempt_id: id.attemptId, stage: 'paid_fetch_entered' } });
  try {
    symlinkSync(target, join(dir, 'pay-execution-traces'));
    expect(() => recordPayTrace(dir, id.callerId, 'a'.repeat(64), line)).toThrow('PAY_TRACE_STORAGE_REJECTED');
    expect(readdirSync(target)).toHaveLength(0);
    rmSync(join(dir, 'pay-execution-traces'));
    for (let i = 0; i < 90; i++) recordPayTrace(dir, id.callerId, 'a'.repeat(64), line);
    expect(() => { for (let i = 0; i < 90; i++) recordPayTrace(dir, id.callerId, 'a'.repeat(64), line); }).toThrow('PAY_TRACE_LIMIT');
    expect(readPayTrace(dir, id)?.complete).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});
