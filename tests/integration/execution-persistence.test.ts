import * as wallet from '../../src/modules/payment/wallet';
import { requestPaidResourcePurchase } from '../../src/modules/purchases/request-paid-resource-purchase';
import { randomUUID } from 'node:crypto';
import { loadPaymentConfig } from '../../src/modules/payment/payment-config';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { PurchaseLedger } from '../../src/modules/purchases/purchase-ledger';
import { hash } from '../../src/modules/purchases/spending-policy';
import { productionPayFixture, deferred, reachBoundary } from '../helpers/pay-production-fixture';
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true }); });
function temporary() { const d = mkdtempSync(join(tmpdir(), 'yosh-execution-migration-')); directories.push(d); return d; }
function worker(database: string, version: 'head' | 'pre_owner' | 'yosh' | 'current', operation: 'create' | 'open' | 'recover' | 'hold') {
    return spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('tests/helpers/execution-compat-worker.ts'),
        JSON.stringify({ database, module: version === 'current' ? resolve('src/modules/purchases/purchase-ledger.ts') : resolve(`../round2-baseline/${version}/src/modules/purchases/purchase-ledger.ts`), operation })], { cwd: tmpdir(), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] });
}
async function old(database: string, version: 'head' | 'pre_owner' | 'yosh' | 'current', operation: 'create' | 'open' | 'recover') {
    const child = worker(database, version, operation);
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
        const [code] = await once(child, 'exit');
        return { code, output };
    }
    finally {
        clearTimeout(timeout);
    }
}
function financialSnapshot(path: string) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        return Object.fromEntries(['purchases', 'original_payments', 'original_payment_signatures', 'spend_grants', 'purchase_delivery']
            .filter(table => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))
            .map(table => [table, hash(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())]));
    }
    finally {
        db.close();
    }
}
it.each(['head', 'pre_owner', 'yosh'] as const)('upgrades a database made by actual %s source and blocks that old writer, including its startup recovery', async (version) => {
    const path = join(temporary(), 'app-ledger.sqlite');
    expect(await old(path, version, 'create')).toEqual({ code: 0, output: 'ALLOWED\n' });
    const current = new PurchaseLedger(path, { managed: true, mode: 'live_devnet' });
    try {
        current.executionSafety.enable(Date.now());
        const before = current.executionSafety.snapshot();
        expect((await old(path, version, 'open'))).toEqual({ code: 23, output: 'OLD_WRITER_BLOCKED\n' });
        expect((await old(path, version, 'recover'))).toEqual({ code: 23, output: 'OLD_WRITER_BLOCKED\n' });
        current.setDailyLimit('5000000', 'live_devnet');
        expect(current.executionSafety.snapshot()).toEqual(before);
    }
    finally {
        current.close();
    }
    // Upgrade / failed downgrade / upgrade: old code cannot undo the new metadata.
    const again = new PurchaseLedger(path, { managed: true, mode: 'live_devnet' });
    try {
        expect(again.executionSafety.snapshot().epoch).toBeGreaterThan(1);
        again.setDailyLimit('4000000', 'live_devnet');
    }
    finally {
        again.close();
    }
}, 30000);
it('an already-open actual old connection cannot write after activation, and another new writer cannot take over', async () => {
    const path = join(temporary(), 'app-ledger.sqlite');
    expect((await old(path, 'yosh', 'create')).code).toBe(0);
    const child = worker(path, 'yosh', 'hold');
    try {
        expect(String((await once(child.stdout, 'data'))[0])).toContain('READY');
        const current = new PurchaseLedger(path, { managed: true, mode: 'live_devnet' });
        try {
            current.executionSafety.enable(Date.now());
            expect(() => new PurchaseLedger(path, { managed: true, mode: 'live_devnet' })).toThrow('DATA_DIRECTORY_IN_USE');
            expect(await old(path, 'current', 'open')).toEqual({code:27,output:'NEW_WRITER_IN_USE\n'});
            const output = once(child.stdout, 'data');
            const exited = once(child, 'exit');
            child.stdin.end('write');
            expect(String((await output)[0])).toContain('WRITE_BLOCKED');
            await exited;
            current.setDailyLimit('1000000', 'live_devnet');
        }
        finally {
            current.close();
        }
    }
    finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await once(child, 'exit');
        }
    }
}, 30000);
it('persists exact caller, operation, attempt, quote binding and monotonic execution phase in the sole Ledger', async () => {
    const f = await productionPayFixture({ payMcp: true });
    try {
        expect((await f.callPay(await f.connectPay(), 'durable-execution')).isError).not.toBe(true);
        const record = f.payRecord('durable-execution')!;
        expect(f.app.ledger.executionSafety.provenance(record.intent.id)).toMatchObject({ origin: 'external_pay', caller_id: f.memberId,
            operation_id: 'durable-execution', quote_hash: record.intent.quoteFingerprint, record_binding: record.intent.executionBinding, phase: 'SUBMISSION_ATTEMPTED' });
        const permit = f.app.ledger.executionSafety.permit(record);
        expect(permit.factsHash).toBe(hash(f.lastFacts));
        const original = f.app.ledger.savedOriginalPayment(record.approvalId)!;
        await f.reopenWithoutPayExecutor();
        expect(() => f.app.ledger.executionSafety.assert(f.payRecord('durable-execution')!, permit)).toThrow('EXTERNAL_EXECUTION_FENCED');
        expect(f.app.ledger.savedOriginalPayment(record.approvalId)?.evidence).toEqual(original.evidence);
        expect((await f.callPay(await f.connectPay(), 'durable-execution')).isError).not.toBe(true);
        expect(f.signatureCalls).toBe(1);
        expect(f.paidRequests).toBe(1);
    }
    finally {
        await f.close();
    }
}, 30000);
it('Pause Resume and process reopen permanently invalidate an authorized external permit; a JS claim cannot use it', async () => {
    const entered = deferred();
    const release = deferred();
    const f = await productionPayFixture({ payMcp: true });
    const original = f.authority.plan.bind(f.authority);
    vi.spyOn(f.authority, 'plan').mockImplementationOnce((...args) => { entered.resolve(); return original(...args); });
    try {
        // Intercept at the real execution boundary after unsigned construction.
        const execute = f.authority.execute.bind(f.authority);
        vi.spyOn(f.authority, 'execute').mockImplementationOnce(async (...args) => { await release.promise; return execute(...args); });
        const pending = f.callPay(await f.connectPay(), 'durable-stale');
        await reachBoundary(entered, pending);
        const record = f.payRecord('durable-stale')!;
        const permit = f.app.ledger.executionSafety.permit(record);
        expect(() => f.app.ledger.claim(record.approvalId)).toThrow('EXTERNAL_EXECUTION_FENCED');
        f.app.setPaused(true);
        f.app.setPaused(false);
        release.resolve();
        expect((await pending).isError).toBe(true);
        expect(() => f.app.ledger.executionSafety.assert(record, permit)).toThrow('EXTERNAL_EXECUTION_FENCED');
        await f.reopenWithoutPayExecutor();
        expect(() => f.app.ledger.claim(record.approvalId, undefined, undefined, 'live_devnet', permit)).toThrow('EXTERNAL_EXECUTION_FENCED');
        expect(f.signatureCalls).toBe(0);
        expect(f.paidRequests).toBe(0);
    }
    finally {
        release.resolve();
        await f.close();
    }
}, 30000);
it('activation preserves an existing paid record, signed evidence and Unknown byte-for-byte without inventing their origin', async () => {
    const f = await productionPayFixture();
    const signer = vi.spyOn(wallet, 'loadBuyerSigner').mockResolvedValue(f.signer);
    try {
        const client = await f.connect();
        const paid = await requestPaidResourcePurchase({requestId:'historical-paid',resourceId:'market-snapshot',reason:'Historical JS purchase'},
            {config:loadPaymentConfig(),ledger:f.app.ledger,origin:f.origin,principal:f.principal,execute:true});
        expect(paid.status).toBe('PAID');
        const mark = f.app.ledger.markSubmissionAttempt.bind(f.app.ledger);
        vi.spyOn(f.app.ledger, 'markSubmissionAttempt').mockImplementationOnce((...args) => { mark(...args); throw new Error('AFTER_MARKER'); });
        await f.purchase(client, 'historical-unknown');
        const unknown = f.record('historical-unknown')!;
        expect(unknown.status).toBe('PAYMENT_UNKNOWN');
        const before = financialSnapshot(join(f.directory, 'app-ledger.sqlite'));
        f.app.ledger.executionSafety.enable(Date.now());
        expect(financialSnapshot(join(f.directory, 'app-ledger.sqlite'))).toEqual(before);
        expect(f.app.ledger.executionSafety.provenance(unknown.intent.id)).toBeUndefined();
        expect(f.app.ledger.executionSafety.provenance(f.record('historical-paid')!.intent.id)).toBeUndefined();
        expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ paid: '200000', reserved: '200000' });
    }
    finally {
        signer.mockRestore();
        await f.close();
    }
}, 30000);
it('characterizes the production blocker: a running real pre-owner recovery can send old signed evidence before any guarded write', async () => {
    const f = await productionPayFixture({ quoteAmount: '10000' });
    const directory = temporary();
    const path = join(directory, 'legacy.sqlite');
    let child: ReturnType<typeof spawn> | undefined;
    try {
        // Generate a real buyer-signed offline fixture, but interrupt BEFORE marker
        // and HTTP. Nothing has reached the fake merchant or chain yet.
        vi.spyOn(f.app.ledger, 'markSubmissionAttempt').mockImplementationOnce(() => { throw new Error('BEFORE_MARKER'); });
        await f.purchase(await f.connect(), 'legacy-credential-fixture');
        expect(f.paidRequests).toBe(0);
        const record = f.record('legacy-credential-fixture')!;
        const config = loadPaymentConfig();
        const endpoint = record.intent.httpRequest!.url;
        const legacyBinding = hash([config.cluster, config.network, config.mint, config.buyer, config.merchant, endpoint]);
        const intent = { id: randomUUID(), idempotencyKey: 'actual-legacy-unknown', requestHash: hash('legacy-unknown'), resourceId: 'sol-market-snapshot',
            providerId: 'demo-market-data', amount: Number(record.intent.amount), currency: 'USDC', assetDecimals: 6, assetId: config.mint, network: config.network,
            payTo: config.merchant, paymentScheme: 'exact', quoteFingerprint: hash(record.quote), createdAt: Date.now(), expiresAt: Date.now() + 300000, executionBinding: legacyBinding };
        const fixture = join(directory, 'private-offline-fixture.json');
        writeFileSync(fixture, JSON.stringify({ config, quote: record.quote, payload: f.app.ledger.savedPayload(record.approvalId), intent, endpoint }), { mode: 0o600 });
        child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('tests/helpers/legacy-recovery-worker.ts'),
            JSON.stringify({ source: resolve('../round2-baseline/pre_owner'), database: path, fixture })], { cwd: tmpdir(), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] });
        expect(String((await once(child.stdout!, 'data'))[0])).toContain('READY_WITH_LEGACY_UNKNOWN');
        const current = new PurchaseLedger(path, { mode: 'live_devnet' });
        try {
            current.executionSafety.enable(Date.now());
            current.setPaused(true, 'live_devnet');
            const unknown = current.getLegacy('actual-legacy-unknown')!;
            expect(unknown.status).toBe('PAYMENT_UNKNOWN');
            const before = financialSnapshot(path);
            const complete = once(child.stdout!, 'data');
            const exited = once(child, 'exit');
            child.stdin!.end('recover');
            expect(String((await complete)[0])).toContain('LEGACY_RECOVERY_RETURNED');
            await exited;
            // This is an explicit counterexample, not a production safety PASS.
            expect(f.paidRequests).toBe(1);
            expect(financialSnapshot(path)).toEqual(before);
            writeFileSync(resolve('build.noindex/pay-round2-blocker-observation.json'), JSON.stringify({ productionGate: 'BLOCKED',
                oldSource: 'b54422717610a8bc48e87d3487115038e662be7a', legacyHttpAfterPause: 1, guardedFinancialRowsUnchanged: true,
                originalUnknownRetained: true, realFunds: false }));
            expect(current.getLegacy('actual-legacy-unknown')?.status).toBe('PAYMENT_UNKNOWN');
            expect(current.savedPayload(unknown.approvalId)).toBeDefined();
            expect(current.executionSafety.provenance(unknown.intent.id)).toBeUndefined();
        }
        finally {
            current.close();
        }
    }
    finally {
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await once(child, 'exit');
        }
        await f.close();
    }
}, 30000);
it('current default JS x402 builder and signing still work after activation without an external permit', async () => {
    const f = await productionPayFixture();
    const signer = vi.spyOn(wallet, 'loadBuyerSigner').mockResolvedValue(f.signer);
    try {
        f.app.ledger.executionSafety.enable(Date.now());
        const result = await requestPaidResourcePurchase({ requestId: 'js-after-execution-migration', resourceId: 'market-snapshot', reason: 'Default JS compatibility' }, { config: loadPaymentConfig(), ledger: f.app.ledger, origin: f.origin, principal: f.principal, execute: true });
        expect(result).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
        expect(f.app.ledger.executionSafety.provenance(f.record('js-after-execution-migration')!.intent.id)).toMatchObject({ origin: 'js_x402', phase: 'SUBMISSION_ATTEMPTED' });
        expect(signer).toHaveBeenCalledOnce();
        expect(f.signatureCalls).toBe(1);
        expect(f.paidRequests).toBe(1);
        expect(f.execution.calls.prepare).toBe(0);
    }
    finally {
        signer.mockRestore();
        await f.close();
    }
}, 30000);
it('actual SIGKILL with signed-but-unsubmitted external evidence cannot resurrect its old permit', async () => {
    const f = await productionPayFixture({ payMcp: true });
    try {
        await f.crashAfterSubmissionMarker('durable-signed-crash', 'before');
        await f.reopenWithoutPayExecutor();
        const record = f.payRecord('durable-signed-crash')!;
        expect(record.status).toBe('PAYING');
        const original = f.app.ledger.savedOriginalPayment(record.approvalId)!;
        expect(original.state).toBe('SIGNED_NOT_SUBMITTED');
        const permit = f.app.ledger.executionSafety.permit(record);
        expect(() => f.app.ledger.executionSafety.assert(record, permit)).toThrow('EXTERNAL_EXECUTION_FENCED');
        await f.app.start(f.origin);
        expect(f.payRecord('durable-signed-crash')?.status).toBe('FAILED');
        expect(f.app.ledger.savedOriginalPayment(record.approvalId)).toMatchObject({ state: 'NOT_SUBMITTED', evidence: original.evidence });
        expect((await f.callPay(await f.connectPay(), 'durable-signed-crash')).isError).toBe(true);
        expect(f.paidRequests).toBe(0);
    }
    finally {
        await f.close();
    }
}, 30000);


