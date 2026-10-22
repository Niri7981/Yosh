import { z } from 'zod';
import { address } from '@solana/kit';
import { isDeepStrictEqual } from 'node:util';
import { MAX_RESOURCE_BODY_BYTES } from '../http/request-size-limits';
import { PositiveAtomicAmountSchema } from '../authority/atomic-money';

export const SolanaPublicKeySchema = z.string().refine(value => { try { address(value); return true; } catch { return false; } });
export const HttpMethodSchema = z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const text = z.string().max(2048).refine(value => !/[\r\n\0]/.test(value));
/** Only declarative resource facts: no merchant name, wallet source or payment permission. */
export const HttpResourceRequestSchema = z.object({
  url: z.string().max(2048), method: HttpMethodSchema,
  access: z.enum(['https', 'test_loopback']),
  headers: z.object({ accept: text.optional(), 'content-type': text.optional() }).strict(),
  body: z.string().refine(value => Buffer.byteLength(value, 'utf8') <= MAX_RESOURCE_BODY_BYTES).optional(),
}).strict().superRefine((request, ctx) => {
  try {
    const url = new URL(request.url);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const numericHost = /^\d+(?:\.\d+)*$/.test(url.hostname) || url.hostname.startsWith('[');
    const privateHost = loopback || numericHost || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || !url.hostname.includes('.');
    if (url.href !== request.url || url.username || url.password || url.hash || /[\s\0]/.test(request.url)
      || (request.access === 'https' ? url.protocol !== 'https:' || privateHost : !loopback || !['http:', 'https:'].includes(url.protocol))
      || (['GET', 'HEAD'].includes(request.method) && request.body !== undefined)) throw new Error('Invalid request');
  } catch { ctx.addIssue({ code: 'custom', message: 'INVALID_RESOURCE_REQUEST' }); }
});
export type HttpResourceRequest = z.infer<typeof HttpResourceRequestSchema>;
const headerName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,79}$/).refine(value =>
  !['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'host', 'content-length', 'content-type', 'accept', 'origin', 'referer',
    'connection', 'transfer-encoding', 'x-http-method-override', 'x-method-override',
    'payment-signature', 'payment-required', 'payment-response'].includes(value.toLowerCase()) && !/^(sec-|proxy-)/i.test(value));
const headerValue = z.string().min(1).max(240).refine(value => !/[\r\n\0]/.test(value));

/** Server-approved capabilities, never inferred from a merchant name or a 402. */
export const DeliveryRecoveryCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('idempotent_replay') }).strict(),
  z.object({ kind: z.literal('cached_replay'), replayHeader: z.object({ name: headerName, value: headerValue }).strict() }).strict(),
  z.object({ kind: z.literal('payment_identifier'), request: HttpResourceRequestSchema,
    identifier: z.enum(['transaction', 'purchase_id']), location: z.enum(['query', 'header']),
    name: headerName }).strict().superRefine((capability, ctx) => {
      if (capability.request.method !== 'GET' || capability.request.body !== undefined) ctx.addIssue({ code: 'custom', message: 'RECOVERY_REQUIRES_READ_ONLY_REQUEST' });
    }),
]);
export type DeliveryRecoveryCapability = z.infer<typeof DeliveryRecoveryCapabilitySchema>;
export const ResourceDeliveryPolicySchema = z.object({ format: z.enum(['json', 'text']),
  mimeTypes: z.array(z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/)).min(1).max(8),
  maxBytes: z.number().int().min(1).max(262_144) }).strict();
export type ResourceDeliveryPolicy = z.infer<typeof ResourceDeliveryPolicySchema>;

const inputName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/);
const legacyInputNames = z.array(inputName).max(16).refine(names => new Set(names).size === names.length,
  { message: 'RESOURCE_INPUT_POLICY_DUPLICATE' });
