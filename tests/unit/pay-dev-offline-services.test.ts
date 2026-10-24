import { mkdtempSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { startOfflineServices } from '../../src/modules/pay-dev/offline-services';
import { paidResource } from '../../src/modules/resources/paid-resources';
import { verifyOriginalTransactionSignatures } from '../../src/modules/payment/original-payment-evidence';
import { DEVNET_USDC_MINT, loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { runPaymentPreflight } from '../../src/modules/payment/payment-preflight';

const directories: string[] = [];
const services: Awaited<ReturnType<typeof startOfflineServices>>[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const result = mkdtempSync(join(tmpdir(), 'yosh-pay-dev-services-')); directories.push(result); return result; }
async function start(path: string, buyer: string, publicOrigin?: string) {
  const service = await startOfflineServices({ directory: path, buyer, merchantPort: 0, rpcPort: 0, ...(publicOrigin ? { publicOrigin } : {}) }); services.push(service); return service;
}
async function rpc(service: Awaited<ReturnType<typeof startOfflineServices>>, method: string, params: unknown[] = []) {
  const response = await fetch(service.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: response.status, json: await response.json() };
}
function transaction(buyer: Keypair, requirement: PaymentRequirements, blockhash: string) {
  const mint = new PublicKey(DEVNET_USDC_MINT);
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(String(requirement.extra?.feePayer)), recentBlockhash: blockhash,
    instructions: [createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, buyer.publicKey), mint,
      getAssociatedTokenAddressSync(mint, new PublicKey(requirement.payTo)), buyer.publicKey, BigInt(requirement.amount), 6),
    new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from(String(requirement.extra?.memo)) })],
  }).compileToV0Message());
  tx.sign([buyer]); return tx;
}

it('persists endpoints, stable accepted offers and unique issued blockhashes across restart', async () => {
  const path = directory(); const buyer = Keypair.generate().publicKey.toBase58(); const first = await start(path, buyer);
  const target = paidResource('market-snapshot').path;
  const originalQuote = (await fetch(first.origin + target)).headers.get('payment-required');
  expect(originalQuote).toBeTruthy();
  const firstBlock = await rpc(first, 'getLatestBlockhash');
  const secondBlock = await rpc(first, 'getLatestBlockhash');
  expect(firstBlock.json.result.value.blockhash).not.toBe(secondBlock.json.result.value.blockhash);
  await first.close(); const again = await start(path, buyer);
  expect(again.origin).toBe(first.origin); expect(again.rpcUrl).toBe(first.rpcUrl);
  expect((await fetch(again.origin + target)).headers.get('payment-required')).toBe(originalQuote);
  expect((await rpc(again, 'getLatestBlockhash')).json.result.value.blockhash).not.toBe(firstBlock.json.result.value.blockhash);
  expect((await rpc(again, 'sendTransaction', ['arbitrary'])).status).toBe(400);
  expect((await rpc(again, 'getTransaction', ['arbitrary'])).json.result).toBeNull();
});

it('only accepts the exact buyer-signed transfer, then persists original settlement and delivery once', async () => {
  const path = directory(); const buyer = Keypair.generate(); const service = await start(path, buyer.publicKey.toBase58());
  const url = service.origin + paidResource('market-snapshot').path;
  const quote = decodePaymentRequiredHeader((await fetch(url)).headers.get('payment-required')!);
  const blockhash = (await rpc(service, 'getLatestBlockhash')).json.result.value.blockhash;
  const tx = transaction(buyer, quote.accepts[0], blockhash);
  const payload: PaymentPayload = { x402Version: 2, resource: quote.resource, accepted: quote.accepts[0], payload: { transaction: Buffer.from(tx.serialize()).toString('base64') } };
  expect((await rpc(service, 'simulateTransaction', [payload.payload.transaction])).status).toBe(200);
  const post = (value: PaymentPayload) => fetch(url, { headers: { 'payment-signature': encodePaymentSignatureHeader(value) } });
  expect((await post({ ...payload, accepted: { ...payload.accepted, amount: '1' } })).status).toBe(400);
  const changedTransfer = transaction(buyer, { ...quote.accepts[0], amount: '1' }, blockhash);
  expect((await post({ ...payload, payload: { transaction: Buffer.from(changedTransfer.serialize()).toString('base64') } })).status).toBe(400);
  tx.signatures[1][0] ^= 1;
  expect((await post({ ...payload, payload: { transaction: Buffer.from(tx.serialize()).toString('base64') } })).status).toBe(400);
  const successful = await post(payload); expect(successful.status).toBe(200);
  const result = await successful.json(); const receipt = decodePaymentResponseHeader(successful.headers.get('payment-response')!);
  const repeat = await post(payload); expect(await repeat.json()).toEqual(result);
  expect(decodePaymentResponseHeader(repeat.headers.get('payment-response')!)).toEqual(receipt);
  const stored = (await rpc(service, 'getTransaction', [receipt.transaction])).json.result;
  expect(verifyOriginalTransactionSignatures(VersionedTransaction.deserialize(Buffer.from(stored.transaction[0], 'base64')), true)).toBe(true);
  const mint = new PublicKey(DEVNET_USDC_MINT); const ata = getAssociatedTokenAddressSync(mint, buyer.publicKey).toBase58();
  expect((await rpc(service, 'getTokenAccountBalance', [ata])).json.result.value.amount).toBe('9800000');
  await service.close(); const again = await start(path, buyer.publicKey.toBase58());
  const restored = await fetch(again.origin + paidResource('market-snapshot').path, { headers: { 'payment-signature': encodePaymentSignatureHeader(payload) } });
  expect(restored.status).toBe(200); expect(await restored.json()).toEqual(result);
  expect((await rpc(again, 'getTransaction', [receipt.transaction])).json.result).toEqual(stored);
  expect((await rpc(again, 'getTokenAccountBalance', [ata])).json.result.value.amount).toBe('9800000');
  const state = JSON.parse(readFileSync(join(path, 'offline-network.json'), 'utf8'));
  expect(state.transactions).toHaveLength(1); expect(state).not.toHaveProperty('budget'); expect(state).not.toHaveProperty('grant');
});

