import type { ExternalExecutionPermit } from '../purchases/execution-safety';
import { z } from 'zod';
import { getBase58Encoder } from '@solana/kit';
import type { AppRuntime } from '../app/app-runtime';
import type { SpendPrincipal } from '../authority/spend-grant';
import { requestPaidResourcePurchase } from '../purchases/request-paid-resource-purchase';
import { executeApprovedPayment, recoverApprovedPayment } from '../purchases/approved-payment';
import { hash } from '../purchases/spending-policy';
import { paidResource } from '../resources/paid-resources';
import { X402ChallengeSchema, assertAuthorizedRequestInstance, resourceInputNames } from '../resources/http-resource';
import { DEVNET_NETWORK, DEVNET_USDC_MINT, MAINNET_NETWORK, MAINNET_USDC_MINT, type PaymentConfig } from './payment-config';
import type { PaymentExecutionContext, PaymentExecutor } from './payment-execution-contract';
import { assertIsolatedPaymentDirectory, PreparedSchema } from './isolated-pay-execution';
import { assertPayControlledExtensions } from './resource-challenge';
import { assertPayMainnetAcceptance } from './pay-mainnet-control';
import { readPayMainnetLifetime } from './mainnet-pay-execution';

const Facts = z.object({ operation_id: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/), attempt_id: z.string().uuid(), caller_id: z.string().uuid(),
  request: z.object({ method: z.literal('GET'), url: z.string().url(), headers: z.array(z.tuple([z.string(), z.string()])).max(8), body: z.null() }).strict(),
  amount_atomic: z.string().regex(/^[1-9]\d*$/).max(20), asset: z.string(), network: z.string(),
  execution_network: z.enum(['devnet','mainnet']), recipient: z.string(), accepted: z.unknown(), payment_required: z.unknown() }).strict();
type Facts = z.infer<typeof Facts>;
type Attempt = { facts: Facts; digest: string; generation: number; purchaseId: string; approvalId: string; permit?: ExternalExecutionPermit;
  lifetime?: { recentBlockhash: string; lastValidBlockHeight: string }; phase: 'authorized' | 'executing' | 'replay' | 'done' };

/** Backend-only adapter. Real Yosh authority, atomic Ledger, claim, signing and
 * reconciliation own the decision. Mainnet additionally requires the stopped
 * upgrade profile, explicit production enablement and one exact operator receipt. */
