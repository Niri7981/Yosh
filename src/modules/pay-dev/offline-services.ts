import { PAY_DEVELOPMENT_PROFILE } from './profile';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getBase58Decoder } from '@solana/kit';
import { Keypair, PublicKey } from '@solana/web3.js';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { PaymentPayloadV2Schema } from '@x402/core/schemas';
import type { PaymentRequired } from '@x402/core/types';
import { z } from 'zod';
import { createSignedPaymentIdentity, decodeOriginalTransaction, verifyOriginalTransactionSignatures, assertUnsignedPaymentBindings } from '../payment/original-payment-evidence';
import { DEVNET_GENESIS, DEVNET_NETWORK, DEVNET_USDC_MINT, TOKEN_PROGRAM, loadPaymentConfig } from '../payment/payment-config';
import { paidResource, parsePaidResourceDelivery, type PaidResourceId } from '../resources/paid-resources';
import { demoTokenRiskReport } from '../resources/token-risk-report';
import { SolanaPublicKeySchema } from '../resources/http-resource';

const StateSchema = z.object({ format: z.literal('yosh-pay-offline-v1'), buyer: SolanaPublicKeySchema,
  merchant: SolanaPublicKeySchema, sponsor: z.array(z.number().int().min(0).max(255)).length(64),
  merchantPort: z.number().int().min(0).max(65535), rpcPort: z.number().int().min(0).max(65535), publicOrigin: z.string().optional(),
  blockhashes: z.array(SolanaPublicKeySchema).max(10000), transactions: z.array(z.object({
    signature: z.string().max(88), memo: z.string().max(256), wire: z.string().max(1644),
    amount: z.string().regex(/^\d+$/), delivery: z.record(z.string(), z.unknown()),
  }).strict()).max(10000),
}).strict();
const RpcSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]), method: z.string(), params: z.array(z.unknown()).optional() });
type OfflineState = z.infer<typeof StateSchema>;
const INITIAL_USDC = 10_000_000n;
const owners = new Set<string>();

function privatePath(path: string, directory: boolean) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || (info.mode & 0o777) !== (directory ? 0o700 : 0o600) || info.uid !== process.getuid?.()) {
    throw new Error('OFFLINE_SERVICES_PRIVATE_STORAGE_REQUIRED');
  }
  if (!directory && info.size > 16 * 1024 * 1024) throw new Error('OFFLINE_SERVICES_STATE_TOO_LARGE');
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 131072) throw new Error('OFFLINE_SERVICES_REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const info = server.address();
      if (!info || typeof info === 'string') { reject(new Error('OFFLINE_SERVICES_PORT_MISSING')); return; }
      resolve(info.port);
    });
  });
}
async function stop(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}

/** Loopback-only merchant and chain simulator. Its durable file records chain and
 * fulfillment observations, never authorization, budgets, reservations or Ledger state.
 * It has no outbound transport and never receives the buyer's secret key. */
