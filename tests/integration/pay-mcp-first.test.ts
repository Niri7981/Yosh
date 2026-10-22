import { randomUUID } from 'node:crypto';
import { hash } from '../../src/modules/purchases/spending-policy';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { productionPayFixture, TEST_DELIVERY, deferred, reachBoundary } from '../helpers/pay-production-fixture';

function withAccepted(facts: Record<string, unknown>, accepted: unknown) {
  const envelope = z.object({ accepts: z.array(z.unknown()) }).passthrough().parse(facts.payment_required);
  return { ...facts, accepted, payment_required: { ...envelope,
    accepts: envelope.accepts.map(quote => hash(quote) === hash(facts.accepted) ? accepted : quote) } };
}

it('real Pay MCP preserves route resource and SDK-echoable extensions through Yosh authorization, execution and replay', async () => {
  const extensions = { bazaar: { info: { input: { method: 'GET', queryParams: { asset: 'SOL' } } } },
    'builder-code': { info: { a: 'fixture_builder' } }, 'payment-identifier': { info: { required: false } } };
  const f = await productionPayFixture({ payMcp: true, routeLevelQuote: true, quoteExtensions: extensions });
  try {
    expect((await f.callPay(await f.connectPay(), 'route-extensions')).isError).not.toBe(true);
    const facts = z.record(z.string(), z.unknown()).parse(f.lastFacts);
    const record = f.payRecord('route-extensions')!;
    const envelope = z.object({ resource: z.object({ url: z.string(), description: z.string() }).passthrough(),
      accepts: z.array(z.unknown()), extensions: z.unknown() }).passthrough().parse(facts.payment_required);
    expect(envelope.resource.url).toBe(new URL(record.intent.httpRequest!.url).origin + new URL(record.intent.httpRequest!.url).pathname);
    expect(envelope.resource.url).not.toBe(record.intent.httpRequest!.url);
    expect(envelope.extensions).toEqual(extensions);
    expect(record.intent.x402Challenge).toEqual(envelope);
    const payload = f.app.ledger.savedPayload(record.approvalId)!;
    expect(payload.resource).toEqual(envelope.resource);
    expect(payload.extensions).toEqual(extensions);
    const evidence = f.app.ledger.savedOriginalPayment(record.approvalId);
    const budget = f.app.ledger.managedSummary(Date.now(), 'live_devnet');
    for (const reopened of [false, true]) {
      if (reopened) await f.reopenWithoutPayExecutor();
      const recovery = vi.spyOn(f.app.ledger.reconciliation, 'claim');
      for (const changed of [
        { ...envelope, resource: { ...envelope.resource, description: 'changed metadata' } },
        { ...envelope, resource: { ...envelope.resource, url: `${f.origin}/another-route` } },
        { ...envelope, extensions: { ...extensions, 'builder-code': { info: { a: 'changed_builder' } } } },
        { ...envelope, accepts: [...envelope.accepts, { scheme: 'exact', network: 'eip155:8453', asset: 'other',
          amount: '1', payTo: 'other', maxTimeoutSeconds: 300, extra: {} }] },
      ]) {
        await expect(f.authority.authorize({ ...facts, attempt_id: randomUUID(), payment_required: changed }, f.principal))
          .rejects.toThrow('PAY_OPERATION_CONFLICT');
      }
      expect(recovery).not.toHaveBeenCalled();
      const replay = { ...facts, attempt_id: randomUUID() };
      expect(await f.authority.authorize(replay, f.principal)).toEqual({ allow: true });
      expect((await f.authority.plan(replay, f.principal)).action).toBe('replay');
      recovery.mockRestore();
    }
    expect(f.signatureCalls).toBe(1); expect(f.paidRequests).toBe(1);
    expect(f.app.ledger.savedOriginalPayment(record.approvalId)).toEqual(evidence);
    expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toEqual(budget);
  } finally { await f.close(); }
}, 30_000);

