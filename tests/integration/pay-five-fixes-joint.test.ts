import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { GET as deliveryGET } from '../../src/app/api/agent/purchases/[purchaseId]/delivery/route';
import { readConnection } from '../../src/modules/mcp/connection';
import { createAgentServer } from '../../src/modules/mcp/server';
import { hash } from '../../src/modules/purchases/spending-policy';
import { deferred, productionPayFixture } from '../helpers/pay-production-fixture';

it('combines original multi-offer crash recovery, permit expiry, maximum delivery replay and credential filtering', async () => {
  const f = await productionPayFixture({ payMcp: true, quoteAlternatives: 'price' });
  const release = deferred();
  f.pauseMerchantResponse(release);
  const operation = 'five-fixes-joint';
  const client = new Client({ name: 'joint-delivery-test', version: '1' });
  const readDelivery = (purchaseId: string, offset: number) => deliveryGET(new Request(
    `${f.origin}/api/agent/purchases/${purchaseId}/delivery?offset=${offset}`,
    { headers: { authorization: `Bearer ${readConnection(f.directory).token}` } }),
  { params: Promise.resolve({ purchaseId }) });
  const server = createAgentServer(async () => ({}), undefined, undefined, async (purchaseId, offset) => {
    const response = await readDelivery(purchaseId, offset);
    if (response.status !== 200) throw new Error('DELIVERY_NOT_AVAILABLE');
    const value: unknown = await response.json();
    return value;
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const chunkSchema = z.object({ totalBytes: z.number(), offset: z.number(), chunk: z.string(), nextOffset: z.number().nullable() });
  try {
    await f.crashAfterSubmissionMarker(operation, 'http');
    expect(f.paidRequests).toBe(1);
    await f.reopenWithoutPayExecutor();
    const submitted = f.payRecord(operation)!;
    const original = f.app.ledger.savedOriginalPayment(submitted.approvalId)!;
    const payload = f.app.ledger.savedPayload(submitted.approvalId)!;
    const permit = f.app.ledger.executionSafety.permit(submitted);
    expect(submitted.status).toBe('PAYING');
    expect(original.state).toBe('SUBMISSION_ATTEMPTED');
    expect(submitted.intent.x402Challenge?.accepts).toHaveLength(2);
    expect(payload.accepted).toEqual(submitted.quote);
    f.app.ledger.releaseExpired(permit.expiresAt + 1, submitted.monetaryScope);
    expect(f.payRecord(operation)?.status).toBe('PAYING');
    expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ paid: '0', reserved: '200000' });
    expect(f.app.ledger.savedOriginalPayment(submitted.approvalId)?.evidence).toEqual(original.evidence);

    release.resolve();
    await f.app.start(f.origin);
    expect((await f.callPay(await f.connectPay(), operation)).isError).not.toBe(true);
    const paid = f.payRecord(operation)!;
    expect(paid).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
    const budget = f.app.ledger.managedSummary(Date.now(), 'live_devnet');
    expect(budget).toMatchObject({ paid: '200000', reserved: '0' });
    const requestsAfterRecovery = f.paidRequests;
    expect(new Set(f.paidHeaders).size).toBe(1);
    const assertOriginalUnchanged = () => {
      const current = f.payRecord(operation)!;
      expect(current).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
      expect(current.quote).toEqual(submitted.quote);
      expect(current.intent.x402Challenge).toEqual(submitted.intent.x402Challenge);
      expect(f.app.ledger.savedPayload(current.approvalId)).toEqual(payload);
      expect(f.app.ledger.savedOriginalPayment(current.approvalId)?.evidence).toEqual(original.evidence);
      expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toEqual(budget);
      expect(f.app.ledger.eventsForOwner(current.intent.idempotencyKey, f.memberId).filter(event => event.type === 'payment.PAID')).toHaveLength(1);
      // The child signed before SIGKILL. Recovery and replay never use the parent signer.
      expect(f.signatureCalls).toBe(0);
      expect(f.paidRequests).toBe(requestsAfterRecovery);
    };
    f.app.ledger.releaseExpired(permit.expiresAt + 1, submitted.monetaryScope);
    assertOriginalUnchanged();

    // This historical-data fixture tests persisted output bounds. The fixed
    // merchant schema above does not claim to deliver arbitrary policy-max text.
    const text = '\0'.repeat(262_144);
    const encoded = Buffer.from(JSON.stringify(text));
    expect(encoded.length).toBe(1_572_866);
    const persist = (data: unknown) => z.instanceof(DatabaseSync).parse(Reflect.get(f.app.ledger, 'db'))
      .prepare('UPDATE purchases SET data=? WHERE id=?').run(JSON.stringify(data), submitted.intent.id);
    persist(text);
    await f.reopenWithoutPayExecutor();
    await f.app.start(f.origin);
    const replay = await f.callPay(await f.connectPay(), operation);
    expect(replay.isError).not.toBe(true);
    const content = z.array(z.object({ text: z.string() }).passthrough()).parse(replay.content);
    const spillPath = content[0]!.text.match(/written to (.+?)\. First \d+ chars:/)?.[1];
    expect(spillPath).toBeTruthy();
    try { expect(JSON.parse(readFileSync(spillPath!, 'utf8'))).toBe(text); }
    finally { rmSync(spillPath!, { force: true }); }
    const id = submitted.intent.idempotencyKey;
    for (const offset of [0, 1_048_577, encoded.length - 2]) {
      const response = await readDelivery(id, offset);
      expect(response.status).toBe(200);
      const chunk = chunkSchema.parse(await response.json());
      expect(Buffer.from(chunk.chunk, 'base64')).toEqual(encoded.subarray(offset, offset + 16_384));
    }
    await server.connect(serverTransport); await client.connect(clientTransport);
    const chunks: Buffer[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await client.callTool({ name: 'get_purchase_delivery', arguments: { purchaseId: id, offset } });
      expect(result.isError).not.toBe(true);
      const output = z.array(z.object({ text: z.string() }).passthrough()).parse(result.content);
      const chunk = chunkSchema.parse(JSON.parse(output[0]!.text));
      expect(chunk).toMatchObject({ offset, totalBytes: encoded.length });
      chunks.push(Buffer.from(chunk.chunk, 'base64'));
      offset = chunk.nextOffset;
    }
    expect(Buffer.concat(chunks)).toEqual(encoded);
    assertOriginalUnchanged();

    const facts = z.record(z.string(), z.unknown()).parse(f.lastFacts);
    const changed = { ...z.record(z.string(), z.unknown()).parse(facts.accepted), amount: '200001' };
    const envelope = z.object({ accepts: z.array(z.unknown()) }).passthrough().parse(facts.payment_required);
    await expect(f.authority.authorize({ ...facts, attempt_id: randomUUID(), amount_atomic: '200001', accepted: changed,
      payment_required: { ...envelope, accepts: envelope.accepts.map(quote => hash(quote) === hash(facts.accepted) ? changed : quote) } }, f.principal))
      .rejects.toThrow('PAY_OPERATION_CONFLICT');
    assertOriginalUnchanged();

    const transaction = z.object({ transaction: z.string() }).parse(payload.payload).transaction;
    const reflected = { result: `${'x'.repeat(16_370)}${transaction}` };
    const position = Buffer.from(JSON.stringify(reflected)).indexOf(transaction);
    expect(position).toBeLessThan(16_384);
    expect(position + Buffer.byteLength(transaction)).toBeGreaterThan(16_384);
    persist(reflected);
    await f.reopenWithoutPayExecutor();
    for (const offset of [0, 16_384]) expect((await readDelivery(id, offset)).status).toBe(404);
    expect((await client.callTool({ name: 'get_purchase_delivery', arguments: { purchaseId: id, offset: 16_384 } })).isError).toBe(true);
    const refused = await f.callPay(await f.connectPay(), operation);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).not.toContain(transaction);
    expect(f.payRecord(operation)?.data).toBeUndefined();
    assertOriginalUnchanged();
  } finally {
    release.resolve();
    await client.close(); await server.close(); await f.close();
  }
}, 60_000);