const required = z.boolean().optional();
const stringField = z.object({ type: z.literal('string'), required,
  minLength: z.number().int().min(0).max(MAX_RESOURCE_BODY_BYTES).optional(),
  maxLength: z.number().int().min(0).max(MAX_RESOURCE_BODY_BYTES).optional(),
  enum: z.array(z.string().max(MAX_RESOURCE_BODY_BYTES)).min(1).max(32).optional(),
}).strict();
const queryField = stringField.safeExtend({
  minLength: z.number().int().min(1).max(300).optional(),
  maxLength: z.number().int().min(1).max(300).optional(),
  enum: z.array(z.string().min(1).max(300)).min(1).max(32).optional(),
});
const numericBounds = { required, minimum: z.number().finite().optional(), maximum: z.number().finite().optional() };
const jsonField = z.discriminatedUnion('type', [stringField,
  z.object({ type: z.literal('number'), ...numericBounds }).strict(),
  z.object({ type: z.literal('integer'), ...numericBounds }).strict(),
  z.object({ type: z.literal('boolean'), required }).strict(),
  z.object({ type: z.literal('null'), required }).strict(),
  z.object({ type: z.literal('array'), required, minItems: z.number().int().min(0).max(1024).optional(),
    maxItems: z.number().int().min(0).max(1024).optional() }).strict(),
  z.object({ type: z.literal('object'), required, maxProperties: z.number().int().min(0).max(1024).optional() }).strict(),
]);
type InputField = z.infer<typeof jsonField>;
function validFieldBounds(field: InputField) {
  if (field.type === 'string') return (field.minLength ?? 0) <= (field.maxLength ?? MAX_RESOURCE_BODY_BYTES)
    && (!field.enum || field.enum.every(value => value.length >= (field.minLength ?? 0)
      && value.length <= (field.maxLength ?? MAX_RESOURCE_BODY_BYTES)));
  if (field.type === 'number' || field.type === 'integer') return (field.minimum ?? -Infinity) <= (field.maximum ?? Infinity);
  if (field.type === 'array') return (field.minItems ?? 0) <= (field.maxItems ?? 1024);
  return true;
}
const queryPolicy = z.record(inputName, queryField).refine(fields => Object.keys(fields).length <= 16
  && Object.values(fields).every(validFieldBounds), { message: 'RESOURCE_INPUT_POLICY_INVALID' });
const bodyPolicy = z.record(inputName, jsonField).refine(fields => Object.keys(fields).length <= 16
  && Object.values(fields).every(validFieldBounds), { message: 'RESOURCE_INPUT_POLICY_INVALID' });
/** Arrays retain the exact legacy at-least-one semantics; descriptors declare each field. */
export const ResourceRequestInputsSchema = z.object({
  query: z.union([legacyInputNames, queryPolicy]).optional(),
  jsonBody: z.union([legacyInputNames, bodyPolicy]).optional(),
}).strict();
/** New proposals and registrations must declare types; arrays exist only to read old policies. */
export const DeclarativeResourceRequestInputsSchema = ResourceRequestInputsSchema.refine(inputs =>
  !Array.isArray(inputs.query) && !Array.isArray(inputs.jsonBody), { message: 'RESOURCE_INPUT_DESCRIPTORS_REQUIRED' });
type InputPolicy = z.infer<typeof ResourceRequestInputsSchema>['jsonBody'];
export function resourceInputNames(policy: InputPolicy) { return policy === undefined ? [] : Array.isArray(policy) ? policy : Object.keys(policy); }

export const X402ResourceSchema = z.object({
  resourceId: z.string().min(1).max(200), providerId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(120).optional(),
  request: HttpResourceRequestSchema, deliveryRecovery: DeliveryRecoveryCapabilitySchema.optional(),
  deliveryPolicy: ResourceDeliveryPolicySchema.optional(),
  /** Dynamic fields; every other query/body value remains fixed by request. */
  requestInputs: ResourceRequestInputsSchema.optional(),
  network: z.templateLiteral(['solana:', z.string().min(1)]),
  mint: SolanaPublicKeySchema, decimals: z.literal(6), recipient: SolanaPublicKeySchema.optional(),
  recipientSource: z.literal('live_challenge').optional(),
  baseAmount: PositiveAtomicAmountSchema.optional(), maximumAmount: PositiveAtomicAmountSchema.optional(),
  amount: z.string().refine(value => PositiveAtomicAmountSchema.safeParse(value).success).optional(),
}).strict().superRefine((resource, ctx) => {
  // Existing fixed-payee registrations remain compatible. Challenge-derived
  // recipients require an explicit bounded policy, never an implicit wildcard.
  if (resource.recipientSource === 'live_challenge'
    ? resource.recipient !== undefined || resource.maximumAmount === undefined || resource.amount !== undefined
    : resource.recipient === undefined) ctx.addIssue({ code: 'custom', message: 'RESOURCE_RECIPIENT_POLICY_REQUIRED' });
  if (resource.baseAmount !== undefined && (resource.maximumAmount === undefined
    || (PositiveAtomicAmountSchema.safeParse(resource.baseAmount).success && PositiveAtomicAmountSchema.safeParse(resource.maximumAmount).success
      && BigInt(resource.baseAmount) > BigInt(resource.maximumAmount)))) ctx.addIssue({ code: 'custom', message: 'RESOURCE_PRICE_POLICY_INVALID' });
  if (resourceInputNames(resource.requestInputs?.jsonBody).length && (resource.request.method !== 'POST'
    || resource.request.headers['content-type'] !== 'application/json')) ctx.addIssue({ code: 'custom', message: 'RESOURCE_BODY_POLICY_INVALID' });
});
export type X402Resource = z.infer<typeof X402ResourceSchema>;

