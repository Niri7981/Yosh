import { expect, it } from 'vitest';
import { readControllerJson } from '../../src/modules/payment/pay-controller-diagnostics';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Public multi-offer metadata makes execute larger than plan; no signatures or secrets.
const envelope = JSON.parse(readFileSync(resolve('../pay/rust/crates/mcp/tests/fixtures/agent402-mainnet-quote.json'), 'utf8'));
const facts = { operation_id: 'fixture-only', attempt_id: '89c0608f-2493-421a-a14f-c436f24fb716', payment_required: { ...envelope, resource: { ...envelope.resource, description: '' } } };
facts.payment_required.resource.description = 'x'.repeat(7800 - Buffer.byteLength(JSON.stringify({ facts })));
it('accepts a bounded controlled execute body after adding the SDK unsigned transaction', async () => {
  const plan = JSON.stringify({ facts });
  const execute = JSON.stringify({ facts, unsigned: { transaction: 'A'.repeat(664), recentBlockhash: '11111111111111111111111111111111', lastValidBlockHeight: '5000' } });
  expect(Buffer.byteLength(plan)).toBeLessThan(8192);
  expect(Buffer.byteLength(execute)).toBeGreaterThan(8192);
  const request = new Request('http://127.0.0.1/pay/execute', { method: 'POST', body: execute });
  // Same controller parsing boundary as management-server.
  await expect(readControllerJson(request)).resolves.toHaveProperty('unsigned');
});

it('keeps controlled bodies above 128 KiB rejected', async () => { await expect(readControllerJson(new Request('http://127.0.0.1/pay/execute', { method: 'POST', body: JSON.stringify({ data: 'x'.repeat(131072) }) }))).rejects.toThrow(); });