export function createPayAuthorityAdapter(options: { directory: string; runtime: () => AppRuntime; config: () => PaymentConfig;
  executor: PaymentExecutor; origin: string; rpcUrl: string; mainnet?: true }) {
  if (!options.mainnet) assertIsolatedPaymentDirectory(options.directory);
  options.runtime().ledger.executionSafety.enable(Date.now());
  const attempts = new Map<string, Attempt>();
  const unsigned = new Map<string, unknown>();
  let generation = 0;
  const invalidate = options.executor.invalidate?.bind(options.executor);
  options.executor.invalidate = () => { generation++; invalidate?.(); };
  const parse = (raw: unknown, principal: SpendPrincipal) => {
    const facts = Facts.parse(raw);
    if (facts.caller_id !== principal.cardMemberId) throw new Error('PAY_CALLER_MISMATCH');
    options.runtime().ledger.assertCardMemberActive(principal.cardMemberId);
    if (facts.request.headers.some(([name, value]) => name !== 'accept' || value !== 'application/json')
      || new Set(facts.request.headers.map(([name]) => name)).size !== facts.request.headers.length) throw new Error('PAY_REQUEST_HEADERS_REJECTED');
    const config = options.config();
    if (options.mainnet ? process.env.YOSH_PAY_MCP_MAINNET !== '1' || config.mode !== 'live_mainnet' || !config.productionExecutionEnabled
      || !config.isProduction || config.network !== MAINNET_NETWORK || config.mint !== MAINNET_USDC_MINT || facts.execution_network !== 'mainnet'
      : config.isProduction || config.mode !== 'live_devnet' || config.network !== DEVNET_NETWORK || config.mint !== DEVNET_USDC_MINT || facts.execution_network !== 'devnet')
      throw new Error('PAY_PRODUCTION_BLOCKED');
    if (facts.asset !== config.mint || facts.network !== config.network) throw new Error('PAY_ECONOMIC_FACTS_MISMATCH');
    let requestInput: { query: Record<string,string> } | undefined;
    const candidates = options.mainnet ? (config.registeredResources ?? []).filter(resource => {
      try {
        const target = new URL(facts.request.url);
        const names = resourceInputNames(resource.requestInputs?.query);
        const query = Object.fromEntries(names.filter(name => target.searchParams.has(name)).map(name => [name,target.searchParams.get(name)!]));
        const policy = { ...resource, request: { ...resource.request,
          headers: { ...resource.request.headers, accept: resource.request.headers.accept ?? 'application/json' } } };
        const instance = assertAuthorizedRequestInstance(policy, { method: facts.request.method, url: facts.request.url,
          headers: Object.fromEntries(facts.request.headers), access: 'https' });
        if (instance.body !== undefined) return false;
        requestInput = { query }; return true;
      } catch { return false; }
    }) : [];
    const resourceId = options.mainnet ? candidates.length === 1 ? candidates[0].resourceId : undefined
      : (['market-snapshot', 'market-analysis', 'token-risk-report'] as const).find(id => new URL(paidResource(id).path, options.origin).href === facts.request.url);
    // Pay preserves the SDK-selected source envelope. Reconstructing it from
    // request.url + accepted would discard route metadata and extensions.
    const challenge = X402ChallengeSchema.parse(facts.payment_required);
    assertPayControlledExtensions(challenge);
    const matches = challenge.accepts.filter(quote => hash(quote) === hash(facts.accepted));
    if (matches.length !== 1) throw new Error('PAY_ECONOMIC_FACTS_MISMATCH');
    const quote = matches[0];
    if (quote.amount !== facts.amount_atomic || quote.network !== facts.network || quote.asset !== facts.asset || quote.payTo !== facts.recipient
      || hash(quote) !== hash(facts.accepted)) throw new Error('PAY_ECONOMIC_FACTS_MISMATCH');
    return { facts, config, resourceId, challenge, requestInput };
  };
  const purchaseId = (caller: string, operation: string) => `pay_${hash([caller, operation]).slice(0,60)}`;
  const get = (raw: unknown, principal: SpendPrincipal) => {
    const { facts, config } = parse(raw, principal);
    const attempt = attempts.get(facts.attempt_id);
    if (!attempt || attempt.digest !== hash(facts) || attempt.generation !== generation) throw new Error('PAY_STALE_OR_CHANGED_ATTEMPT');
    const record = options.runtime().ledger.getOwned(attempt.purchaseId, principal.cardMemberId);
    if (!record || record.approvalId !== attempt.approvalId) throw new Error('PAY_LEDGER_BINDING_MISMATCH');
    if (attempt.phase !== 'replay') {
      if (attempt.permit?.attemptId !== facts.attempt_id || attempt.permit.factsHash !== hash(facts)) throw new Error('PAY_ATTEMPT_BINDING_MISMATCH');
      options.runtime().ledger.executionSafety.assert(record, attempt.permit);
    }
    return { attempt, record, config };
  };
  const response = (attempt: Attempt, principal: SpendPrincipal) => {
    const record = options.runtime().ledger.getOwned(attempt.purchaseId, principal.cardMemberId);
    if (!record || record.status !== 'PAID' || record.deliveryStatus !== 'COMPLETE' || record.data === undefined) throw new Error('PAY_ORIGINAL_OUTCOME_UNRESOLVED');
    // Raw merchant headers/body stay in Yosh: arbitrary fields may echo a payment
    // credential. Return the validated, persisted Resource data only, after proof.
    const body = Buffer.from(JSON.stringify(record.data));
    const original = options.runtime().ledger.savedOriginalPayment(record.approvalId);
    if (!original) throw new Error('PAY_ORIGINAL_EVIDENCE_REQUIRED');
    const signature = original.evidence.identity.buyerSignature;
    const signatureBytes = getBase58Encoder().encode(signature);
    const secrets = [signature, Buffer.from(signatureBytes).toString('base64'), Buffer.from(signatureBytes).toString('hex')];
    const payload = options.runtime().ledger.savedPayload(record.approvalId);
    if (payload) secrets.push(JSON.stringify(payload), Buffer.from(JSON.stringify(payload)).toString('base64'));
    if (secrets.some(secret => body.toString('utf8').includes(secret))) throw new Error('PAY_CREDENTIAL_REFLECTION_REJECTED');
    if (body.length > 65_536) throw new Error('PAY_DELIVERY_TOO_LARGE');
    return { status: 200, headers: [['content-type', 'application/json']], body: [...body] };
  };
  return {
    purchaseId,
    authorize(raw: unknown, principal: SpendPrincipal) {
      return options.runtime().runExternalPaymentOperation(async () => {
        const { facts, config, resourceId, challenge, requestInput } = parse(raw, principal);
        if (attempts.has(facts.attempt_id)) throw new Error('PAY_ATTEMPT_REUSED');
        const epoch = generation;
        const id = purchaseId(principal.cardMemberId, facts.operation_id);
        const ledger = options.runtime().ledger;
        const existing = ledger.getOwned(id, principal.cardMemberId);
        if (existing) {
          const provenance = ledger.executionSafety.provenance(existing.intent.id);
          if (provenance?.origin !== 'external_pay' || provenance.caller_id !== principal.cardMemberId
            || provenance.operation_id !== facts.operation_id) throw new Error('PAY_EXTERNAL_PROVENANCE_REQUIRED');
          // No new quote, claim, signature or replacement, including after restart.
          if (provenance.request_hash !== hash(facts.request) || provenance.quote_hash !== hash(facts.accepted)
            || hash(existing.intent.x402Challenge) !== hash(challenge))
            throw new Error('PAY_OPERATION_CONFLICT');
          await recoverApprovedPayment(ledger, id, config, facts.request.url, undefined, principal.cardMemberId);
          const saved = ledger.getOwned(id, principal.cardMemberId)!;
          if (saved.status !== 'PAID' || saved.deliveryStatus !== 'COMPLETE') return { allow: false };
          attempts.set(facts.attempt_id, { facts, digest: hash(facts), generation: epoch, purchaseId: id, approvalId: saved.approvalId, phase: 'replay' });
          return { allow: epoch === generation };
        }
        if (!resourceId) throw new Error('PAY_RESOURCE_NOT_REGISTERED');
        if (options.mainnet) assertPayMainnetAcceptance(options.directory, config, facts, {
          resourceId, providerId: config.registeredResources!.find(resource => resource.resourceId === resourceId)!.providerId,
          resourceUrl: facts.request.url });
        const result = await requestPaidResourcePurchase({ requestId: id, resourceId, reason: 'Pay MCP API purchase',
          ...(options.mainnet ? { request: requestInput } : {}) }, {
          config, ledger, origin: options.origin, principal, execute: true, deferExecution: true,
          ...(options.mainnet ? { externalQuote: challenge, externalRequest: { method: facts.request.method, url: facts.request.url,
            headers: Object.fromEntries(facts.request.headers), access: 'https' as const } } : {}),
          externalExecution: {callerId: principal.cardMemberId, operationId: facts.operation_id, attemptId: facts.attempt_id,
            factsHash: hash(facts), requestHash: hash(facts.request), quoteHash: hash(facts.accepted)},
          fetcher: async (url, init) => {
            if (String(url) !== facts.request.url || init?.method !== 'GET') throw new Error('PAY_IMMUTABLE_REQUEST_MISMATCH');
            return new Response(null, { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') } });
          },
      });
      const record = ledger.getOwned(id, principal.cardMemberId)!;
      if (result.status !== 'APPROVED' || epoch !== generation) return { allow: false };
      const permit = ledger.executionSafety.permit(record);
      // A concurrent reserve winner belongs to its original attempt. Do not
      // lend that winner's permit to the losing request, even at identical terms.
      if (permit.attemptId !== facts.attempt_id || permit.factsHash !== hash(facts)) return { allow: false };
      attempts.set(facts.attempt_id, { facts, digest: hash(facts), generation: epoch, purchaseId: id, approvalId: record.approvalId, permit, phase: 'authorized' });
      return { allow: true };
      });
    },
    plan(raw: unknown, principal: SpendPrincipal) {
      const { attempt, record, config } = get(raw, principal);
      if (attempt.phase === 'replay') return { action: 'replay', response: response(attempt, principal) };
      if (attempt.phase !== 'authorized' || record.status !== 'APPROVED') throw new Error('PAY_OPERATION_ALREADY_STARTED');
      options.executor.assertEligibility(config, options.runtime().ledger);
      if (options.mainnet) return readPayMainnetLifetime(config).then(lifetime => {
        get(raw, principal);
        if (attempt.lifetime) throw new Error('PAY_OPERATION_ALREADY_PLANNED');
        attempt.lifetime = lifetime;
        return { action: 'build', payer: config.buyer, rpc_url: options.rpcUrl, lifetime };
      });
      return { action: 'build', payer: config.buyer, rpc_url: options.rpcUrl };
    },
    execute(raw: unknown, prepared: unknown, principal: SpendPrincipal) {
      return options.runtime().runExternalPaymentOperation(async () => {
        const { attempt, record, config } = get(raw, principal);
        if (attempt.phase !== 'authorized' || record.status !== 'APPROVED') throw new Error('PAY_OPERATION_ALREADY_STARTED');
        const value = PreparedSchema.parse({ ok: true, ...z.object({ transaction: z.string(), recentBlockhash: z.string(), lastValidBlockHeight: z.string() }).strict().parse(prepared) });
        if (options.mainnet && (!attempt.lifetime || value.recentBlockhash !== attempt.lifetime.recentBlockhash
          || value.lastValidBlockHeight !== attempt.lifetime.lastValidBlockHeight)) throw new Error('PAY_BLOCKHASH_BINDING_MISMATCH');
        attempt.phase = 'executing';
        unsigned.set(record.approvalId, value);
        try {
          await executeApprovedPayment(options.runtime().ledger, record.approvalId, config, attempt.facts.request.url, undefined, options.executor, attempt.permit);
          attempt.phase = 'done';
          return response(attempt, principal);
        } finally { unsigned.delete(record.approvalId); }
      });
    },
    async takeUnsigned(context: PaymentExecutionContext) {
      if (options.mainnet) {
        const attempt = [...attempts.values()].find(value => value.approvalId === context.record.approvalId);
        if (!attempt) throw new Error('PAY_ATTEMPT_BINDING_MISMATCH');
        assertPayMainnetAcceptance(options.directory, context.config, attempt.facts, {
          resourceId: context.record.intent.resourceId, providerId: context.record.intent.providerId, resourceUrl: attempt.facts.request.url });
      }
      const value = unsigned.get(context.record.approvalId);
      if (!value) throw new Error('PAY_UNSIGNED_PREPARATION_REQUIRED');
      unsigned.delete(context.record.approvalId);
      return value;
    },
  };
}