/** The same input shape is used for a sample quote and an Agent purchase. */
export const ResourceRequestInputSchema = z.object({
  query: z.record(z.string(), z.string().min(1).max(300)).optional(),
  jsonBody: z.record(z.string(), z.json()).optional(),
}).strict();
export type ResourceRequestInput = z.infer<typeof ResourceRequestInputSchema>;

function inputRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function jsonBodyRecord(body: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error('RESOURCE_BODY_POLICY_INVALID'); }
  if (!inputRecord(value)) throw new Error('RESOURCE_BODY_POLICY_INVALID');
  return z.record(z.string(), z.json()).parse(value);
}
/** Registration and the original definition must never allow dynamic replacement of fixed fields. */
export function assertResourceInputDefinition(resource: X402Resource) {
  const query = new URL(resource.request.url).searchParams;
  if (resourceInputNames(resource.requestInputs?.query).some(name => query.has(name))) throw new Error('RESOURCE_QUERY_POLICY_INVALID');
  const allowedBody = resourceInputNames(resource.requestInputs?.jsonBody);
  if (allowedBody.length && resource.request.body !== undefined) {
    const fixed = jsonBodyRecord(resource.request.body);
    if (allowedBody.some(name => Object.hasOwn(fixed, name))) throw new Error('RESOURCE_BODY_POLICY_INVALID');
  }
}
function validInputValue(value: unknown, field: InputField) {
  switch (field.type) {
    case 'string': return typeof value === 'string' && value.length >= (field.minLength ?? 0)
      && value.length <= (field.maxLength ?? MAX_RESOURCE_BODY_BYTES) && (!field.enum || field.enum.includes(value));
    case 'number': case 'integer': return typeof value === 'number' && Number.isFinite(value)
      && (field.type !== 'integer' || Number.isSafeInteger(value))
      && value >= (field.minimum ?? -Infinity) && value <= (field.maximum ?? Infinity);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value) && value.length >= (field.minItems ?? 0) && value.length <= (field.maxItems ?? 1024);
    case 'object': return inputRecord(value) && Object.keys(value).length <= (field.maxProperties ?? 1024);
  }
}
function validateInputFields(values: Record<string, unknown>, policy: InputPolicy) {
  const names = resourceInputNames(policy);
  if (Object.keys(values).some(key => !names.includes(key))) throw new Error('RESOURCE_REQUEST_INPUT_UNSUPPORTED');
  if (Array.isArray(policy)) {
    // Legacy rows retain their old scope. Missing-per-field requirements must be explicitly registered.
    if (policy.length && !Object.keys(values).length) throw new Error('RESOURCE_REQUEST_INPUT_REQUIRED');
    return;
  }
  for (const [key, field] of Object.entries(policy ?? {})) {
    if (!Object.hasOwn(values, key)) {
      if (field.required) throw new Error('RESOURCE_REQUEST_INPUT_REQUIRED');
    } else if (!validInputValue(values[key], field)) throw new Error('RESOURCE_REQUEST_INPUT_INVALID');
  }
}
export function authorizedRequestInstance(resource: X402Resource, raw: unknown): HttpResourceRequest {
  const declared = X402ResourceSchema.parse(resource);
  assertResourceInputDefinition(declared);
  const input = ResourceRequestInputSchema.parse(raw);
  const query = input.query ?? {}; const body = input.jsonBody ?? {};
  validateInputFields(query, declared.requestInputs?.query);
  validateInputFields(body, declared.requestInputs?.jsonBody);
  const url = new URL(declared.request.url);
  for (const key of Object.keys(query).sort()) url.searchParams.set(key, query[key]);
  const dynamicBody = declared.requestInputs?.jsonBody;
  const bodyValue = dynamicBody !== undefined && resourceInputNames(dynamicBody).length
    ? JSON.stringify(Object.fromEntries(Object.entries({ ...(declared.request.body === undefined ? {} : jsonBodyRecord(declared.request.body)), ...body })
      .sort(([a], [b]) => a.localeCompare(b))))
    : declared.request.body;
  return assertAuthorizedRequestInstance(declared, { ...declared.request, url: url.href,
    ...(bodyValue === undefined ? {} : { body: bodyValue }) });
}

