import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage,
  VersionedTransaction } from '@solana/web3.js';
import { createMppSignedPaymentIdentity } from '../../src/modules/payment/mpp-payment-evidence';
import { MppChargeQuoteSchema, MppStoredPaymentSchema, type MppChargeQuote } from '../../src/modules/payment/mpp-contract';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { TOKEN_PROGRAM } from '../../src/modules/payment/payment-environment';

export function mppCredential(quote: MppChargeQuote, transaction: string) {
  return 'Payment ' + Buffer.from(JSON.stringify({ challenge: quote.challenge,
    payload: { type: 'transaction', transaction } })).toString('base64url');
}

/** Generated test keys only; this helper never opens a wallet or contacts RPC. */
export function mppFixture(options: { memo?: string; buyer?: Keypair; merchant?: Keypair; amount?: string } = {}) {
  const buyer = options.buyer ?? Keypair.generate();
  const merchant = options.merchant ?? Keypair.generate();
  const config = loadPaymentConfig({ DEMO_BUYER_PUBLIC_KEY: buyer.publicKey.toBase58(), DEMO_MERCHANT_PUBLIC_KEY: merchant.publicKey.toBase58() });
  const amount = options.amount ?? '10000';
  const request = { amount, currency: config.mint, recipient: config.merchant,
    ...(options.memo ? { externalId: options.memo } : {}),
    methodDetails: { network: 'devnet', decimals: 6, tokenProgram: TOKEN_PROGRAM } };
  const challenge = { id: 'mpp-test', realm: 'merchant.example', method: 'solana', intent: 'charge',
    request: Buffer.from(JSON.stringify(request)).toString('base64url'), expires: '2099-01-01T00:00:00Z' };
  const quote = MppChargeQuoteSchema.parse({ protocol: 'mpp', method: 'solana', intent: 'charge', scheme: 'mpp_charge',
    network: config.network, asset: config.mint, payTo: config.merchant, amount, challenge,
    challengeHeader: 'Payment ' + Object.entries(challenge).map(([key, value]) => `${key}="${value}"`).join(', '),
    expiresAt: Date.parse(challenge.expires) });
  const ata = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(),
    new PublicKey(TOKEN_PROGRAM).toBuffer(), new PublicKey(config.mint).toBuffer()],
  new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0];
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(BigInt(amount), 1); data[9] = 6;
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1n }),
    new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), data, keys: [
      { pubkey: ata(buyer.publicKey), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(config.mint), isSigner: false, isWritable: false },
      { pubkey: ata(merchant.publicKey), isSigner: false, isWritable: true },
      { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
    ] }),
    ...(options.memo ? [new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
      keys: [], data: Buffer.from(options.memo) })] : []),
  ];
  const lifetime = { recentBlockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: '2000000' };
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: buyer.publicKey,
    recentBlockhash: lifetime.recentBlockhash, instructions }).compileToV0Message());
  const unsignedWire = Buffer.from(transaction.serialize()).toString('base64');
  transaction.sign([buyer]);
  const wire = Buffer.from(transaction.serialize()).toString('base64');
  const payment = MppStoredPaymentSchema.parse({ protocol: 'mpp', quote, credential: mppCredential(quote, wire), transaction: wire });
  const identity = createMppSignedPaymentIdentity(payment, config, lifetime);
  return { config, quote, payment, unsignedWire, transaction, instructions, signature: identity.buyerSignature, identity,
    lifetime, buyer, merchant };
}