it('real Pay MCP tools/call uses Pay HTTP classifier, real Yosh Grant/Ledger and unsigned Pay builder with Yosh final custody', async () => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    const reserved = vi.spyOn(f.app.ledger, 'reserve'); const claimed = vi.spyOn(f.app.ledger, 'claim');
    const result = await f.callPay(await f.connectPay(), 'pay-first-success');
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(TEST_DELIVERY.source_label);
    expect(reserved).toHaveBeenCalledOnce(); expect(claimed).toHaveBeenCalledOnce();
    expect(f.signatureCalls).toBe(1); expect(f.paidRequests).toBe(1);
    expect(f.payRecord('pay-first-success')).toMatchObject({status:'PAID',deliveryStatus:'COMPLETE',ownerCardMemberId:f.memberId,data:TEST_DELIVERY});
    expect(f.app.ledger.managedSummary(Date.now(),'live_devnet')).toMatchObject({paid:'200000',reserved:'0'});
    expect(f.app.spendGrantSummary()?.committed).toBe('200000');
    expect(f.execution.calls.quote).toBe(0); // No replacement simplified Rust runner.
    expect(f.rpcMethods).toContain('getTransaction'); expect(f.rpcMethods).not.toContain('sendTransaction');
  } finally { await f.close(); }
}, 30_000);

it.each(['deny', 'timeout', 'unavailable'] as const)('Authority %s fails closed before any signing', async mode => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    f.authorityFailure(mode);
    expect((await f.callPay(await f.connectPay({ timeout: 30 }), `pay-${mode}`)).isError).toBe(true);
    expect(f.signatureCalls).toBe(0); expect(f.paidRequests).toBe(0);
    expect(f.rpcMethods).not.toContain('getLatestBlockhash');
  } finally { await f.close(); }
}, 30_000);

it.each(['grant', 'budget'] as const)('real Yosh %s denies before unsigned preparation', async kind => {
  const f = await productionPayFixture({ payMcp: true, grant: kind !== 'grant' });
  try {
    if (kind === 'budget') f.app.setDailyLimit('100000');
    expect((await f.callPay(await f.connectPay(), `pay-denied-${kind}`)).isError).toBe(true);
    expect(f.payRecord(`pay-denied-${kind}`)?.status).toBe('DENIED');
    expect(f.signatureCalls).toBe(0); expect(f.paidRequests).toBe(0);
    expect(f.rpcMethods).not.toContain('getLatestBlockhash');
  } finally { await f.close(); }
}, 30_000);

it('concurrent same-operation calls and a new Pay process reuse one economic operation', async () => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    const firstClient = await f.connectPay();
    const replies = await Promise.all([f.callPay(firstClient,'pay-duplicate'), f.callPay(firstClient,'pay-duplicate')]);
    expect(replies.filter(r => !r.isError)).toHaveLength(1);
    const second = await f.callPay(await f.connectPay(),'pay-duplicate');
    expect(second.isError).not.toBe(true); expect(JSON.stringify(second.content)).toContain(TEST_DELIVERY.source_label);
    expect(f.signatureCalls).toBe(1); expect(f.paidRequests).toBe(1);
    expect(f.app.ledger.managedSummary(Date.now(),'live_devnet').paid).toBe('200000');
  } finally { await f.close(); }
},30_000);

it('trusted connection identity cannot be replaced by another caller, and separate Agents have independent Grants', async () => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    const other = f.app.createCardMember('Offline other Agent').member;
    f.app.setAgentConnection(true, f.origin, other.id);
    expect((await f.callPay(await f.connectPay({ caller: other.id }), 'pay-identity')).isError).toBe(true);
    expect(f.signatureCalls).toBe(0); expect(f.paidRequests).toBe(0);
    expect(f.app.ledger.listForOwner(other.id,50)).toHaveLength(0);
    expect((await f.callPay(await f.connectPay({caller:other.id,member:other.id}),'pay-identity')).isError).toBe(true);
    expect(f.app.ledger.listForOwner(other.id,50)[0]?.status).toBe('DENIED');
    expect(f.signatureCalls).toBe(0);
    expect((await f.callPay(await f.connectPay({ token: 'invalid-token' }), 'pay-authentication')).isError).toBe(true);
    expect(f.payRecord('pay-authentication')).toBeUndefined();
    const result = await f.callPay(await f.connectPay(), 'pay-identity');
    expect(result.isError).not.toBe(true);
    const facts = structuredClone(f.lastFacts);
    const bad = { ...facts as Record<string, unknown>, caller_id: other.id };
    await expect(f.authority.authorize(bad, f.principal)).rejects.toThrow('PAY_CALLER_MISMATCH');
    expect(f.signatureCalls).toBe(1);
  } finally { await f.close(); }
},30_000);

