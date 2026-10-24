import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { smallJson } from '../http/local-request';

// Matches the existing controlled HTTP socket cap; ordinary management stays 8 KiB.
export const MAX_CONTROLLER_REQUEST_BYTES = 131_072;
export const readControllerJson = (request: Request) => smallJson(request, MAX_CONTROLLER_REQUEST_BYTES);
const validationStages = z.enum(['http_input', 'facts', 'rpc_lifetime', 'unsigned_result', 'execute_unsigned']);
type ValidationStage = z.infer<typeof validationStages>;
const stages = new WeakMap<object, ValidationStage>();
const unsignedFailureCodes = z.enum(['INVALID_PREFLIGHT_INPUT', 'INVALID_URL', 'UNSUPPORTED_CHALLENGE', 'INVALID_LIFETIME', 'INVALID_BLOCKHASH', 'CHALLENGE_BLOCKHASH_MISMATCH', 'INVALID_PAYER', 'RUNTIME_UNAVAILABLE', 'UNSIGNED_PREPARE_FAILED', 'SIGNED_TRANSACTION_FORBIDDEN', 'WIRE_ENCODING_FAILED', 'PREFLIGHT_INPUT_UNAVAILABLE', 'PREFLIGHT_INPUT_TOO_LARGE']);
const unsignedFailures = new WeakMap<object, z.infer<typeof unsignedFailureCodes>>();
export async function controllerValidationStage<T>(stage: ValidationStage, action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof z.ZodError && !stages.has(error)) stages.set(error, stage);
    throw error;
  }
}
export function parseControllerInput<T>(schema: z.ZodType<T>, raw: unknown, stage: ValidationStage): T {
  try { return schema.parse(raw); } catch (error) {
    if (error instanceof z.ZodError) {
      stages.set(error, stage);
      if (stage === 'unsigned_result') {
        const result = z.object({ ok: z.literal(false), code: unsignedFailureCodes }).safeParse(raw);
        if (result.success) unsignedFailures.set(error, result.data.code);
      }
    }
    throw error;
  }
}
const categories = z.enum(['string', 'number', 'boolean', 'object', 'array', 'null', 'undefined', 'unknown']);
const safeFields = new Set(['facts', 'unsigned', 'transaction', 'recentBlockhash', 'lastValidBlockHeight', 'operationId', 'operation_id', 'attempt_id', 'caller_id', 'request', 'method', 'url', 'headers', 'body', 'execution_network', 'network', 'asset', 'recipient', 'amount_atomic', 'accepted', 'payment_required', 'ok', 'result', 'value', 'blockhash']);


