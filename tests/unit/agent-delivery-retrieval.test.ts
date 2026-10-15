import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ record: null as null | { status: string; deliveryStatus: string; data: unknown }, owner: 'member-1' }));
vi.mock('../../src/modules/app/app-runtime', () => ({ appRuntime: () => ({
  authenticateAgent: () => ({ cardMemberId: state.owner }),
  ledger: { getOwned: (_id: string, memberId: string) => memberId === 'member-1' ? state.record : null },
}) }));
import { GET } from '../../src/app/api/agent/purchases/[purchaseId]/delivery/route';

it('returns bounded, resumable bytes only for an owned completed delivery', async () => {
  const payload = { result: 'data'.repeat(12_000) };
  state.record = { status: 'PAID', deliveryStatus: 'COMPLETE', data: payload };
  const pieces: Buffer[] = [];
  let offset = 0; let count = 0;
  do {
    const response = await GET(new Request(`http://127.0.0.1/api/agent/purchases/owned/delivery?offset=${offset}`),
      { params: Promise.resolve({ purchaseId: 'owned' }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { chunk: string; nextOffset: number | null; totalBytes: number };
    pieces.push(Buffer.from(body.chunk, 'base64')); count++;
    if (body.nextOffset === null) break;
    offset = body.nextOffset;
  } while (count < 20);
  expect(count).toBeGreaterThan(1);
  expect(JSON.parse(Buffer.concat(pieces).toString('utf8'))).toEqual(payload);
  state.owner = 'another-member';
  const denied = await GET(new Request('http://127.0.0.1/api/agent/purchases/owned/delivery'),
    { params: Promise.resolve({ purchaseId: 'owned' }) });
  expect(denied.status).toBe(404);
  state.owner = 'member-1'; state.record = { status: 'PAID', deliveryStatus: 'PENDING', data: payload };
  const pending = await GET(new Request('http://127.0.0.1/api/agent/purchases/owned/delivery'),
    { params: Promise.resolve({ purchaseId: 'owned' }) });
  expect(pending.status).toBe(404);
});