it('changed authorized facts and a modified unsigned transfer cannot spend the old authorization', async () => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    f.mutateUnsigned();
    expect((await f.callPay(await f.connectPay(),'pay-tampered-wire')).isError).toBe(true);
    expect(f.signatureCalls).toBe(0); expect(f.paidRequests).toBe(0);
    const facts = { ...f.lastFacts as Record<string,unknown>, amount_atomic:'200001' };
    expect(() => f.authority.plan(facts,f.principal)).toThrow('PAY_ECONOMIC_FACTS_MISMATCH');
    const original=z.record(z.string(),z.unknown()).parse(f.lastFacts);
    const accepted=z.record(z.string(),z.unknown()).parse(original.accepted);
    const repriced={...withAccepted(original,{...accepted,amount:'200001'}),amount_atomic:'200001'};
    expect(()=>f.authority.plan(repriced,f.principal)).toThrow('PAY_STALE_OR_CHANGED_ATTEMPT');
    expect(f.payRecord('pay-tampered-wire')?.status).toBe('FAILED');
  } finally { await f.close(); }
},30_000);

it('Pause winning claim prevents signing through real Pay MCP', async () => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    const original=f.app.ledger.claim.bind(f.app.ledger);
    vi.spyOn(f.app.ledger,'claim').mockImplementationOnce((...args) => { f.app.setPaused(true); return original(...args); });
    expect((await f.callPay(await f.connectPay(),'pay-pause-claim')).isError).toBe(true);
    expect(f.signatureCalls).toBe(0);expect(f.paidRequests).toBe(0);
  } finally { await f.close(); }
},30_000);

it('Pause then Resume after authorization fences the old attempt before claim', async () => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    const original=f.authority.plan.bind(f.authority);
    vi.spyOn(f.authority,'plan').mockImplementationOnce((...args) => { f.app.setPaused(true);f.app.setPaused(false);return original(...args); });
    expect((await f.callPay(await f.connectPay(),'pay-stale-authority')).isError).toBe(true);
    expect(f.signatureCalls).toBe(0);expect(f.paidRequests).toBe(0);
    expect((await f.callPay(await f.connectPay(),'pay-stale-authority')).isError).toBe(true);
    expect(f.signatureCalls).toBe(0);
  } finally { await f.close(); }
},30_000);

it('Pause during signing prevents a late signature from reaching HTTP after Resume', async () => {
  const release=deferred();
  const f=await productionPayFixture({payMcp:true,signerBarrier:release});
  try {
    const pending=f.callPay(await f.connectPay(),'pay-pause-signer');
    await reachBoundary(f.signerStarted,pending);
    f.app.setPaused(true);f.app.setPaused(false);release.resolve();
    expect((await pending).isError).toBe(true);
    expect(f.signatureCalls).toBe(1);expect(f.paidRequests).toBe(0);
    expect(f.payRecord('pay-pause-signer')?.paymentPayloadPresent).toBe(false);
  } finally { release.resolve();await f.close(); }
},30_000);