export const ControllerDiagnostic = z.object({
  target: z.literal('yosh_controller'), version: z.literal(1), callerId: z.uuid(),
  operationId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/), attemptId: z.uuid().nullable(),
  stage: z.enum(['plan', 'execute', 'recover']),
  code: z.enum(['CONTROLLED_TRANSPORT_UNAVAILABLE', 'CONTROLLED_TIMEOUT', 'CONTROLLED_BACKEND_REJECTED',
    'CONTROLLED_RESPONSE_READ_FAILED', 'CONTROLLED_RESPONSE_TOO_LARGE', 'CONTROLLED_RESPONSE_INVALID',
    'CONTROLLED_PLAN_INVALID', 'CONTROLLER_INTERNAL_ERROR', 'CONTROLLER_BINDING_REJECTED',
    'CONTROLLER_RPC_FAILED', 'CONTROLLER_RECOVERY_REQUIRED', 'CONTROLLER_INPUT_INVALID']),
  endpoint: z.enum(['/pay/plan', '/pay/execute', '/pay/recover']).optional(),
  validationStage: validationStages.optional(),
  unsignedFailureCode: unsignedFailureCodes.optional(),
  issues: z.array(z.object({ path: z.array(z.union([z.number().int().nonnegative(), z.string().refine(value => safeFields.has(value) || value === '[redacted]')])).max(16),
    code: z.enum(['invalid_type', 'invalid_value', 'invalid_format', 'too_big', 'too_small', 'unrecognized_keys', 'invalid_union', 'custom', 'other']),
    expected: categories.optional(), received: categories.optional() }).strict()).max(8).optional(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  transportCode: z.enum(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EACCES', 'ERR_TLS_CERT_ALTNAME_INVALID']).optional(),
  backendCode: z.enum(['EXTERNAL_EXECUTION_FENCED', 'PAY_ATTEMPT_BINDING_MISMATCH', 'PAY_STALE_OR_CHANGED_ATTEMPT',
    'PAY_MAINNET_CONFIGURATION_REQUIRED', 'PAY_RPC_NETWORK_MISMATCH', 'PAY_ORIGINAL_PAYMENT_RECOVERY_REQUIRED',
    'PAY_PREPAYMENT_RECOVERY_UNAVAILABLE', 'PAY_DURABLE_RECOVERY_REQUIRED', 'PAY_AUTHORIZATION_REJECTED',
    'PAY_ECONOMIC_FACTS_MISMATCH', 'PAY_OPERATION_ALREADY_STARTED', 'PAY_OPERATION_ALREADY_PLANNED',
    'CONTROLLER_INPUT_INVALID', 'PAY_MAINNET_NOT_ENABLED', 'PAY_RESOURCE_NOT_REGISTERED', 'PAY_PRODUCTION_BLOCKED', 'SERVICE_STOPPING']).optional(),
}).strict();

/** Bounded operational evidence only. Never accepts arbitrary error text or payloads. */
export function recordControllerDiagnostic(directory: string, raw: unknown, callerId?: string) {
  const value = ControllerDiagnostic.parse(raw);
  if (callerId && value.callerId !== callerId) return;
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077))
    throw new Error('CONTROLLER_DIAGNOSTICS_STORAGE_REJECTED');
  const fd = openSync(join(directory, 'pay-controller-diagnostics.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 1_000_000)
      throw new Error('CONTROLLER_DIAGNOSTICS_STORAGE_REJECTED');
    writeSync(fd, `${JSON.stringify({ ...value, at: Date.now() })}\n`); fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function controllerBackendDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const transportCode = ControllerDiagnostic.shape.transportCode.safeParse(error instanceof Error && 'code' in error ? error.code : undefined);
  const backendCode = ControllerDiagnostic.shape.backendCode.safeParse(message);
  return { code: error instanceof z.ZodError ? 'CONTROLLER_INPUT_INVALID' as const
    : /RECOVERY_REQUIRED|RECOVERY_UNAVAILABLE/.test(message) ? 'CONTROLLER_RECOVERY_REQUIRED' as const
      : /BINDING|FENCED|MISMATCH|STALE/.test(message) ? 'CONTROLLER_BINDING_REJECTED' as const
        : /^RPC |PAY_RPC_/.test(message) ? 'CONTROLLER_RPC_FAILED' as const : 'CONTROLLER_INTERNAL_ERROR' as const,
    ...(transportCode.success && transportCode.data ? { transportCode: transportCode.data } : {}),
    ...(backendCode.success ? { backendCode: backendCode.data } : {}),
    ...(error instanceof z.ZodError ? { backendCode: 'CONTROLLER_INPUT_INVALID' as const,
      ...(stages.has(error) ? { validationStage: stages.get(error) } : {}),
      ...(unsignedFailures.has(error) ? { unsignedFailureCode: unsignedFailures.get(error) } : {}),
      issues: error.issues.slice(0, 8).map(issue => {
        const code = ControllerDiagnostic.shape.issues.unwrap().element.shape.code.safeParse(issue.code);
        const expected = categories.safeParse('expected' in issue ? issue.expected : undefined);
        return { path: issue.path.slice(0, 16).map(part => typeof part === 'number' ? part : safeFields.has(String(part)) ? String(part) : '[redacted]'),
          code: code.success ? code.data : 'other' as const, ...(expected.success ? { expected: expected.data } : {}) };
      }) } : {}) };
}
