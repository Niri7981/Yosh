import { z } from 'zod';
async function main() {
    const input = z.object({ module: z.string(), database: z.string(), operation: z.enum(['create', 'open', 'recover', 'hold']),
        member: z.string().optional(), request: z.string().optional() }).strict().parse(JSON.parse(process.argv[2]));
    // This imports the exact preserved old implementation, including its own migrations
    // and recovery. No reimplementation of the old writer or raw-SQL substitute.
    const legacyModule: unknown = await import(input.module);
    const schema = z.object({ PurchaseLedger: z.custom<new (path: string, options: {
            managed: boolean;
            mode: 'live_devnet';
        }) => {
            close(): void;
            setDailyLimit(value: string, mode: 'live_devnet'): unknown;
            recoverUnsubmittedOnStartup(): void;
        }>(value => typeof value === 'function') });
    let ledger: InstanceType<z.infer<typeof schema>['PurchaseLedger']> | undefined;
    try {
        ledger = new (schema.parse(legacyModule).PurchaseLedger)(input.database, { managed: true, mode: 'live_devnet' });
        if (input.operation === 'recover')
            ledger.recoverUnsubmittedOnStartup();
        else if (input.operation === 'open')
            ledger.setDailyLimit('1', 'live_devnet');
        if (input.operation === 'hold') {
            process.stdout.write('READY\n');
            process.stdin.once('data', () => {
                try {
                    ledger!.setDailyLimit('1', 'live_devnet');
                    process.stdout.write('WRITE_ALLOWED\n');
                }
                catch {
                    process.stdout.write('WRITE_BLOCKED\n');
                }
                finally {
                    ledger!.close();
                }
            });
        }
        else {
            ledger.close();
            process.stdout.write('ALLOWED\n');
        }
    }
    catch (error) {
        // Only a stable bounded category leaves the subprocess. No records or payloads.
        const message = error instanceof Error ? error.message : '';
        if (message.includes('DATA_DIRECTORY_IN_USE')) {
            process.stdout.write('NEW_WRITER_IN_USE\n'); process.exitCode = 27; return;
        }
        process.stdout.write(message.includes('yosh_execution_') || message.includes('EXECUTION_WRITER_FENCED') ? 'OLD_WRITER_BLOCKED\n' : 'OLD_WRITER_OTHER_ERROR\n');
        process.exitCode = message.includes('yosh_execution_') || message.includes('EXECUTION_WRITER_FENCED') ? 23 : 24;
    }
}
main().catch(() => { process.stdout.write('WORKER_FAILED\n'); process.exitCode = 25; });
