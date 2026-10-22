import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { runPayUnsignedPreflight } from '../src/modules/payment/pay-unsigned-preflight';
import { resolvePaymentEnvironment } from '../src/modules/payment/payment-environment';
import { X402ResourceSchema, SolanaPublicKeySchema } from '../src/modules/resources/http-resource';

// Public policy input only. No connection credentials, runtime, Ledger or wallet store.
async function main() {
  const args = process.argv.slice(2);
  const fields: Record<string, string> = {};
  if (args.shift() !== '--live-read-only' || args.length !== 10) throw new Error('PAY_PREFLIGHT_READ_ONLY_ARGUMENTS_REQUIRED');
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--wallet', '--rpc-url', '--resource-file', '--pay-binary', '--output'].includes(key) || !value || Object.hasOwn(fields, key))
      throw new Error('PAY_PREFLIGHT_READ_ONLY_ARGUMENTS_REQUIRED');
    fields[key] = value;
  }
  const wallet = SolanaPublicKeySchema.parse(fields['--wallet']);
  const rpc = z.url().parse(fields['--rpc-url']);
  const endpoint = new URL(rpc);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search)
    throw new Error('PAY_PREFLIGHT_RPC_INVALID');
  const policy = readFileSync(resolve(fields['--resource-file']), 'utf8');
  if (Buffer.byteLength(policy) > 16_384) throw new Error('PAY_PREFLIGHT_POLICY_TOO_LARGE');
  const resource = X402ResourceSchema.parse(JSON.parse(policy));
  const result = await runPayUnsignedPreflight({ wallet, resource,
    environment: resolvePaymentEnvironment({ YOSH_EXECUTION_MODE: 'live_mainnet', SOLANA_MAINNET_RPC_URL: rpc }), binary: resolve(fields['--pay-binary']) });
  // Never overwrite an operator receipt or runtime configuration by accident.
  writeFileSync(resolve(fields['--output']), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ unsignedValidated: result.unsignedValidated, feeLamports: result.feeLamports,
    buyerFeeLamports: result.buyerFeeLamports, accountCreationLamports: result.accountCreationLamports, signerUsed: false, paymentSent: false }) + '\n');
}
void main().catch(() => { process.stderr.write('PAY_UNSIGNED_PREFLIGHT_BLOCKED. No signature or payment requested.\n'); process.exitCode = 1; });