it('Pause after signing and durable evidence prevents final HTTP', async () => {
  const f=await productionPayFixture({payMcp:true});
  try {
    const original=f.app.ledger.savePayload.bind(f.app.ledger);
    vi.spyOn(f.app.ledger,'savePayload').mockImplementationOnce((...args)=>{original(...args);f.app.setPaused(true);});
    expect((await f.callPay(await f.connectPay(),'pay-pause-saved')).isError).toBe(true);
    expect(f.signatureCalls).toBe(1);expect(f.paidRequests).toBe(0);
    const record=f.payRecord('pay-pause-saved')!;
    expect(f.app.ledger.savedOriginalPayment(record.approvalId)?.state).toBe('NOT_SUBMITTED');
  } finally { await f.close(); }
},30_000);

it('HTTP already started still reconciles the original payment after Pause',async()=>{
  const release=deferred(); const f=await productionPayFixture({payMcp:true});f.pauseMerchantResponse(release);
  try {
    const pending=f.callPay(await f.connectPay(),'pay-pause-http');await reachBoundary(f.merchantArrived,pending);
    f.app.setPaused(true);release.resolve();
    expect((await pending).isError).not.toBe(true);
    expect(f.payRecord('pay-pause-http')).toMatchObject({status:'PAID',deliveryStatus:'COMPLETE'});
    expect(f.app.ledger.managedSummary(Date.now(),'live_devnet')).toMatchObject({paid:'200000',reserved:'0',paused:true});
  } finally {release.resolve();await f.close();}
},30_000);

it('marker-before-HTTP interruption retains Unknown and original reservation across Yosh reopen',async()=>{
  const f=await productionPayFixture({payMcp:true});
  try {
    const mark=f.app.ledger.markSubmissionAttempt.bind(f.app.ledger);
    vi.spyOn(f.app.ledger,'markSubmissionAttempt').mockImplementationOnce((...args)=>{mark(...args);throw new Error('TEST_AFTER_MARKER');});
    expect((await f.callPay(await f.connectPay(),'pay-marker')).isError).toBe(true);
    const record=f.payRecord('pay-marker')!;
    const original=f.app.ledger.savedOriginalPayment(record.approvalId)!;
    const payload=f.app.ledger.savedPayload(record.approvalId)!;
    expect(record.status).toBe('PAYMENT_UNKNOWN');expect(f.paidRequests).toBe(0);
    expect(f.app.ledger.managedSummary(Date.now(),'live_devnet').reserved).toBe('200000');
    await f.reopenWithoutPayExecutor();await f.app.start(f.origin);
    expect(f.payRecord('pay-marker')?.status).toBe('PAYMENT_UNKNOWN');
    expect((await f.callPay(await f.connectPay(),'pay-marker')).isError).toBe(true);
    expect(f.signatureCalls).toBe(1);expect(f.paidRequests).toBe(0);
    expect(f.app.ledger.savedOriginalPayment(record.approvalId)?.evidence).toEqual(original.evidence);
    f.acceptPayload(payload);
    const replay=await f.callPay(await f.connectPay(),'pay-marker');
    expect(replay.isError).not.toBe(true);
    expect(JSON.stringify(replay.content)).toContain(TEST_DELIVERY.source_label);
    expect(f.payRecord('pay-marker')?.status).toBe('PAID');expect(f.signatureCalls).toBe(1);
    expect(new Set(f.paidHeaders).size).toBeLessThanOrEqual(1);
  }finally{await f.close();}
},30_000);

it('lost controller ACK replays persisted data through a new Pay process without a second signature',async()=>{
  const f=await productionPayFixture({payMcp:true});
  try{
    f.loseControllerAckOnce();
    expect((await f.callPay(await f.connectPay(),'pay-lost-ack')).isError).toBe(true);
    expect(f.payRecord('pay-lost-ack')).toMatchObject({status:'PAID',data:TEST_DELIVERY});
    const replay=await f.callPay(await f.connectPay(),'pay-lost-ack');
    expect(replay.isError).not.toBe(true);expect(JSON.stringify(replay.content)).toContain(TEST_DELIVERY.source_label);
    expect(f.signatureCalls).toBe(1);expect(f.paidRequests).toBe(1);
  }finally{await f.close();}
},30_000);