export async function startOfflineServices(options: { directory: string; buyer: string; merchantPort?: number; rpcPort?: number; publicOrigin?: string }) {
  privatePath(options.directory, true);
  const directory = realpathSync(options.directory);
  if (owners.has(directory)) throw new Error('OFFLINE_SERVICES_ALREADY_RUNNING');
  const path = join(directory, 'offline-network.json');
  const buyer = SolanaPublicKeySchema.parse(options.buyer);
  const publicOrigin = options.publicOrigin === undefined ? undefined : new URL(options.publicOrigin);
  if (publicOrigin && (publicOrigin.protocol !== 'http:' || publicOrigin.hostname !== '127.0.0.1' || !publicOrigin.port
    || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash)) throw new Error('OFFLINE_SERVICES_PUBLIC_ORIGIN_REJECTED');
  let state: OfflineState;
  if (lstatSync(path, { throwIfNoEntry: false })) {
    privatePath(path, false); state = StateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (state.publicOrigin !== publicOrigin?.origin) throw new Error('OFFLINE_SERVICES_ORIGIN_CHANGED');
    if (state.buyer !== buyer) throw new Error('OFFLINE_SERVICES_BUYER_CHANGED');
    if ((options.merchantPort !== undefined && options.merchantPort !== 0 && options.merchantPort !== state.merchantPort)
      || (options.rpcPort !== undefined && options.rpcPort !== 0 && options.rpcPort !== state.rpcPort)) throw new Error('OFFLINE_SERVICES_PORT_CHANGED');
  } else state = { format: 'yosh-pay-offline-v1', buyer, merchant: Keypair.generate().publicKey.toBase58(),
    sponsor: [...Keypair.generate().secretKey], merchantPort: options.merchantPort ?? PAY_DEVELOPMENT_PROFILE.merchantPort,
    rpcPort: options.rpcPort ?? PAY_DEVELOPMENT_PROFILE.rpcPort, ...(publicOrigin ? { publicOrigin: publicOrigin.origin } : {}), blockhashes: [], transactions: [] };
  const sponsor = Keypair.fromSecretKey(Uint8Array.from(state.sponsor));
  const config = loadPaymentConfig({ YOSH_EXECUTION_MODE: 'live_devnet', SOLANA_CLUSTER: 'devnet',
    SOLANA_RPC_URL: 'https://rpc.yosh-pay-dev.invalid', DEMO_BUYER_PUBLIC_KEY: buyer, DEMO_MERCHANT_PUBLIC_KEY: state.merchant });
  const save = () => {
    privatePath(directory, true);
    if (lstatSync(path, { throwIfNoEntry: false })) privatePath(path, false);
    const temporary = `${path}.${randomUUID()}.new`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(temporary, path); const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  };
  let origin = '';
  const resources: ReadonlyArray<{ id: PaidResourceId; amount: string }> = [
    { id: 'market-snapshot', amount: '200000' }, { id: 'market-analysis', amount: '20000000' }, { id: 'token-risk-report', amount: '50000' } ];
  const offers = resources.map(resource => ({ ...resource, target: paidResource(resource.id).path,
    offer: { scheme: 'exact', network: DEVNET_NETWORK, asset: DEVNET_USDC_MINT, amount: resource.amount,
      payTo: state.merchant, maxTimeoutSeconds: 300, extra: { decimals: 6, feePayer: sponsor.publicKey.toBase58(),
        memo: `yosh-pay-development-${createHash('sha256').update(state.merchant + resource.id).digest('hex').slice(0, 32)}` },
    } satisfies PaymentRequired['accepts'][number] }));
  const delivery = (id: PaidResourceId) => {
    const common = { asset: 'SOL', as_of: new Date().toISOString(), source_label: 'Offline development simulator · No real funds' };
    return parsePaidResourceDelivery(id, id === 'market-snapshot' ? { ...common, resource_id: 'sol-market-snapshot', spot_price_usd: 150, is_demo_snapshot: true }
      : id === 'market-analysis' ? { ...common, resource_id: 'sol-market-analysis', assessment: 'Offline test analysis; no market data was fetched.',
        indicators: { change_24h_pct: 0, volatility_7d_pct: 0, rsi_14d: 50 }, is_demo_analysis: true }
      : { ...demoTokenRiskReport, generatedAt: common.as_of, summary: 'Offline development simulator; no live asset assessment or real funds.' });
  };
  const balance = () => INITIAL_USDC - state.transactions.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  const tokenAccount = (owner: string) => ({ owner: TOKEN_PROGRAM, data: { parsed: { type: 'account', info: {
    owner, mint: DEVNET_USDC_MINT, state: 'initialized', tokenAmount: { amount: owner === buyer ? balance().toString() : (INITIAL_USDC - balance()).toString(), decimals: 6 },
  } } } });
  const mintAccount = { owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } };
  const ata = (owner: string) => PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), new PublicKey(DEVNET_USDC_MINT).toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0].toBase58();
  const account = (key: unknown) => key === DEVNET_USDC_MINT ? mintAccount : key === ata(buyer) ? tokenAccount(buyer) : key === ata(state.merchant) ? tokenAccount(state.merchant) : null;
  const merchant = createServer(async (request, response) => {
    response.setHeader('connection', 'close'); response.setHeader('cache-control', 'no-store');
    try {
      if (request.headers.host !== `127.0.0.1:${state.merchantPort}` || request.method !== 'GET') throw new Error('REQUEST_REJECTED');
      if (request.url === '/supported') {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: DEVNET_NETWORK, extra: { feePayer: sponsor.publicKey.toBase58() } }], extensions: [], signers: {} })); return;
      }
      const resource = offers.find(item => item.target === request.url);
      if (!resource) { response.writeHead(404); response.end(); return; }
      const { target, offer } = resource;
      const header = request.headers['payment-signature'];
      if (typeof header !== 'string') {
        response.writeHead(402, { 'content-type': 'application/json', 'payment-required': encodePaymentRequiredHeader({ x402Version: 2, resource: { url: `${origin}${target}` }, accepts: [offer] }) });
        response.end(JSON.stringify({ code: 'OFFLINE_PAYMENT_REQUIRED', test_only: true })); return;
      }
      if (header.length > 16384) throw new Error('PAYMENT_TOO_LARGE');
      const payload = PaymentPayloadV2Schema.parse(decodePaymentSignatureHeader(header));
      if (!isDeepStrictEqual(payload.accepted, offer) || payload.resource?.url !== `${origin}${target}`) throw new Error('PAYMENT_CHANGED');
      const identity = createSignedPaymentIdentity({ x402Version: 2, accepted: offer, payload: payload.payload }, config);
      if (!state.blockhashes.includes(identity.recentBlockhash)) throw new Error('UNKNOWN_BLOCKHASH');
      const tx = decodeOriginalTransaction(z.string().parse(payload.payload.transaction)).transaction;
      tx.sign([sponsor]);
      if (!verifyOriginalTransactionSignatures(tx, true)) throw new Error('INVALID_SIGNATURE');
      const signature = getBase58Decoder().decode(tx.signatures[0]);
      let original = state.transactions.find(item => item.signature === signature);
      if (!original) {
        if (state.transactions.length >= 10000 || balance() < BigInt(offer.amount)) throw new Error('OFFLINE_BALANCE_EXHAUSTED');
        original = { signature, memo: identity.actualMemo, wire: Buffer.from(tx.serialize()).toString('base64'), amount: offer.amount,
          delivery: delivery(resource.id) };
        // Persist settlement and fulfillment together before acknowledging HTTP.
        state.transactions.push(original); save();
      }
      response.writeHead(200, { 'content-type': 'application/json', 'payment-response': encodePaymentResponseHeader({ success: true, network: DEVNET_NETWORK, transaction: signature, payer: buyer }) });
      response.end(JSON.stringify(original.delivery));
    } catch { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'OFFLINE_MERCHANT_REJECTED' })); }
  });
  const rpc = createServer(async (request, response) => {
    response.setHeader('connection', 'close'); response.setHeader('cache-control', 'no-store');
    let id: string | number | null = null;
    try {
      if (request.headers.host !== `127.0.0.1:${state.rpcPort}` || request.method !== 'POST' || request.url !== '/') throw new Error('REQUEST_REJECTED');
      const input = RpcSchema.parse(JSON.parse(await body(request))); id = input.id;
      const params = input.params ?? []; let result: unknown;
      switch (input.method) {
        case 'getGenesisHash': result = DEVNET_GENESIS; break;
        case 'getLatestBlockhash': {
          if (state.blockhashes.length >= 10000) throw new Error('OFFLINE_BLOCKHASH_LIMIT');
          const blockhash = Keypair.generate().publicKey.toBase58(); state.blockhashes.push(blockhash); save();
          result = { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 1000 } }; break;
        }
        case 'isBlockhashValid': result = { context: { slot: 1 }, value: typeof params[0] === 'string' && state.blockhashes.includes(params[0]) }; break;
        case 'getBlockHeight': result = 1; break;
        case 'getBalance': result = { context: { slot: 1 }, value: params[0] === sponsor.publicKey.toBase58() ? 1000000000 : params[0] === buyer ? 100000000 : 0 }; break;
        case 'getTokenAccountBalance': result = { context: { slot: 1 }, value: { amount: params[0] === ata(buyer) ? balance().toString() : (INITIAL_USDC - balance()).toString(), decimals: 6, uiAmount: null } }; break;
        case 'getAccountInfo': {
          const encoding = z.object({ encoding: z.string().optional() }).passthrough().safeParse(params[1]);
          if (params[0] === DEVNET_USDC_MINT && encoding.success && encoding.data.encoding === 'base64') {
            const bytes = Buffer.alloc(82); bytes[44] = 6; bytes[45] = 1;
            result = { context: { slot: 1 }, value: { owner: TOKEN_PROGRAM, data: [bytes.toString('base64'), 'base64'], lamports: 1000000, executable: false, rentEpoch: 0, space: 82 } };
          } else result = { context: { slot: 1 }, value: account(params[0]) }; break;
        }
        case 'getMultipleAccounts': result = { context: { slot: 1 }, value: z.array(z.string()).max(16).parse(params[0]).map(account) }; break;
        case 'simulateTransaction': {
          const wire = z.string().parse(params[0]); const transaction = decodeOriginalTransaction(wire).transaction;
          const compatible = offers.some(item => { try { assertUnsignedPaymentBindings(wire, config, item.offer); return true; } catch { return false; } });
          if (!compatible) throw new Error('INVALID_SIMULATION');
          if (!state.blockhashes.includes(transaction.message.recentBlockhash) || !verifyOriginalTransactionSignatures(transaction)) throw new Error('INVALID_SIMULATION');
          result = { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 100 } }; break;
        }
        case 'getSignaturesForAddress': {
          const page = z.object({ before: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }).passthrough().parse(params[1] ?? {});
          const history = [...state.transactions].reverse(); const offset = page.before ? history.findIndex(item => item.signature === page.before) + 1 : 0;
          result = params[0] !== buyer ? [] : history.slice(offset, offset + (page.limit ?? 100)).map(item => ({ signature: item.signature, memo: `[${item.memo.length}] ${item.memo}`, slot: 1, err: null, blockTime: 1, confirmationStatus: 'confirmed' })); break;
        }
        case 'getTransaction': { const original = state.transactions.find(item => item.signature === params[0]); result = original ? { transaction: [original.wire, 'base64'], meta: { err: null } } : null; break; }
        default: throw new Error('OFFLINE_RPC_METHOD_REJECTED');
      }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32600, message: 'OFFLINE_RPC_REJECTED' } })); }
  });
  merchant.requestTimeout = rpc.requestTimeout = 15000;
  merchant.headersTimeout = rpc.headersTimeout = 10000;
  owners.add(directory);
  try {
    state.merchantPort = await listen(merchant, state.merchantPort); origin = publicOrigin?.origin ?? `http://127.0.0.1:${state.merchantPort}`;
    state.rpcPort = await listen(rpc, state.rpcPort); save();
  } catch (error) { await Promise.all([stop(merchant), stop(rpc)]); owners.delete(directory); throw error; }
  let closed = false;
  return { origin, merchantOrigin: `http://127.0.0.1:${state.merchantPort}`, rpcUrl: `http://127.0.0.1:${state.rpcPort}`, merchant: state.merchant, sponsor: sponsor.publicKey.toBase58(),
    async close() { if (closed) return; closed = true; await Promise.all([stop(merchant), stop(rpc)]); owners.delete(directory); } };
}