/** The same field contract is applied to persisted execution evidence, before signing. */
export function assertAuthorizedRequestInstance(resource: X402Resource, instance: HttpResourceRequest) {
  const declared = X402ResourceSchema.parse(resource);
  assertResourceInputDefinition(declared);
  const request = HttpResourceRequestSchema.parse(instance);
  if (request.method !== declared.request.method || request.access !== declared.request.access
    || JSON.stringify(request.headers) !== JSON.stringify(declared.request.headers)) throw new Error('RESOURCE_REQUEST_BINDING_MISMATCH');
  const base = new URL(declared.request.url); const actual = new URL(request.url);
  if (base.origin !== actual.origin || base.pathname !== actual.pathname
    || base.hash !== actual.hash || base.username !== actual.username || base.password !== actual.password) throw new Error('RESOURCE_REQUEST_BINDING_MISMATCH');
  for (const key of base.searchParams.keys()) if (actual.searchParams.getAll(key).length !== base.searchParams.getAll(key).length
    || actual.searchParams.getAll(key).some((item, index) => item !== base.searchParams.getAll(key)[index])) throw new Error('RESOURCE_REQUEST_BINDING_MISMATCH');
  const dynamicQuery: Record<string, string> = {};
  for (const key of actual.searchParams.keys()) if (!base.searchParams.has(key)) {
    const values = actual.searchParams.getAll(key);
    if (values.length !== 1 || values[0].length < 1 || values[0].length > 300) throw new Error('RESOURCE_REQUEST_BINDING_MISMATCH');
    Object.defineProperty(dynamicQuery, key, { value: values[0], enumerable: true });
  }
  validateInputFields(dynamicQuery, declared.requestInputs?.query);
  if (resourceInputNames(declared.requestInputs?.jsonBody).length) {
    const body = request.body === undefined ? {} : jsonBodyRecord(request.body);
    const fixed = declared.request.body === undefined ? {} : jsonBodyRecord(declared.request.body);
    for (const [key, value] of Object.entries(fixed)) if (!Object.hasOwn(body, key) || !isDeepStrictEqual(body[key], value))
      throw new Error('RESOURCE_REQUEST_BINDING_MISMATCH');
    validateInputFields(Object.fromEntries(Object.entries(body).filter(([key]) => !Object.hasOwn(fixed, key))), declared.requestInputs?.jsonBody);
  } else if (request.body !== declared.request.body) throw new Error('RESOURCE_REQUEST_BINDING_MISMATCH');
  return request;
}

// Protocol DTOs remain independent of the backend SDK client and signing modules.
export const X402ChallengeSchema = z.object({
  x402Version: z.literal(2), error: z.string().optional(),
  resource: z.object({ url: z.string().min(1).max(2048), description: z.string().optional(), mimeType: z.string().optional(),
    serviceName: z.string().optional(), tags: z.array(z.string()).optional(), iconUrl: z.string().optional() }).strict(),
  accepts: z.array(z.object({ scheme: z.string(), network: z.templateLiteral([z.string().min(1), ':', z.string().min(1)]),
    amount: z.string(), asset: z.string(), payTo: z.string(), maxTimeoutSeconds: z.number(), extra: z.record(z.string(), z.json()),
    outputSchema: z.json().optional() }).strict()).min(1).max(256),
  extensions: z.record(z.string(), z.json()).optional(),
}).strict();
export type X402Challenge = z.infer<typeof X402ChallengeSchema>;