it('Pay interpreter failure cannot erase confirmed state or persisted delivery',async()=>{
  const f=await productionPayFixture({payMcp:true});
  try{
    f.failPayInterpretationOnce();
    expect((await f.callPay(await f.connectPay(),'pay-interpreter')).isError).toBe(true);
    expect(f.payRecord('pay-interpreter')).toMatchObject({status:'PAID',deliveryStatus:'COMPLETE',data:TEST_DELIVERY});
    expect((await f.callPay(await f.connectPay(),'pay-interpreter')).isError).not.toBe(true);
    expect(f.signatureCalls).toBe(1);expect(f.paidRequests).toBe(1);
  }finally{await f.close();}
},30_000);

it('a merchant reflection of the buyer signature never crosses back to Pay',async()=>{
  const f=await productionPayFixture({payMcp:true});
  try{
    f.reflectCredential();
    const result=await f.callPay(await f.connectPay(),'pay-reflection');
    expect(result.isError).toBe(true);
    const record=f.payRecord('pay-reflection')!;
    expect(record).toMatchObject({status:'PAID',deliveryStatus:'COMPLETE'});
    const original=f.app.ledger.savedOriginalPayment(record.approvalId)!;
    expect(JSON.stringify(result)).not.toContain(original.evidence.identity.buyerSignature);
    expect(f.signatureCalls).toBe(1);expect(f.paidRequests).toBe(1);
  }finally{await f.close();}
},30_000);


it('a lost merchant ACK reconciles the saved original and only retries original delivery',async()=>{
  const f=await productionPayFixture({payMcp:true});
  try{
    f.loseMerchantResponseOnce();
    expect((await f.callPay(await f.connectPay(),'pay-merchant-ack')).isError).toBe(true);
    expect(f.payRecord('pay-merchant-ack')?.status).toBe('PAID');
    const original=f.app.ledger.savedOriginalPayment(f.payRecord('pay-merchant-ack')!.approvalId)!;
    expect((await f.callPay(await f.connectPay(),'pay-merchant-ack')).isError).not.toBe(true);
    expect(f.signatureCalls).toBe(1);expect(new Set(f.paidHeaders).size).toBe(1);
    expect(f.app.ledger.savedOriginalPayment(f.payRecord('pay-merchant-ack')!.approvalId)?.evidence).toEqual(original.evidence);
    expect(f.app.ledger.managedSummary(Date.now(),'live_devnet')).toMatchObject({paid:'200000',reserved:'0'});
  }finally{await f.close();}
},30_000);

it('Pause after a signature but before persistence rejects the late result',async()=>{
  const signed=deferred();const release=deferred();
  const f=await productionPayFixture({payMcp:true,hooks:{afterSigned:async()=>{signed.resolve();await release.promise;}}});
  try{
    const pending=f.callPay(await f.connectPay(),'pay-before-persistence');
    await reachBoundary(signed,pending);f.app.setPaused(true);release.resolve();
    expect((await pending).isError).toBe(true);
    expect(f.payRecord('pay-before-persistence')).toMatchObject({status:'FAILED',paymentPayloadPresent:false});
    expect(f.signatureCalls).toBe(1);expect(f.paidRequests).toBe(0);
  }finally{release.resolve();await f.close();}
},30_000);


it('real Pay MCP survives an actual Yosh SIGKILL between durable marker and HTTP without replacing the payment',async()=>{
  const f=await productionPayFixture({payMcp:true});
  try{
    await f.crashAfterSubmissionMarker('pay-process-crash');expect(f.paidRequests).toBe(0);
    await f.reopenWithoutPayExecutor();
    const record=f.payRecord('pay-process-crash')!;
    expect(record.status).toBe('PAYING');
    const original=f.app.ledger.savedOriginalPayment(record.approvalId)!;
    expect(original.state).toBe('SUBMISSION_ATTEMPTED');
    await f.app.start(f.origin);
    expect((await f.callPay(await f.connectPay(),'pay-process-crash')).isError).toBe(true);
    expect(f.payRecord('pay-process-crash')?.status).toBe('PAYMENT_UNKNOWN');
    expect(f.app.ledger.savedOriginalPayment(record.approvalId)?.evidence).toEqual(original.evidence);
    expect(f.app.ledger.managedSummary(Date.now(),'live_devnet')).toMatchObject({paid:'0',reserved:'200000'});
    expect(f.paidRequests).toBe(0);
    expect(f.app.ledger.eventsForOwner(record.intent.idempotencyKey,f.memberId).filter(e=>e.type==='payment.SUBMISSION_ATTEMPTED')).toHaveLength(1);
  }finally{await f.close();}
},30_000);

