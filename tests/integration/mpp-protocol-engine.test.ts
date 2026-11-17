import { resolve } from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { parseMppChallenge, prepareMppCharge, encodeMppCredential, parseMppReceipt } from '../../src/modules/payment/mpp-protocol-engine';
import { DEVNET_USDC_MINT } from '../../src/modules/payment/payment-config';
import { TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';

const binary = process.env.YOSH_MPP_PROTOCOL_TEST_BINARY ?? resolve('build.noindex/mpp-protocol-engine/yosh-execution-protocol');
const payer = Keypair.generate();
const recipient = Keypair.generate().publicKey.toBase58();
const recentBlockhash = Keypair.generate().publicKey.toBase58();
const hostValidatedLifetime = { recentBlockhash, lastValidBlockHeight: '12345' };
function header(options: { request?: object; details?: object; suffix?: string; method?: string; intent?: string; expires?: string } = {}) {
  const request = { amount: '12345', currency: DEVNET_USDC_MINT, recipient, externalId: 'invoice-42',
    methodDetails: { network: 'devnet', decimals: 6, tokenProgram: TOKEN_PROGRAM, ...options.details }, ...options.request };
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64url');
  return `Payment id="charge-42", realm="merchant.invalid", method="${options.method ?? 'solana'}", intent="${options.intent ?? 'charge'}", request="${encoded}", expires="${options.expires ?? new Date(Date.now() + 60_000).toISOString()}"${options.suffix ?? ''}`;
}

describe('pinned MPP SDK protocol boundary', () => {
  it('selects the unique Solana Charge from combined merchant offers using the SDK', async () => {
    const solana = header({ suffix: ', description="Price, Payment offers"' });
    const tempo = header({ method: 'tempo' });
    const selected = await parseMppChallenge(binary, `${tempo}, ${solana}, ${header({ method: 'stripe' })}`);
    expect(selected.challenge.method).toBe('solana');
    expect(selected.challenge.description).toBe('Price, Payment offers');
    expect(selected.header).not.toContain('method="tempo"');
    expect((await parseMppChallenge(binary, selected.header)).challenge).toEqual(selected.challenge);
  });

  it('rejects ambiguous Solana offers and unsupported selectors within combined headers', async () => {
    await expect(parseMppChallenge(binary, `${header()}, ${header()}`)).rejects.toThrow('MPP_AMBIGUOUS_CHALLENGE');
    await expect(parseMppChallenge(binary, `${header({ method: 'tempo' })}, ${header({ suffix: ', header="Payment-Authorization"' })}`))
      .rejects.toThrow('MPP_UNSUPPORTED_CHALLENGE_PARAMETER');
  });

  it('builds unsigned V0 through the SDK and formats the exact signed credential and original echo', async () => {
    const challenge = await parseMppChallenge(binary, header({ suffix: ', opaque="eyJub25jZSI6IjEifQ"' }));
    const prepared = await prepareMppCharge(binary, { challenge, payer: payer.publicKey.toBase58(), hostValidatedLifetime });
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
    expect(tx.version).toBe(0);
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0].every(byte => byte === 0)).toBe(true);
    expect(tx.message.recentBlockhash).toBe(recentBlockhash);
    const instructions = tx.message.compiledInstructions;
    expect(instructions).toHaveLength(4);
    expect(Buffer.from(instructions[0].data).readUInt32LE(1)).toBe(200_000);
    expect(Buffer.from(instructions[1].data).readBigUInt64LE(1)).toBe(1n);
    expect(Buffer.from(instructions[2].data).readBigUInt64LE(1)).toBe(12345n);
    expect(Buffer.from(instructions[3].data).toString()).toBe('invoice-42');
    tx.sign([payer]);
    const transaction = Buffer.from(tx.serialize()).toString('base64');
    const authorization = await encodeMppCredential(binary, { challenge, transaction });
    const decoded: unknown = JSON.parse(Buffer.from(authorization.slice(8), 'base64url').toString());
    expect(decoded).toEqual({ challenge: challenge.challenge, payload: { type: 'transaction', transaction } });
  });

  it('supports absent externalId without inventing a memo', async () => {
    const raw = header({ request: { externalId: undefined } });
    const challenge = await parseMppChallenge(binary, raw);
    const prepared = await prepareMppCharge(binary, { challenge, payer: payer.publicKey.toBase58(), hostValidatedLifetime });
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
    expect(tx.message.compiledInstructions).toHaveLength(3);
  });

  it.each([
    { suffix: ', header="Payment-Authorization"' }, { suffix: ', digest="sha-256=:abc=:"' },
    { suffix: ', id="second"' }, { method: 'tempo' }, { intent: 'session' },
    { details: { feePayer: true } }, { details: { splits: [] } },
    { details: { confidential: true } }, { details: { channelCharge: {} } },
    { details: { tokenProgram: '11111111111111111111111111111111' } },
    { details: { network: 'mainnet' } }, { details: { transactionVersions: [1] } },
    { request: { amount: '01' } }, { request: { amount: '18446744073709551616' } },
    { request: { amount: '0' } }, { request: { extension: true } },
    { expires: '2000-01-01T00:00:00Z' }, { expires: '2099-01-01T00:00:00Z' },
  ])('refuses unsupported or hostile challenge %j', async options => {
    await expect(parseMppChallenge(binary, header(options))).rejects.toThrow();
  });

  it('rejects malformed UTF-8-boundary scheme input without a panic', async () => {
    await expect(parseMppChallenge(binary, '付款付款付款')).rejects.toThrow('MPP_INVALID_CHALLENGE');
  });

  it('uses the exact host RPC lifetime for an advisory merchant hash without changing the challenge echo', async () => {
    const challenge = await parseMppChallenge(binary, header({ details: { recentBlockhash: recipient } }));
    const original = structuredClone(challenge.challenge);
    const prepared = await prepareMppCharge(binary, { challenge, payer: payer.publicKey.toBase58(), hostValidatedLifetime });
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, 'base64'));
    expect(tx.message.recentBlockhash).toBe(hostValidatedLifetime.recentBlockhash);
    expect(prepared.lastValidBlockHeight).toBe(hostValidatedLifetime.lastValidBlockHeight);
    tx.sign([payer]);
    const credential = await encodeMppCredential(binary, { challenge, transaction: Buffer.from(tx.serialize()).toString('base64') });
    expect(JSON.parse(Buffer.from(credential.slice(8), 'base64url').toString()).challenge).toEqual(original);
  });

  it('decodes a merchant receipt as an observation and rejects foreign receipts', async () => {
    const receipt = { method: 'solana', status: 'success', timestamp: new Date().toISOString(), reference: 'unverified-reference' };
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(await parseMppReceipt(binary, encode(receipt))).toEqual(receipt);
    await expect(parseMppReceipt(binary, encode({ ...receipt, method: 'tempo' }))).rejects.toThrow('MPP_INVALID_RECEIPT');
    await expect(parseMppReceipt(binary, 'not-a-receipt')).rejects.toThrow('MPP_INVALID_RECEIPT');
  });
});