it('actual SIGKILL after merchant receives HTTP reconciles and delivers only the same original payment after restart', async () => {
  const f = await productionPayFixture({ payMcp: true });
  const release = deferred();
  f.pauseMerchantResponse(release);
  try {
    await f.crashAfterSubmissionMarker('durable-http-crash', 'http');
    expect(f.paidRequests).toBe(1);
    await f.reopenWithoutPayExecutor();
    const record = f.payRecord('durable-http-crash')!;
    const original = f.app.ledger.savedOriginalPayment(record.approvalId)!;
    expect(original.state).toBe('SUBMISSION_ATTEMPTED');
    release.resolve();
    await f.app.start(f.origin);
    expect((await f.callPay(await f.connectPay(), 'durable-http-crash')).isError).not.toBe(true);
    expect(f.payRecord('durable-http-crash')).toMatchObject({ status: 'PAID', deliveryStatus: 'COMPLETE' });
    expect(f.app.ledger.savedOriginalPayment(record.approvalId)?.evidence).toEqual(original.evidence);
    expect(new Set(f.paidHeaders).size).toBe(1);
    expect(f.app.ledger.eventsForOwner(record.intent.idempotencyKey, f.memberId).filter(event => event.type === 'payment.PAID')).toHaveLength(1);
    expect(f.app.ledger.managedSummary(Date.now(), 'live_devnet')).toMatchObject({ paid: '200000', reserved: '0' });
  } finally { release.resolve(); await f.close(); }
}, 30000);