it('shutdown waits for the already started controlled HTTP and its original accounting',async()=>{
  const release=deferred();const f=await productionPayFixture({payMcp:true});f.pauseMerchantResponse(release);
  try{
    const pending=f.callPay(await f.connectPay(),'pay-shutdown-http');await reachBoundary(f.merchantArrived,pending);
    let quitDone=false;const quitting=f.app.prepareQuit().then(()=>{quitDone=true;});
    await new Promise<void>(done=>setImmediate(done));
    expect(quitDone).toBe(false);
    release.resolve();expect((await pending).isError).toBe(true);await quitting;
    // The existing quit policy stops new delivery claims, while still proving
    // the submitted original. Restart recovers its delivery with the same proof.
    expect(f.payRecord('pay-shutdown-http')).toMatchObject({status:'PAID',deliveryStatus:'PENDING'});
    expect(f.signatureCalls).toBe(1);expect(f.paidRequests).toBe(1);
    await f.reopenWithoutPayExecutor();await f.app.start(f.origin);
    const recovered=await f.callPay(await f.connectPay(),'pay-shutdown-http');
    expect(recovered.isError).not.toBe(true);expect(JSON.stringify(recovered.content)).toContain(TEST_DELIVERY.source_label);
    expect(f.payRecord('pay-shutdown-http')).toMatchObject({status:'PAID',deliveryStatus:'COMPLETE'});
    expect(f.signatureCalls).toBe(1);expect(new Set(f.paidHeaders).size).toBe(1);
  }finally{release.resolve();await f.close();}
},30_000);


it('operation replay rejects changed request or accepted terms before recovery, including after reopen', async () => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    expect((await f.callPay(await f.connectPay(), 'review-replay')).isError).not.toBe(true);
    const original = z.record(z.string(), z.unknown()).parse(f.lastFacts);
    const offer = z.record(z.string(), z.unknown()).parse(original.accepted);
    const request = z.record(z.string(), z.unknown()).parse(original.request);
    const extra = z.record(z.string(), z.unknown()).parse(offer.extra);
    const changed = [
      { amount_atomic: '200001', accepted: { ...offer, amount: '200001' } },
      { recipient: extra.feePayer, accepted: { ...offer, payTo: extra.feePayer } },
      { accepted: { ...offer, maxTimeoutSeconds: 299 } },
      { accepted: { ...offer, extra: { ...extra, memo: 'review-changed-accepted-offer' } } },
      { request: { ...request, headers: [] } },
    ];
    const evidence = f.app.ledger.savedOriginalPayment(f.payRecord('review-replay')!.approvalId);
    const phases = ['same-process', 'reopened'] as const;
    for (const phase of phases) {
      if (phase === 'reopened') await f.reopenWithoutPayExecutor();
      for (const modification of changed) {
        const coherent = 'accepted' in modification ? withAccepted(original, modification.accepted) : original;
        await expect(f.authority.authorize({ ...coherent, ...modification, attempt_id: randomUUID() }, f.principal))
          .rejects.toThrow('PAY_OPERATION_CONFLICT');
      }
      for (const modification of [
        { asset: 'unsupported-asset', accepted: { ...offer, asset: 'unsupported-asset' } },
        { network: 'solana:unsupported', accepted: { ...offer, network: 'solana:unsupported' } },
        { request: { ...request, method: 'POST' } },
        { request: { ...request, body: [1] } },
      ]) {
        await expect(f.authority.authorize({ ...original, ...modification, attempt_id: randomUUID() }, f.principal)).rejects.toThrow();
      }
      const retry = { ...original, attempt_id: randomUUID() };
      expect(await f.authority.authorize(retry, f.principal)).toEqual({ allow: true });
      expect((await f.authority.plan(retry, f.principal)).action).toBe('replay');
    }
    expect(f.signatureCalls).toBe(1); expect(f.paidRequests).toBe(1);
    expect(f.app.ledger.savedOriginalPayment(f.payRecord('review-replay')!.approvalId)).toEqual(evidence);
  } finally { await f.close(); }
}, 30_000);