it('provides all existing UI quotes with the public backend origin while retaining a private merchant endpoint', async () => {
  const service = await start(directory(), Keypair.generate().publicKey.toBase58(), 'http://127.0.0.1:13449');
  expect(service.origin).toBe('http://127.0.0.1:13449');
  for (const id of ['market-snapshot', 'market-analysis', 'token-risk-report'] as const) {
    const target = paidResource(id).path;
    const response = await fetch(service.merchantOrigin + target);
    expect(response.status).toBe(402);
    expect(decodePaymentRequiredHeader(response.headers.get('payment-required')!).resource.url).toBe(service.origin + target);
  }
});

it('passes the existing real payment preflight with a simulated funded sponsor', async () => {
  const buyer = Keypair.generate().publicKey.toBase58(); const service = await start(directory(), buyer);
  const config = loadPaymentConfig({ YOSH_EXECUTION_MODE: 'live_devnet', DEMO_BUYER_PUBLIC_KEY: buyer,
    DEMO_MERCHANT_PUBLIC_KEY: service.merchant, SOLANA_RPC_URL: 'https://rpc.offline.invalid',
    X402_FACILITATOR_URL: 'https://facilitator.offline.invalid' });
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'https://rpc.offline.invalid') return fetch(service.rpcUrl, init);
    if (url.href === 'https://facilitator.offline.invalid/supported') return fetch(service.merchantOrigin + '/supported', init);
    throw new Error('OFFLINE_TEST_NETWORK_REJECTED');
  };
  const result = await runPaymentPreflight(config, { fetch: fetcher, amount: '200000' });
  expect(result.readyForSettlement).toBe(true);
  expect(result.facilitator.feePayer).toBe(service.sponsor);
  expect(result.facilitator.feePayerLamports).toBe(1000000000);
  expect(result.buyer.balanceBaseUnits).toBe('10000000');
});

it('refuses changed buyer, unsafe storage, duplicate ownership and remote public origins', async () => {
  const path = directory(); const buyer = Keypair.generate().publicKey.toBase58(); const service = await start(path, buyer);
  await expect(start(path, buyer)).rejects.toThrow('OFFLINE_SERVICES_ALREADY_RUNNING');
  await service.close(); await expect(start(path, Keypair.generate().publicKey.toBase58())).rejects.toThrow('OFFLINE_SERVICES_BUYER_CHANGED');
  await expect(startOfflineServices({ directory: path, buyer, publicOrigin: 'https://example.com' })).rejects.toThrow('OFFLINE_SERVICES_PUBLIC_ORIGIN_REJECTED');
  chmodSync(join(path, 'offline-network.json'), 0o644);
  await expect(start(path, buyer)).rejects.toThrow('OFFLINE_SERVICES_PRIVATE_STORAGE_REQUIRED');
  const unsafe = directory(); symlinkSync(path, join(unsafe, 'linked'));
  await expect(startOfflineServices({ directory: join(unsafe, 'linked'), buyer })).rejects.toThrow('OFFLINE_SERVICES_PRIVATE_STORAGE_REQUIRED');
  const symlink = directory(); symlinkSync(join(path, 'offline-network.json'), join(symlink, 'offline-network.json'));
  await expect(start(symlink, buyer)).rejects.toThrow('OFFLINE_SERVICES_PRIVATE_STORAGE_REQUIRED');
});