it('concurrent authority attempts with identical terms cannot borrow the winning attempt permit', async () => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    await f.callPay(await f.connectPay(), 'durable-attempt-seed');
    const facts = z.record(z.string(), z.unknown()).parse(f.lastFacts);
    const first = { ...facts, operation_id: 'durable-attempt-race', attempt_id: randomUUID() };
    const second = { ...first, attempt_id: randomUUID() };
    const replies = await Promise.all([f.authority.authorize(first, f.principal), f.authority.authorize(second, f.principal)]);
    expect(replies.filter(reply => reply.allow)).toHaveLength(1);
    const record = f.payRecord('durable-attempt-race')!;
    const permit = f.app.ledger.executionSafety.permit(record);
    expect(permit.attemptId).toBe(replies[0].allow ? first.attempt_id : second.attempt_id);
    expect(f.signatureCalls).toBe(1);
  } finally { await f.close(); }
}, 30000);


it('an upgraded default JS execution also cannot revive after Pause Resume while its signer is awaiting', async () => {
  const release = deferred();
  const f = await productionPayFixture({ signerBarrier: release });
  const signer = vi.spyOn(wallet, 'loadBuyerSigner').mockResolvedValue(f.signer);
  try {
    f.app.ledger.executionSafety.enable(Date.now());
    const pending = requestPaidResourcePurchase({ requestId: 'js-stale-epoch', resourceId: 'market-snapshot', reason: 'JS epoch check' },
      { config: loadPaymentConfig(), ledger: f.app.ledger, origin: f.origin, principal: f.principal, execute: true });
    await reachBoundary(f.signerStarted, pending);
    f.app.setPaused(true); f.app.setPaused(false); release.resolve();
    expect((await pending).status).toBe('FAILED');
    expect(f.signatureCalls).toBe(1); expect(f.paidRequests).toBe(0);
  } finally { release.resolve(); signer.mockRestore(); await f.close(); }
}, 30000);