it('external requestHash binds the actual saved and submitted request, and rejects omitted Accept before reserve', async () => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    expect((await f.callPay(await f.connectPay(), 'review-request')).isError).not.toBe(true);
    const facts = z.record(z.string(), z.unknown()).parse(f.lastFacts);
    const request = z.record(z.string(), z.unknown()).parse(facts.request);
    const record = f.payRecord('review-request')!;
    const http = record.intent.httpRequest!;
    expect(hash({ method: http.method, url: http.url, headers: Object.entries(http.headers), body: http.body ?? null }))
      .toBe(f.app.ledger.executionSafety.permit(record).requestHash);
    expect(f.paidRequestAccepts).toEqual(['application/json']);
    const permit = f.app.ledger.executionSafety.permit(record);
    expect(() => f.app.ledger.executionSafety.assert(record, { ...permit, requestHash: hash('changed') }))
      .toThrow('EXTERNAL_EXECUTION_FENCED');
    expect(() => f.app.ledger.executionSafety.assert({ ...record, intent: { ...record.intent,
      httpRequest: { ...http, headers: {} } } }, permit)).toThrow('EXTERNAL_EXECUTION_FENCED');
    await expect(f.authority.authorize({ ...facts, operation_id: 'review-request-missing-header', attempt_id: randomUUID(),
      request: { ...request, headers: [] } }, f.principal)).rejects.toThrow('EXTERNAL_PROVENANCE_MISMATCH');
    expect(f.payRecord('review-request-missing-header')).toBeUndefined();
    expect(f.signatureCalls).toBe(1); expect(f.paidRequests).toBe(1);
  } finally { await f.close(); }
}, 30_000);


it.each(['PAID', 'PAYMENT_UNKNOWN'] as const)('real Pay MCP rejects a new accepted offer for the same %s operation without recovering or replacing it', async status => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    if (status === 'PAYMENT_UNKNOWN') {
      const mark = f.app.ledger.markSubmissionAttempt.bind(f.app.ledger);
      vi.spyOn(f.app.ledger, 'markSubmissionAttempt').mockImplementationOnce((...args) => { mark(...args); throw new Error('REVIEW_AFTER_MARKER'); });
    }
    await f.callPay(await f.connectPay(), 'review-mcp-changed-offer');
    const record = f.payRecord('review-mcp-changed-offer')!;
    expect(record.status).toBe(status);
    const original = f.app.ledger.savedOriginalPayment(record.approvalId);
    const payload = f.app.ledger.savedPayload(record.approvalId);
    const claim = vi.spyOn(f.app.ledger.reconciliation, 'claim');
    const before = f.app.ledger.managedSummary(Date.now(), 'live_devnet');
    expect((await f.callPay(await f.connectPay(), 'review-mcp-changed-offer', true)).isError).toBe(true);
    expect(claim).not.toHaveBeenCalled();
    expect(f.payRecord('review-mcp-changed-offer')!.status).toBe(status);
    expect(f.app.ledger.savedOriginalPayment(record.approvalId)).toEqual(original);
    expect(f.app.ledger.savedPayload(record.approvalId)).toEqual(payload);
    expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toEqual(before);
    expect(f.signatureCalls).toBe(1); expect(f.paidRequests).toBe(status === 'PAID' ? 1 : 0);
    if (status === 'PAID') expect((await f.callPay(await f.connectPay(), 'review-mcp-changed-offer')).isError).not.toBe(true);
  } finally { await f.close(); }
}, 30_000);
