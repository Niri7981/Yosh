/** Disposable host-acceptance facility. Never packaged or used by a product runtime.
 * Merchant/RPC replies and wallet inventory are fixtures; the installed SDK,
 * product HTTP/auth/runtime/ledger, transaction validation and signing run normally.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve, basename } from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { getBase58Decoder } from '@solana/kit';
import { z } from 'zod';
import { AppRuntime } from '../src/modules/app/app-runtime';
import { serveDevelopmentRuntime } from '../src/modules/pay-dev/management-server';
import { PAY_DEVELOPMENT_PROFILE } from '../src/modules/pay-dev/profile';
import { resolvePaymentEnvironment } from '../src/modules/payment/payment-environment';
import { TOKEN_PROGRAM } from '../src/modules/payment/payment-config';
import { prepareSignedMppCharge } from '../src/modules/payment/mpp-charge-execution';
import { PAID_RESOURCE_PURCHASE_OPERATION } from '../src/modules/authority/spend-grant';
import { readConnection } from '../src/modules/mcp/connection';

async function main() {
  if (process.env.NODE_ENV !== 'test' || process.argv.length !== 4) throw new Error('ISOLATED_ACCEPTANCE_ONLY');
  const parent = realpathSync(resolve(process.argv[2]));
  const binary = realpathSync(resolve(process.argv[3]));
  if (!parent.includes('/build.noindex/mpp-plugin-acceptance-') || basename(binary) !== 'mpp-protocol-engine')
    throw new Error('ACCEPTANCE_PATH_REQUIRED');
  const root = join(parent, PAY_DEVELOPMENT_PROFILE.directoryName), directory = join(root, 'Devnet');
  if (existsSync(root)) throw new Error('FRESH_ACCEPTANCE_STATE_REQUIRED');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  for (const key of Object.keys(process.env)) if (/^(YOSH_|APP2049_|SOLANA_|DEMO_)/.test(key) || key === 'USDC_MINT') delete process.env[key];
  const buyer = Keypair.generate(), merchant = Keypair.generate(), recentBlockhash = Keypair.generate().publicKey.toBase58();
  // This generated fixture key never leaves the isolated sandbox or enters Git.
  const keyFile = join(parent, 'generated-test-key.json');
  writeFileSync(keyFile, JSON.stringify([...buyer.secretKey]), { mode: 0o600, flag: 'wx' });
  writeFileSync(join(root, 'development-environment.json'), JSON.stringify({ version: 1, environment: 'devnet',
    mainnetRiskAccepted: false, rpcUrl: 'https://solana-rpc.publicnode.com' }), { mode: 0o600 });
  const origin = `http://127.0.0.1:${PAY_DEVELOPMENT_PROFILE.backendPort}`;
  Object.assign(process.env, { YOSH_PAY_DEV: '1', YOSH_PAY_DEV_ENV: 'devnet', YOSH_PAY_MCP_DEVNET: '1',
    YOSH_EXECUTION_MODE: 'live_devnet', YOSH_ENABLE_DEVNET_PURCHASES: '1', YOSH_ENABLE_MAINNET_EXECUTION: '0',
    YOSH_DATA_DIR: directory, YOSH_PORT: String(PAY_DEVELOPMENT_PROFILE.backendPort),
    SOLANA_RPC_URL: 'https://api.devnet.solana.com', YOSH_MANAGEMENT_TOKEN: randomBytes(32).toString('hex') });
  const environment = resolvePaymentEnvironment();
  const resources = ['redelivery', 'success', 'ungranted', 'low-fee', 'timeout'].map(name => ({
    resourceId: `mpp-host-${name}`, providerId: 'mock-host-acceptance', paymentProtocol: 'mpp_solana_charge',
    network: environment.network, mint: environment.asset.mint, decimals: 6, recipient: merchant.publicKey.toBase58(), amount: '1000',
    request: { method: 'GET', url: `https://merchant.mpp-acceptance.invalid/${name}`, access: 'https', headers: {} },
  }));
  process.env.YOSH_MAINNET_RESOURCES = JSON.stringify(resources);
  const transactions = new Map<string, { wire: string; known: boolean; credential: string }>();
  const counts = { quotes: 0, signingPreparations: 0, submissions: 0, originalCredentialRetries: 0, rpc: 0, forbiddenNetwork: 0 };
  const evidence = () => {
    const purchases = application.ledger.listForAdministration().map(record => ({ id: record.purchaseId, status: record.status,
      deliveryStatus: record.deliveryStatus, transaction: record.transaction ?? null })) ?? [];
    writeFileSync(join(parent, 'fixture-evidence.json'), JSON.stringify({ kind: 'isolated-mpp-host-fixture', realFunds: false,
      pid: process.pid, origin, binary, counts, purchases }, null, 2), { mode: 0o600 });
  };
  const token = (owner: string) => ({ owner: TOKEN_PROGRAM, data: { parsed: { type: 'account', info: {
    owner, mint: environment.asset.mint, state: 'initialized', tokenAmount: { amount: '10000000', decimals: 6 },
  } } } });
  const rpc: typeof fetch = async (url, init) => {
    if (new URL(url instanceof Request ? url.url : String(url)).href !== new URL(environment.rpcUrl).href) {
      counts.forbiddenNetwork++; throw new Error('FIXTURE_NETWORK_DENIED');
    }
    counts.rpc++;
    const request = z.object({ id: z.union([z.string(), z.number()]), method: z.string(), params: z.array(z.unknown()).optional() })
      .parse(JSON.parse(String(init?.body)));
    const confirmed = transactions.get(String(request.params?.[0]));
    const results: Record<string, unknown> = {
      getGenesisHash: environment.genesisHash, getLatestBlockhash: { value: { blockhash: recentBlockhash, lastValidBlockHeight: 2000000 } },
      getMultipleAccounts: { value: [{ owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } },
        token(buyer.publicKey.toBase58()), token(merchant.publicKey.toBase58())] },
      isBlockhashValid: { value: true }, getFeeForMessage: { value: 5001 }, getBalance: { value: 100000000 },
      simulateTransaction: { value: { err: null } }, getSignaturesForAddress: [], getTokenAccountsByOwner: { value: [] },
      getAccountInfo: { value: token(buyer.publicKey.toBase58()) },
      getTransaction: confirmed?.known ? { transaction: [confirmed.wire, 'base64'], meta: { err: null } } : null,
    };
    if (!(request.method in results)) throw new Error('FIXTURE_RPC_METHOD_REJECTED');
    return Response.json({ jsonrpc: '2.0', id: request.id, result: results[request.method] });
  };
  globalThis.fetch = rpc;
  const challenges = new Map<string, object>();
  const merchantFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://merchant.mpp-acceptance.invalid') { counts.forbiddenNetwork++; throw new Error('FIXTURE_MERCHANT_DENIED'); }
    const authorization = new Headers(init?.headers).get('authorization');
    if (!authorization) {
      counts.quotes++;
      const challenge = { id: `host-${counts.quotes}`, realm: url.host, method: 'solana', intent: 'charge',
        request: Buffer.from(JSON.stringify({ amount: '1000', currency: environment.asset.mint,
          recipient: merchant.publicKey.toBase58(), externalId: `host-${url.pathname}-${counts.quotes}`,
          methodDetails: { network: 'devnet', decimals: 6, tokenProgram: TOKEN_PROGRAM } })).toString('base64url'),
        expires: new Date(Date.now() + 300000).toISOString() };
      challenges.set(challenge.id, challenge);
      return new Response(null, { status: 402, headers: { 'www-authenticate': 'Payment ' + Object.entries(challenge)
        .map(([key, value]) => `${key}="${value}"`).join(', ') } });
    }
    const credential = z.object({ challenge: z.object({ id: z.string() }).passthrough(), payload: z.object({ type: z.literal('transaction'), transaction: z.string() }) })
      .parse(JSON.parse(Buffer.from(authorization.slice(8), 'base64url').toString()));
    if (!authorization.startsWith('Payment ') || !isDeepStrictEqual(credential.challenge, challenges.get(credential.challenge.id)))
      throw new Error('FIXTURE_CHALLENGE_CHANGED');
    const wire = credential.payload.transaction;
    const transaction = VersionedTransaction.deserialize(Buffer.from(wire, 'base64'));
    const signature = getBase58Decoder().decode(transaction.signatures[0]);
    const existing = transactions.get(signature);
    if (existing) {
      if (url.pathname !== '/redelivery' || existing.credential !== authorization || wire !== existing.wire)
        throw new Error('FIXTURE_DUPLICATE_SUBMISSION');
      counts.originalCredentialRetries++;
      evidence();
      const receipt = Buffer.from(JSON.stringify({ method: 'solana', status: 'success', timestamp: new Date().toISOString(),
        reference: signature })).toString('base64url');
      return Response.json({ fixture: true, symbol: 'SOL/USD', price: '123.45' }, { headers: { 'payment-receipt': receipt } });
    }
    transactions.set(signature, { wire, known: url.pathname !== '/timeout', credential: authorization });
    counts.submissions++; evidence();
    if (url.pathname === '/redelivery') throw new Error('MOCK_RESPONSE_LOST_AFTER_SETTLEMENT');
    if (url.pathname === '/timeout') throw new Error('MOCK_SUBMISSION_TIMEOUT');
    const receipt = Buffer.from(JSON.stringify({ method: 'solana', status: 'success', timestamp: new Date().toISOString(), reference: signature })).toString('base64url');
    return Response.json({ fixture: true, message: 'MPP installed-plugin host acceptance', transaction: signature }, { headers: { 'payment-receipt': receipt } });
  };
  const application = new AppRuntime(directory, {
    initializeWallet: async () => ({ address: buyer.publicKey.toBase58(), reused: true }),
    readWallets: async () => [{ id: 'devnet', label: 'Generated acceptance fixture', address: buyer.publicKey.toBase58(), status: 'available' }],
    fetcher: merchantFetch,
    mpp: { binary, fetcher: merchantFetch, prepare: async (config, record, beforeSign, fee) => {
      if (!record.intent.mpp) throw new Error('MPP_EXPECTED');
      counts.signingPreparations++;
      // The product initializes identity above. For this fixture only, consume
      // the generated test key through the existing dedicated Devnet signer path.
      const previous = process.env.YOSH_USE_PRODUCT_WALLET;
      process.env.YOSH_USE_PRODUCT_WALLET = '0';
      process.env.DEMO_BUYER_KEYPAIR = keyFile;
      try { return await prepareSignedMppCharge(binary, config, record.intent.mpp, beforeSign, fee); }
      finally {
        delete process.env.DEMO_BUYER_KEYPAIR;
        if (previous === undefined) delete process.env.YOSH_USE_PRODUCT_WALLET;
        else process.env.YOSH_USE_PRODUCT_WALLET = previous;
        evidence();
      }
    } },
  });
  const globals = globalThis as typeof globalThis & { __yosh?: { runtime?: AppRuntime } };
  globals.__yosh = { runtime: application };
  await application.initializeWallet(); application.setAgentConnection(true, origin);
  const descriptor = { version: 1, profile: 'pay-mcp-devnet', origin, memberId: application.ledger.defaultCardMember().id };
  writeFileSync(join(directory, 'pay-devnet-runtime.json'), JSON.stringify(descriptor), { mode: 0o600 });
  const principal = application.authenticateAgent(new Request(`${origin}/api/agent/mpp/purchases`, {
    headers: { authorization: `Bearer ${readConnection(directory).token}` },
  }), 'request_purchase');
  application.ledger.setDailyLimit('1000000', 'live_devnet'); application.ledger.setPaused(false, 'live_devnet');
  for (const resource of resources.filter(value => value.resourceId !== 'mpp-host-ungranted')) {
    application.ledger.createSpendGrant({ totalLimit: '100000', singleLimit: '1000', expiresAt: Date.now() + 3600000 }, principal,
      { resourceId: resource.resourceId, providerId: resource.providerId, operation: PAID_RESOURCE_PURCHASE_OPERATION,
        network: resource.network, assetId: resource.mint, assetDecimals: 6, payTo: resource.recipient,
        paymentScheme: 'mpp_charge', maximumNetworkFeeLamports: resource.resourceId === 'mpp-host-low-fee' ? '5000' : '10001' },
      Date.now(), 'live_devnet');
  }
  const backend = await serveDevelopmentRuntime({ app: application, origin, port: PAY_DEVELOPMENT_PROFILE.backendPort,
    descriptor, cleanup: async () => {} });
  const interval = setInterval(evidence, 1000); evidence();
  let closing = false;
  const close = async () => { if (closing) return; closing = true; clearInterval(interval); evidence(); await backend.close(); };
  process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
  console.log(JSON.stringify({ ready: true, realFunds: false, pid: process.pid, root, origin, resourceIds: resources.map(value => value.resourceId) }));
}
void main().catch(error => { console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'FIXTURE_START_FAILED'); process.exitCode = 1; });
