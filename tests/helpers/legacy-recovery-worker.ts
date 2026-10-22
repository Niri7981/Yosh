import { readFileSync } from 'node:fs';
import { z } from 'zod';
/** Exact pre-owner source, not a rewritten legacy runner. The only injected
 * values are public fixture configuration and one private offline-test payload. */
type LegacyRecord = {
    approvalId: string;
    status: string;
    intent: {
        idempotencyKey: string;
    };
};
type LegacyLedger = {
    reserve(intent: unknown, quote: unknown, now: undefined, mode: 'live_devnet'): LegacyRecord;
    claim(id: string, now: undefined, validate: undefined, mode: 'live_devnet'): unknown;
    savePayload(id: string, payload: unknown): void;
    unknown(id: string): void;
    close(): void;
};
const LedgerModule = z.object({ PurchaseLedger: z.custom<new (path: string, options: {
        mode: 'live_devnet';
    }) => LegacyLedger>(value => typeof value === 'function') });
const RecoveryModule = z.object({ recoverApprovedPayment: z.custom<(ledger: LegacyLedger, id: string, config: unknown, endpoint: string) => Promise<unknown>>(value => typeof value === 'function') });
let stage = 'input';
async function main() {
    const input = z.object({ source: z.string(), database: z.string(), fixture: z.string() }).parse(JSON.parse(process.argv[2]));
    const fixture = z.object({ config: z.unknown(), quote: z.unknown(), payload: z.unknown(), intent: z.unknown(), endpoint: z.string() }).parse(JSON.parse(readFileSync(input.fixture, 'utf8')));
    stage = 'imports';
    const oldLedger: unknown = await import(`${input.source}/src/modules/purchases/purchase-ledger.ts`);
    const { PurchaseLedger } = LedgerModule.parse(oldLedger);
    const oldRecovery: unknown = await import(`${input.source}/src/modules/purchases/approved-payment.ts`);
    const { recoverApprovedPayment } = RecoveryModule.parse(oldRecovery);
    stage = 'ledger';
    const ledger = new PurchaseLedger(input.database, { mode: 'live_devnet' });
    stage = 'reserve';
    const record = ledger.reserve(fixture.intent, fixture.quote, undefined, 'live_devnet');
    stage = `claim-${record.status}`;
    ledger.claim(record.approvalId, undefined, undefined, 'live_devnet');
    stage = 'save';
    ledger.savePayload(record.approvalId, fixture.payload);
    stage = 'unknown';
    ledger.unknown(record.approvalId);
    process.stdout.write('READY_WITH_LEGACY_UNKNOWN\n');
    process.stdin.once('data', async () => {
        await recoverApprovedPayment(ledger, record.intent.idempotencyKey, fixture.config, fixture.endpoint);
        ledger.close();
        process.stdout.write('LEGACY_RECOVERY_RETURNED\n');
    });
}
main().catch(() => { process.stdout.write(`LEGACY_FIXTURE_FAILED:${stage}\n`); process.exitCode = 26; });
