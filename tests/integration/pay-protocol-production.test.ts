import { existsSync, statSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deferred, ENGINE_PATH, productionPayFixture, reachBoundary, TEST_DELIVERY } from '../helpers/pay-production-fixture';

describe('real Yosh authority with the isolated Rust pay protocol engine', () => {
  it('uses real stdio MCP identity, Spend Grant, reserve/claim, original proof and delivery with no production key access', async () => {
    expect(existsSync(ENGINE_PATH), 'Build scripts/build-pay-protocol-engine.py before this integration suite.').toBe(true);
    const fixture = await productionPayFixture({ grant: false });
    try {
      expect(statSync(fixture.directory).mode & 0o777).toBe(0o700);
      const client = await fixture.connect();
      expect(await fixture.purchase(client, 'rust-pay-no-grant')).toMatchObject({ status: 'DENIED',
        decision: { reason: 'SPEND_GRANT_REQUIRED' }, paymentStatus: 'NOT_STARTED' });
      expect(fixture.signatureCalls).toBe(0);
      expect(fixture.paidRequests).toBe(0);
      expect((await fixture.post('rust-pay-unauthenticated', 'invalid-token')).status).toBe(401);
      expect(fixture.record('rust-pay-unauthenticated')).toBeUndefined();

      fixture.app.createSpendGrant({ totalLimit: '5000000', singleLimit: '500000', expiresAt: Date.now() + 600_000 });
      const reserved = vi.spyOn(fixture.app.ledger, 'reserve');
      const claimed = vi.spyOn(fixture.app.ledger, 'claim');
      const result = await fixture.purchase(client, 'rust-pay-e2e');
      expect(result).toMatchObject({ status: 'PAID', paymentStatus: 'PAID', deliveryStatus: 'COMPLETE',
        executionMode: 'live_devnet', amount: '200000', resource: TEST_DELIVERY });
      expect(reserved).toHaveBeenCalledOnce();
      expect(claimed).toHaveBeenCalledOnce();
      expect(fixture.signatureCalls).toBe(1);
      expect(fixture.paidRequests).toBe(1);
      expect(fixture.rpcMethods).toContain('getLatestBlockhash');
      expect(fixture.rpcMethods).toContain('getTransaction');
      expect(fixture.rpcMethods).not.toContain('sendTransaction');
      expect(fixture.execution.calls).toEqual({ quote: 2, prepare: 1, interpret: 1 });
      const record = fixture.record('rust-pay-e2e');
      expect(record).toMatchObject({ status: 'PAID', ownerCardMemberId: fixture.memberId,
        paymentPayloadPresent: true, paymentEvidence: { version: 3, source: 'buyer_rpc' } });
      expect(record?.intent.authority?.grantId).toBe(fixture.app.spendGrantSummary()?.id);
      expect(fixture.app.ledger.savedOriginalPayment(record!.approvalId)).toMatchObject({ state: 'CONFIRMED',
        evidence: { requestId: 'rust-pay-e2e', identity: { amount: '200000', payer: fixture.buyer.publicKey.toBase58() } } });
      expect(fixture.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ paid: '200000', reserved: '0' });
      expect(fixture.app.spendGrantSummary()?.committed).toBe('200000');
      const events = fixture.app.ledger.eventsForOwner('rust-pay-e2e', fixture.memberId).map(event => event.type);
      expect(events.filter(type => type === 'payment.SUBMISSION_ATTEMPTED')).toHaveLength(1);
      expect(events.filter(type => type === 'payment.PAID')).toHaveLength(1);
    } finally { await fixture.close(); }
  }, 30_000);

  it('applies the production daily authority before Rust preparation or signing', async () => {
    const fixture = await productionPayFixture();
    try {
      fixture.app.setDailyLimit('100000');
      const result = await fixture.purchase(await fixture.connect(), 'rust-pay-over-authority');
      expect(result.status).toBe('DENIED');
      expect(fixture.signatureCalls).toBe(0);
      expect(fixture.rpcMethods).not.toContain('getLatestBlockhash');
      expect(fixture.paidRequests).toBe(0);
      expect(fixture.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ paid: '0', reserved: '0' });
    } finally { await fixture.close(); }
  }, 30_000);

  it('keeps one claim, signature, initial HTTP and ledger charge across concurrent duplicate operations and a lost Agent ACK', async () => {
    const prepare = deferred(); const release = deferred();
    const fixture = await productionPayFixture({ hooks: { beforePrepare: async () => { prepare.resolve(); await release.promise; } } });
    try {
      const client = await fixture.connect();
      const first = fixture.purchase(client, 'rust-pay-duplicate');
      await reachBoundary(prepare, first);
      const duplicate = await fixture.purchase(client, 'rust-pay-duplicate');
      expect(duplicate.reused).toBe(true);
      expect(duplicate.status).toBe('PAYING');
      release.resolve();
      expect((await first).status).toBe('PAID');
      expect((await fixture.purchase(client, 'rust-pay-duplicate')).status).toBe('PAID');
      expect(fixture.signatureCalls).toBe(1);
      expect(fixture.paidRequests).toBe(1);
      expect(fixture.app.ledger.eventsForOwner('rust-pay-duplicate', fixture.memberId)
        .filter(event => event.type === 'payment.PAID')).toHaveLength(1);

      fixture.loseAgentResponseOnce();
      await expect(fixture.post('rust-pay-lost-ack')).rejects.toThrow();
      const replay = await fixture.purchase(client, 'rust-pay-lost-ack');
      expect(replay).toMatchObject({ reused: true, status: 'PAID', deliveryStatus: 'COMPLETE' });
      expect(fixture.signatureCalls).toBe(2);
      expect(fixture.paidRequests).toBe(2);
      expect(fixture.transactions.size).toBe(2);
      expect(fixture.record('rust-pay-lost-ack')?.transaction).not.toBe(fixture.record('rust-pay-duplicate')?.transaction);
      expect(fixture.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ paid: '400000', reserved: '0' });
    } finally { release.resolve(); await fixture.close(); }
  }, 30_000);

  it('orders Pause ahead of claim without starting the signer or first HTTP', async () => {
    const fixture = await productionPayFixture();
    try {
      const claim = fixture.app.ledger.claim.bind(fixture.app.ledger);
      vi.spyOn(fixture.app.ledger, 'claim').mockImplementationOnce((...args) => {
        fixture.app.setPaused(true);
        return claim(...args);
      });
      const client = await fixture.connect();
      expect((await fixture.purchase(client, 'rust-pay-pause-claim')).status).toBe('APPROVED');
      expect(fixture.signatureCalls).toBe(0);
      expect(fixture.paidRequests).toBe(0);
      expect((await fixture.purchase(client, 'rust-pay-pause-claim')).status).not.toBe('PAID');
      expect(fixture.signatureCalls).toBe(0);
      expect(fixture.paidRequests).toBe(0);
    } finally { await fixture.close(); }
  }, 30_000);

  it('stops a claim already in prepare after Pause and resume without authorizing a stale signer', async () => {
    const prepared = deferred(); const release = deferred();
    const fixture = await productionPayFixture({ hooks: { beforePrepare: async () => { prepared.resolve(); await release.promise; } } });
    try {
      const pending = fixture.purchase(await fixture.connect(), 'rust-pay-old-instance');
      await reachBoundary(prepared, pending);
      fixture.app.setPaused(true); fixture.app.setPaused(false);
      release.resolve();
      expect((await pending).status).toBe('FAILED');
      expect(fixture.signatureCalls).toBe(0);
      expect(fixture.paidRequests).toBe(0);
      expect(fixture.record('rust-pay-old-instance')?.paymentPayloadPresent).toBe(false);
    } finally { release.resolve(); await fixture.close(); }
  }, 30_000);

  it('fences the claimed operation when Pause and Resume occur while preflight is awaiting its network response', async () => {
    const release = deferred();
    const fixture = await productionPayFixture({ preflightBarrier: release });
    try {
      const client = await fixture.connect();
      const pending = fixture.purchase(client, 'rust-pay-pause-preflight');
      await reachBoundary(fixture.preflightStarted, pending);
      expect(fixture.record('rust-pay-pause-preflight')?.status).toBe('PAYING');
      expect(fixture.execution.calls.prepare).toBe(0);
      fixture.app.setPaused(true);
      fixture.app.setPaused(false);
      release.resolve();
      expect((await pending).status).toBe('FAILED');
      expect((await fixture.purchase(client, 'rust-pay-pause-preflight')).status).toBe('FAILED');
      expect(fixture.signatureCalls).toBe(0);
      expect(fixture.paidRequests).toBe(0);
      expect(fixture.execution.calls.prepare).toBe(0);
      expect(fixture.record('rust-pay-pause-preflight')?.paymentPayloadPresent).toBe(false);
      expect(fixture.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ paid: '0', reserved: '0' });
    } finally { release.resolve(); await fixture.close(); }
  }, 30_000);

  it('delivers the original paid response when Rust interpretation fails and still proves the original transaction', async () => {
    const fixture = await productionPayFixture();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const interpret = vi.spyOn(fixture.execution.executor, 'interpretResponse').mockRejectedValue(new Error('TEST_INTERPRETER_UNAVAILABLE'));
    try {
      const client = await fixture.connect();
      expect(await fixture.purchase(client, 'rust-pay-interpreter-failed')).toMatchObject({
        status: 'PAID', deliveryStatus: 'COMPLETE', resource: TEST_DELIVERY,
      });
      expect(interpret).toHaveBeenCalledOnce();
      expect(fixture.rpcMethods).toContain('getTransaction');
      expect(fixture.record('rust-pay-interpreter-failed')?.paymentEvidence).toMatchObject({ version: 3, source: 'buyer_rpc' });
      expect(fixture.signatureCalls).toBe(1);
      expect(fixture.paidRequests).toBe(1);
      expect((await fixture.purchase(client, 'rust-pay-interpreter-failed')).resource).toEqual(TEST_DELIVERY);
      expect(fixture.paidRequests).toBe(1);
      expect(warning).toHaveBeenCalledWith('Protocol response interpretation unavailable; original payment reconciliation continues',
        { code: 'PAY_PROTOCOL_OBSERVATION_FAILED' });
    } finally { interpret.mockRestore(); warning.mockRestore(); await fixture.close(); }
  }, 30_000);

  it('persists verified delivery before waiting for an unavailable interpreter', async () => {
    const fixture = await productionPayFixture();
    const entered = deferred(); const release = deferred();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const interpret = vi.spyOn(fixture.execution.executor, 'interpretResponse').mockImplementation(async () => {
      entered.resolve(); await release.promise; throw new Error('TEST_INTERPRETER_TIMEOUT');
    });
    try {
      const pending = fixture.purchase(await fixture.connect(), 'rust-pay-interpreter-delayed');
      await reachBoundary(entered, pending);
      expect(fixture.record('rust-pay-interpreter-delayed')).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', data: TEST_DELIVERY });
      expect(fixture.paidRequests).toBe(1);
      release.resolve();
      expect(await pending).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE', resource: TEST_DELIVERY });
      expect(fixture.signatureCalls).toBe(1);
      expect(fixture.paidRequests).toBe(1);
    } finally { release.resolve(); interpret.mockRestore(); warning.mockRestore(); await fixture.close(); }
  }, 30_000);

  it('permits an in-flight offline signature to finish but Pause prevents its first HTTP', async () => {
    const barrier = deferred();
    const fixture = await productionPayFixture({ signerBarrier: barrier });
    try {
      const pending = fixture.purchase(await fixture.connect(), 'rust-pay-pause-in-signer');
      await reachBoundary(fixture.signerStarted, pending);
      fixture.app.setPaused(true);
      barrier.resolve();
      expect((await pending).status).toBe('FAILED');
      expect(fixture.signatureCalls).toBe(1);
      expect(fixture.paidRequests).toBe(0);
      expect(fixture.record('rust-pay-pause-in-signer')?.paymentPayloadPresent).toBe(false);
    } finally { barrier.resolve(); await fixture.close(); }
  }, 30_000);

  it('blocks a completed signature before persistence and first HTTP after Pause', async () => {
    const signed = deferred(); const release = deferred();
    const fixture = await productionPayFixture({ hooks: { afterSigned: async () => { signed.resolve(); await release.promise; } } });
    try {
      const pending = fixture.purchase(await fixture.connect(), 'rust-pay-pause-signed');
      await reachBoundary(signed, pending);
      fixture.app.setPaused(true);
      release.resolve();
      expect((await pending).status).toBe('FAILED');
      expect(fixture.signatureCalls).toBe(1);
      expect(fixture.paidRequests).toBe(0);
    } finally { release.resolve(); await fixture.close(); }
  }, 30_000);

  it('blocks a durably saved signature before first HTTP when Pause wins the submission gate', async () => {
    const fixture = await productionPayFixture();
    try {
      const savePayload = fixture.app.ledger.savePayload.bind(fixture.app.ledger);
      vi.spyOn(fixture.app.ledger, 'savePayload').mockImplementationOnce((...args) => {
        savePayload(...args);
        fixture.app.setPaused(true);
      });
      const result = await fixture.purchase(await fixture.connect(), 'rust-pay-pause-persisted');
      expect(result.status).toBe('FAILED');
      expect(fixture.signatureCalls).toBe(1);
      expect(fixture.paidRequests).toBe(0);
      const record = fixture.record('rust-pay-pause-persisted');
      expect(record?.paymentPayloadPresent).toBe(true);
      expect(fixture.app.ledger.savedOriginalPayment(record!.approvalId)?.state).toBe('NOT_SUBMITTED');
      expect(fixture.app.ledger.managedSummary(Date.now(), 'live_devnet').reserved).toBe('0');
    } finally { await fixture.close(); }
  }, 30_000);

  it('allows the already started original HTTP to complete and reconcile after Pause', async () => {
    const barrier = deferred();
    const fixture = await productionPayFixture();
    fixture.pauseMerchantResponse(barrier);
    try {
      const pending = fixture.purchase(await fixture.connect(), 'rust-pay-pause-submitted');
      await reachBoundary(fixture.merchantArrived, pending);
      expect(fixture.app.ledger.savedOriginalPayment(fixture.record('rust-pay-pause-submitted')!.approvalId)?.state).toBe('SUBMISSION_ATTEMPTED');
      fixture.app.setPaused(true);
      barrier.resolve();
      expect(await pending).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
      expect(fixture.signatureCalls).toBe(1);
      expect(fixture.paidRequests).toBe(1);
      expect(fixture.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ paid: '200000', reserved: '0', paused: true });
    } finally { barrier.resolve(); await fixture.close(); }
  }, 30_000);

  it('retains marker-before-HTTP uncertainty on interruption and recovers the original after the Rust executor is disabled', async () => {
    const fixture = await productionPayFixture();
    try {
      const mark = fixture.app.ledger.markSubmissionAttempt.bind(fixture.app.ledger);
      vi.spyOn(fixture.app.ledger, 'markSubmissionAttempt').mockImplementationOnce((...args) => {
        mark(...args);
        throw new Error('TEST_INTERRUPTION_AFTER_DURABLE_MARKER');
      });
      const client = await fixture.connect();
      expect((await fixture.purchase(client, 'rust-pay-marker-interruption')).status).toBe('PAYMENT_UNKNOWN');
      const record = fixture.record('rust-pay-marker-interruption')!;
      const original = fixture.app.ledger.savedOriginalPayment(record.approvalId)!;
      const payload = fixture.app.ledger.savedPayload(record.approvalId)!;
      expect(original.state).toBe('OUTCOME_UNKNOWN');
      expect(fixture.paidRequests).toBe(0);
      expect(fixture.signatureCalls).toBe(1);
      expect(fixture.app.ledger.managedSummary(Date.now(), 'live_devnet').reserved).toBe('200000');

      await fixture.reopenWithoutPayExecutor();
      await fixture.app.start(fixture.origin);
      expect(fixture.record('rust-pay-marker-interruption')?.status).toBe('PAYMENT_UNKNOWN');
      expect(fixture.app.ledger.managedSummary(Date.now(), 'live_devnet').reserved).toBe('200000');
      expect(fixture.app.ledger.savedOriginalPayment(record.approvalId)?.evidence).toEqual(original.evidence);
      // RPC visibility appears later for the same buyer-signed message. The fake
      // chain adds only the sponsor signature; no replacement payment is built.
      fixture.acceptPayload(payload);
      expect((await fixture.purchase(client, 'rust-pay-marker-interruption')).status).toBe('PAID');
      expect(fixture.signatureCalls).toBe(1);
      expect(fixture.app.ledger.eventsForOwner('rust-pay-marker-interruption', fixture.memberId)
        .filter(event => event.type === 'payment.PAID')).toHaveLength(1);
      expect(fixture.app.ledger.savedOriginalPayment(record.approvalId)?.evidence).toEqual(original.evidence);
    } finally { await fixture.close(); }
  }, 30_000);

  it('finds and reconciles the same payment after a lost merchant response without creating a second signature', async () => {
    const fixture = await productionPayFixture();
    try {
      fixture.loseMerchantResponseOnce();
      const client = await fixture.connect();
      const first = await fixture.purchase(client, 'rust-pay-lost-merchant-ack');
      expect(first.status).toBe('PAID');
      expect(fixture.signatureCalls).toBe(1);
      expect(fixture.rpcMethods).toContain('getSignaturesForAddress');
      expect(fixture.rpcMethods).toContain('getTransaction');
      const retry = await fixture.purchase(client, 'rust-pay-lost-merchant-ack');
      expect(retry).toMatchObject({ status: 'PAID', reused: true });
      expect(fixture.signatureCalls).toBe(1);
      expect(new Set(fixture.paidHeaders).size).toBe(1);
      expect(fixture.app.ledger.eventsForOwner('rust-pay-lost-merchant-ack', fixture.memberId)
        .filter(event => event.type === 'payment.PAID')).toHaveLength(1);
    } finally { await fixture.close(); }
  }, 30_000);

  it('survives an actual SIGKILL after the durable marker and before HTTP with the original Unknown reservation intact', async () => {
    const fixture = await productionPayFixture();
    try {
      await fixture.crashAfterSubmissionMarker('rust-pay-process-crash');
      expect(fixture.paidRequests).toBe(0);
      await fixture.reopenWithoutPayExecutor();
      const beforeRecovery = fixture.record('rust-pay-process-crash')!;
      expect(beforeRecovery.status).toBe('PAYING');
      const original = fixture.app.ledger.savedOriginalPayment(beforeRecovery.approvalId)!;
      expect(original.state).toBe('SUBMISSION_ATTEMPTED');
      expect(original.submissionAttemptedAt).toBeTypeOf('number');
      await fixture.app.start(fixture.origin);
      expect(fixture.record('rust-pay-process-crash')?.status).toBe('PAYMENT_UNKNOWN');
      expect(fixture.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ reserved: '200000', paid: '0' });
      expect(fixture.app.ledger.savedOriginalPayment(beforeRecovery.approvalId)?.evidence).toEqual(original.evidence);
      const client = await fixture.connect();
      expect((await fixture.purchase(client, 'rust-pay-process-crash')).status).toBe('PAYMENT_UNKNOWN');
      expect(fixture.paidRequests).toBe(0);
      expect(fixture.app.ledger.eventsForOwner('rust-pay-process-crash', fixture.memberId)
        .filter(event => event.type === 'payment.SUBMISSION_ATTEMPTED')).toHaveLength(1);
    } finally { await fixture.close(); }
  }, 30_000);
});
