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

const failureCodes = {
  preparation: 'PAY_PREPARATION_FAILED', unsigned_decode: 'PAY_UNSIGNED_DECODE_FAILED',
  unsigned_bindings: 'PAY_UNSIGNED_BINDINGS_FAILED', preflight: 'PAY_PREFLIGHT_FAILED', simulation: 'PAY_SIMULATION_FAILED',
  signer_authorization: 'PAY_SIGNER_AUTHORIZATION_FAILED', signer_load: 'PAY_SIGNER_LOAD_FAILED',
  transaction_decode: 'PAY_TRANSACTION_DECODE_FAILED', signing: 'PAY_SIGNING_FAILED', signature_validation: 'PAY_SIGNATURE_VALIDATION_FAILED',
  payload_encode: 'PAY_PAYLOAD_ENCODE_FAILED', payload_persistence: 'PAY_PAYLOAD_PERSISTENCE_FAILED',
  submission_prepare: 'PAY_SUBMISSION_PREPARE_FAILED', submission: 'PAY_SUBMISSION_FAILED',
  settlement_reconciliation: 'PAY_SETTLEMENT_RECONCILIATION_FAILED', delivery: 'PAY_DELIVERY_FAILED',
} as const;
export type PaymentFailureStage = keyof typeof failureCodes;
const paymentDetails = z.object({
  failureStage: z.enum(Object.keys(failureCodes) as [PaymentFailureStage, ...PaymentFailureStage[]]).optional(),
  failureCode: z.enum(Object.values(failureCodes)).optional(),
  purchaseId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/).optional(),
  rpcMethod: z.enum(['getGenesisHash', 'getLatestBlockhash', 'getMultipleAccounts', 'getBalance', 'simulateTransaction',
    'getSignatureStatuses', 'getSignaturesForAddress', 'getTransaction', 'getBlockHeight']).optional(),
  rpcHttpStatus: z.number().int().min(100).max(599).optional(),
  rpcFailureCode: z.enum(['HTTP_ERROR', 'RPC_REJECTED', 'INVALID_RESPONSE', 'TIMEOUT', 'TRANSPORT_ERROR']).optional(),
  transportCode: z.enum(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EACCES', 'ERR_TLS_CERT_ALTNAME_INVALID']).optional(),
}).strict();
const paymentFailures = new WeakMap<object, z.infer<typeof paymentDetails>>();

/** Keep only allowlisted facts across the purchase layer's deliberately generic error. */
export function paymentFailure(error: unknown, stage: PaymentFailureStage, purchaseId?: string, replacement?: Error): Error {
  const source = error instanceof Error ? error : new Error('PAYMENT_EXECUTION_FAILED');
  const target = replacement ?? source;
  const id = paymentDetails.shape.purchaseId.safeParse(purchaseId);
  paymentFailures.set(target, { failureStage: stage, failureCode: failureCodes[stage], ...paymentFailures.get(source),
    ...(id.success && id.data ? { purchaseId: id.data } : {}) });
  return target;
}

/** Never retain an RPC URL, response body, error message, params or signed bytes. */
export function rpcFailure(error: unknown, method: string, details: Pick<z.infer<typeof paymentDetails>, 'rpcHttpStatus' | 'rpcFailureCode'> = {}): Error {
  const target = error instanceof Error ? error : new Error('PAYMENT_RPC_FAILED');
  const rpcMethod = paymentDetails.shape.rpcMethod.safeParse(method);
  const cause = error instanceof Error && 'cause' in error ? error.cause : error;
  const transport = paymentDetails.shape.transportCode.safeParse(typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined);
  const timeout = target.name === 'TimeoutError' || target.name === 'AbortError' || (transport.success && transport.data === 'ETIMEDOUT');
  const safe = paymentDetails.parse({ ...details, ...(rpcMethod.success ? { rpcMethod: rpcMethod.data } : {}),
    rpcFailureCode: details.rpcFailureCode ?? (timeout ? 'TIMEOUT' : 'TRANSPORT_ERROR'),
    ...(transport.success && transport.data ? { transportCode: transport.data } : {}) });
  paymentFailures.set(target, { ...safe, ...paymentFailures.get(target) });
  return target;
}

export function copyPaymentFailure(source: unknown, replacement: Error): Error {
  if (source instanceof Error && paymentFailures.has(source)) paymentFailures.set(replacement, paymentFailures.get(source)!);
  return replacement;
}

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
  ...paymentDetails.shape,
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
  const details = error instanceof Error ? paymentFailures.get(error) : undefined;
  return { code: details?.rpcFailureCode ? 'CONTROLLER_RPC_FAILED' as const : error instanceof z.ZodError ? 'CONTROLLER_INPUT_INVALID' as const
    : /RECOVERY_REQUIRED|RECOVERY_UNAVAILABLE/.test(message) ? 'CONTROLLER_RECOVERY_REQUIRED' as const
      : /BINDING|FENCED|MISMATCH|STALE/.test(message) ? 'CONTROLLER_BINDING_REJECTED' as const
        : /^RPC |PAY_RPC_/.test(message) ? 'CONTROLLER_RPC_FAILED' as const : 'CONTROLLER_INTERNAL_ERROR' as const,
    ...(transportCode.success && transportCode.data ? { transportCode: transportCode.data } : {}),
    ...(backendCode.success ? { backendCode: backendCode.data } : {}),
    ...details,
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
