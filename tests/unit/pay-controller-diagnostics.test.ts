import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { parseControllerInput } from '../../src/modules/payment/pay-controller-diagnostics';
import { expect, it } from 'vitest';
import { controllerBackendDiagnostic, recordControllerDiagnostic } from '../../src/modules/payment/pay-controller-diagnostics';
const identity = { target: 'yosh_controller', version: 1, callerId: '8c697f80-b9e3-43f9-bddb-6174416573b7',
  operationId: 'diagnostics-fixture', attemptId: '0d445c54-261a-4cc1-becb-56e2b977abda', stage: 'plan', httpStatus: 400 };
it('durably distinguishes bridge failure classes and excludes secrets and arbitrary backend errors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'controller-diagnostics-')); chmodSync(directory, 0o700);
  try {
    for (const code of ['CONTROLLED_TRANSPORT_UNAVAILABLE', 'CONTROLLED_TIMEOUT', 'CONTROLLED_BACKEND_REJECTED',
      'CONTROLLED_RESPONSE_READ_FAILED', 'CONTROLLED_RESPONSE_INVALID', 'CONTROLLED_PLAN_INVALID'])
      recordControllerDiagnostic(directory, { ...identity, code });
    expect(readFileSync(join(directory, 'pay-controller-diagnostics.jsonl'), 'utf8').trim().split('\n')).toHaveLength(6);
    expect(() => recordControllerDiagnostic(directory, { ...identity, code: 'SECRET_TOKEN' })).toThrow();
    expect(() => recordControllerDiagnostic(directory, { ...identity, code: 'CONTROLLED_PLAN_INVALID', payload: 'SECRET' })).toThrow();
    expect(controllerBackendDiagnostic(new Error('RPC getGenesisHash returned HTTP 429'))).toEqual({ code: 'CONTROLLER_RPC_FAILED' });
    expect(controllerBackendDiagnostic(new Error('EXTERNAL_EXECUTION_FENCED'))).toEqual({ code: 'CONTROLLER_BINDING_REJECTED', backendCode: 'EXTERNAL_EXECUTION_FENCED' });
    expect(JSON.stringify(controllerBackendDiagnostic(new Error('https://SECRET.invalid/key')))).not.toContain('SECRET');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it('refuses a diagnostics symlink', () => {
  const directory = mkdtempSync(join(tmpdir(), 'controller-diagnostics-')); chmodSync(directory, 0o700);
  try {
    symlinkSync(join(directory, 'other'), join(directory, 'pay-controller-diagnostics.jsonl'));
    expect(() => recordControllerDiagnostic(directory, { ...identity, code: 'CONTROLLED_PLAN_INVALID' })).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('records only bounded schema paths/types, never input values, arbitrary keys or Zod messages', () => {
  const schema = z.object({ unsigned: z.object({ transaction: z.string() }).strict() }).strict();
  try { parseControllerInput(schema, { unsigned: { transaction: 42, SECRET_KEY: 'SECRET_VALUE' } }, 'execute_unsigned'); }
  catch (error) {
    const diagnostic = controllerBackendDiagnostic(error);
    expect(diagnostic).toMatchObject({ backendCode: 'CONTROLLER_INPUT_INVALID', validationStage: 'execute_unsigned',
      issues: expect.arrayContaining([{ path: ['unsigned', 'transaction'], code: 'invalid_type', expected: 'string' }]) });
    expect(JSON.stringify(diagnostic)).not.toContain('SECRET');
    const directory = mkdtempSync(join(tmpdir(), 'controller-diagnostics-')); chmodSync(directory, 0o700);
    try { recordControllerDiagnostic(directory, { ...identity, ...diagnostic, endpoint: '/pay/execute' }); }
    finally { rmSync(directory, { recursive: true, force: true }); }
    return;
  }
  throw new Error('FIXTURE_MUST_REJECT');
});