it.each(['after-invalidate', 'later-sql', 'commit'] as const)('failed Pause rolls back epoch consistently at %s, then a committed Pause still fences old permits', async fault => {
  const f = await productionPayFixture({ payMcp: true });
  try {
    await f.callPay(await f.connectPay(), 'review-epoch-seed');
    const facts = z.record(z.string(), z.unknown()).parse(f.lastFacts);
    const next = { ...facts, operation_id: 'review-epoch-pending', attempt_id: randomUUID() };
    expect(await f.authority.authorize(next, f.principal)).toEqual({ allow: true });
    const record = f.payRecord('review-epoch-pending')!;
    const safety = f.app.ledger.executionSafety;
    const permit = safety.permit(record);
    const before = safety.snapshot();
    const db = new DatabaseSync(join(f.directory, 'app-ledger.sqlite'));
    let restoreCommit: (() => void) | undefined;
    try {
      if (fault === 'after-invalidate') {
        const invalidate = safety.invalidate.bind(safety);
        vi.spyOn(safety, 'invalidate').mockImplementationOnce(() => { invalidate(); throw new Error('INJECT_AFTER_INVALIDATE'); });
      } else if (fault === 'commit') {
        const exec = DatabaseSync.prototype.exec;
        let injected = false;
        const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
          if (!injected && sql === 'COMMIT') { injected = true; throw new Error('INJECT_COMMIT'); }
          return exec.call(this, sql);
        });
        restoreCommit = () => spy.mockRestore();
      } else {
        db.exec("CREATE TRIGGER review_pause_abort BEFORE UPDATE OF paused ON monetary_controls BEGIN SELECT RAISE(ABORT,'INJECT_LATER_SQL'); END");
      }
      expect(() => f.app.setPaused(true)).toThrow(/INJECT_/);
      expect(db.prepare('SELECT epoch FROM execution_owner WHERE id=1').get()?.epoch).toBe(before.epoch);
      expect(safety.snapshot()).toEqual(before);
      expect(() => safety.assert(record, permit)).not.toThrow();
      expect(f.app.ledger.controls('live_devnet').paused).toBe(false);
    } finally { restoreCommit?.(); db.exec('DROP TRIGGER IF EXISTS review_pause_abort'); db.close(); }
    f.app.setPaused(true); f.app.setPaused(false);
    expect(safety.snapshot().epoch).toBe(before.epoch + 1);
    expect(() => safety.assert(record, permit)).toThrow('EXTERNAL_EXECUTION_FENCED');
    await f.reopenWithoutPayExecutor();
    expect(f.app.ledger.executionSafety.snapshot().epoch).toBeGreaterThan(before.epoch + 1);
    expect(() => f.app.ledger.executionSafety.assert(f.payRecord('review-epoch-pending')!, permit)).toThrow('EXTERNAL_EXECUTION_FENCED');
    expect(f.signatureCalls).toBe(1); expect(f.paidRequests).toBe(1);
  } finally { await f.close(); }
}, 30_000);
