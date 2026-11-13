import { buildSync } from 'esbuild';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import type { startOfflineServices } from '../../src/modules/pay-dev/offline-services';
import { DEVNET_USDC_MINT } from '../../src/modules/payment/payment-config';
import { paidResource } from '../../src/modules/resources/paid-resources';

const requireDependency = createRequire(import.meta.url);
const directories: string[] = [];
const services: Awaited<ReturnType<typeof startOfflineServices>>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function fixture(plugin = true) {
  const root = mkdtempSync(join(tmpdir(), 'yosh-plugin-offline-fault-')); directories.push(root);
  const directory = join(root, 'simulator'); mkdirSync(directory, { mode: 0o700 });
  const entry = join(root, 'services.cjs');
  buildSync({ entryPoints: [resolve('src/modules/pay-dev/offline-services.ts')], bundle: true, platform: 'node',
    format: 'cjs', packages: 'external', define: { __YOSH_PLUGIN_DEV__: String(plugin), __YOSH_RC5__: 'false' }, outfile: entry });
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  const exported: unknown = requireDependency(entry);
  const start = z.object({ startOfflineServices: z.custom<typeof startOfflineServices>(value => typeof value === 'function') }).parse(exported).startOfflineServices;
  vi.stubEnv('YOSH_PAY_DEV', '1'); vi.stubEnv('YOSH_PAY_DEV_ENV', 'offline');
  return { directory, file: join(directory, 'offline-fault.json'), async start(buyer: string) {
    const service = await start({ directory, buyer, merchantPort: 0, rpcPort: 0 }); services.push(service); return service;
  } };
}
async function rpc(service: Awaited<ReturnType<typeof startOfflineServices>>, method: string, params: unknown[] = []) {
  const response = await fetch(service.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: response.status, json: await response.json() };
}
function payment(buyer: Keypair, requirement: PaymentRequirements, blockhash: string, resource: PaymentPayload['resource']): PaymentPayload {
  const mint = new PublicKey(DEVNET_USDC_MINT);
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(String(requirement.extra?.feePayer)), recentBlockhash: blockhash,
    instructions: [createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, buyer.publicKey), mint,
      getAssociatedTokenAddressSync(mint, new PublicKey(requirement.payTo)), buyer.publicKey, BigInt(requirement.amount), 6),
    new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [],
      data: Buffer.from(String(requirement.extra?.memo)) })] }).compileToV0Message());
  transaction.sign([buyer]);
  return { x402Version: 2, resource, accepted: requirement, payload: { transaction: Buffer.from(transaction.serialize()).toString('base64') } };
}

it('rejects unsafe, symlinked, oversized and unknown operator fixture files', async () => {
  const f = fixture(); const buyer = Keypair.generate().publicKey.toBase58();
  writeFileSync(f.file, JSON.stringify({ version: 1, mode: 'none' }), { mode: 0o644 });
  await expect(f.start(buyer)).rejects.toThrow('OFFLINE_FAULT_REJECTED');
  chmodSync(f.file, 0o600);
  for (const value of [{ version: 1, mode: 'send-new-payment' }, { version: 2, mode: 'none' },
    { version: 1, mode: 'none', amount: '1' }, { version: 1, mode: 'x'.repeat(512) }]) {
    writeFileSync(f.file, JSON.stringify(value));
    await expect(f.start(buyer)).rejects.toThrow('OFFLINE_FAULT_REJECTED');
  }
  unlinkSync(f.file); symlinkSync(join(f.directory, 'missing-file'), f.file);
  await expect(f.start(buyer)).rejects.toThrow('OFFLINE_FAULT_REJECTED');
});

it.each([false, true])('non-plugin or non-Offline builds ignore the fixture file (plugin=%s)', async plugin => {
  const f = fixture(plugin);
  if (plugin) vi.stubEnv('YOSH_PAY_DEV_ENV', 'simulated');
  symlinkSync(join(f.directory, 'must-not-read'), f.file);
  const service = await f.start(Keypair.generate().publicKey.toBase58());
  expect((await fetch(service.origin + paidResource('market-snapshot').path)).status).toBe(402);
});

it.each(['lose-paid-response-and-rpc', 'delivery-unavailable'] as const)('persists one original payment through %s and restores its identical delivery after restart', async mode => {
  const f = fixture(); const buyer = Keypair.generate(); const service = await f.start(buyer.publicKey.toBase58());
  const target = service.origin + paidResource('market-snapshot').path;
  const quote = decodePaymentRequiredHeader((await fetch(target)).headers.get('payment-required')!);
  const blockhash = (await rpc(service, 'getLatestBlockhash')).json.result.value.blockhash;
  const payload = payment(buyer, quote.accepts[0], blockhash, quote.resource);
  const request = () => fetch(target, { headers: { 'payment-signature': encodePaymentSignatureHeader(payload) } });
  writeFileSync(f.file, JSON.stringify({ version: 1, mode }), { mode: 0o600 });
  if (mode === 'lose-paid-response-and-rpc') await expect(request()).rejects.toThrow();
  else {
    const missing = await request(); expect(missing.status).toBe(503);
    expect(decodePaymentResponseHeader(missing.headers.get('payment-response')!).success).toBe(true);
  }
  const state = z.object({ transactions: z.array(z.object({ signature: z.string(), amount: z.string(), delivery: z.unknown() })) })
    .parse(JSON.parse(readFileSync(join(f.directory, 'offline-network.json'), 'utf8')));
  expect(state.transactions).toHaveLength(1); expect(state.transactions[0].amount).toBe('200000');
  const original = state.transactions[0];
  expect((await rpc(service, 'getTransaction', [original.signature])).status).toBe(mode === 'lose-paid-response-and-rpc' ? 503 : 200);
  await service.close();
  writeFileSync(f.file, JSON.stringify({ version: 1, mode: 'none' }));
  const restarted = await f.start(buyer.publicKey.toBase58()); expect(restarted.origin).toBe(service.origin);
  const restored = await request(); expect(restored.status).toBe(200); expect(await restored.json()).toEqual(original.delivery);
  expect(decodePaymentResponseHeader(restored.headers.get('payment-response')!).transaction).toBe(original.signature);
  const durable = z.object({ transactions: z.array(z.unknown()) }).parse(JSON.parse(readFileSync(join(f.directory, 'offline-network.json'), 'utf8')));
  expect(durable.transactions).toHaveLength(1);
  const ata = getAssociatedTokenAddressSync(new PublicKey(DEVNET_USDC_MINT), buyer.publicKey).toBase58();
  expect((await rpc(restarted, 'getTokenAccountBalance', [ata])).json.result.value.amount).toBe('9800000');
});
