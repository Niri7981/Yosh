import { randomUUID } from 'node:crypto';
import { linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AppRuntime } from '../../src/modules/app/app-runtime';
import { initializeRemotePurchaseSandbox, simulationGrantScope, type RemotePurchaseConsent } from '../../src/modules/purchases/remote-simulated-purchase';

const temp = () => mkdtempSync(join(tmpdir(), 'yosh-p2-execution-'));
const terms = () => ({ resourceId: 'market-snapshot', totalLimit: '6000000', singleLimit: '3000000', expiresAt: Date.now() + 600_000 });
const request = (requestId: string) => ({ requestId, resourceId: 'market-snapshot' });
const options = { remotePurchaseSandbox: true, confirmRemotePurchaseConsent: async () => true };
it('resumes only unclaimed simulated approvals after restart; unknown handling never charges or releases the reservation', async () => {
  const directory = temp(); initializeRemotePurchaseSandbox(directory);
  let app = new AppRuntime(directory, options);
  try {
    app.setDailyLimit('6000000'); app.setPaused(false);
    const reader = await app.issueRemotePurchasePairing('Planner');
    const grant = await app.createRemotePurchaseGrant(reader.id, terms());
    const settle = vi.spyOn(app.ledger, 'settleSimulatedApproval').mockImplementation(() => { throw Error('TEST_STOP_AFTER_RESERVE'); });
    expect(() => app.requestRemotePurchase(reader.token, request('resume'))).toThrow('TEST_STOP_AFTER_RESERVE');
    expect(() => app.requestRemotePurchase(reader.token, request('uncertain'))).toThrow('TEST_STOP_AFTER_RESERVE');
    settle.mockRestore();
    // Model a previously claimed operation with no conclusive outcome. Fresh simulator writes
    // claim and finish atomically; this deliberately exercises the conservative recovery boundary.
    const pending = app.ledger.getOwned('uncertain', reader.memberId)!;
    app.ledger.claim(pending.approvalId, Date.now(), undefined, 'simulated');
    app.ledger.unknown(pending.approvalId);
    app.close(); app = new AppRuntime(directory, options); await app.start('http://127.0.0.1:3049');
    expect(app.requestRemotePurchase(reader.token, request('uncertain'))).toMatchObject({status:'PAYMENT_UNKNOWN', reused:true, grantId:grant.grantId});
    expect(app.getRemotePurchase(reader.token, {requestId:'uncertain'}).purchaseId).toBe(pending.intent.id);
    expect(app.ledger.managedSummary(Date.now(), 'simulated')).toMatchObject({paid:'0', reserved:'6000000'});
    expect(() => app.requestRemotePurchase(reader.token, request('resume'))).toThrow();
  } finally { app.close(); rmSync(directory,{recursive:true,force:true}); }
});
it('restores an approved order with its immutable Grant/UUID; a lost response cannot debit the shared wallet twice', async () => {
  const dir=temp(); initializeRemotePurchaseSandbox(dir); let app=new AppRuntime(dir, options);
  try {
    app.setDailyLimit('5000000'); app.setPaused(false);
    const a=await app.issueRemotePurchasePairing('Planner'); const g=await app.createRemotePurchaseGrant(a.id, terms());
    vi.spyOn(app.ledger,'settleSimulatedApproval').mockImplementationOnce(() => {throw Error('TEST_STOP_AFTER_RESERVE');});
    expect(()=>app.requestRemotePurchase(a.token,request('original'))).toThrow('TEST_STOP_AFTER_RESERVE');
    const original=app.getRemotePurchase(a.token,{requestId:'original'}).purchaseId;
    app.close(); app=new AppRuntime(dir,options);
    const done=app.requestRemotePurchase(a.token,request('original'));
    expect(done).toMatchObject({purchaseId:original, status:'PAID',grantId:g.grantId,deliveryStatus:'COMPLETE',reused:true,amountAtomic:'3000000'});
    expect(app.requestRemotePurchase(a.token,request('original'))).toEqual(done);
    expect(app.ledger.managedSummary(Date.now(),'simulated')).toMatchObject({paid:'3000000',reserved:'0'});
  } finally {app.close();rmSync(dir,{recursive:true,force:true});}
});
it('a grant revoked while the owner is reviewing a replacement is not revived by stale consent', async () => {
  const dir=temp(); initializeRemotePurchaseSandbox(dir);
  let confirm: (facts: RemotePurchaseConsent) => Promise<boolean> = async () => true;
  const app=new AppRuntime(dir,{remotePurchaseSandbox:true,confirmRemotePurchaseConsent:facts=>confirm(facts)});
  try {
    const a=await app.issueRemotePurchasePairing('Planner'); const b=await app.issueRemotePurchasePairing('Reader'); const g=await app.createRemotePurchaseGrant(a.id,terms());
    expect(()=>app.revokeRemotePurchaseGrant(b.id,g.grantId)).toThrow('REMOTE_PURCHASE_GRANT_CHANGED');
    let approve: (()=>void) | undefined;
    confirm=()=>new Promise(resolve=>{approve=()=>resolve(true);});
    const stale=app.createRemotePurchaseGrant(a.id,terms());
    app.revokeRemotePurchaseGrant(a.id,g.grantId); approve!();
    await expect(stale).rejects.toThrow('REMOTE_PURCHASE_GRANT_CHANGED');
    expect(app.ledger.activeSpendGrant(Date.now(),a.memberId,'simulated')).toBeUndefined();
  } finally {app.close();rmSync(dir,{recursive:true,force:true});}
});
it('refuses linked SQLite data before taking the owner lock, and refuses to open a sandbox as a product wallet', () => {
  const dir=temp(); initializeRemotePurchaseSandbox(dir);
  const other=temp(), target=join(other,'file'), file=join(dir,'app-ledger.sqlite'); writeFileSync(target,'fixture');
  try {
    symlinkSync(target,file);
    expect(()=>new AppRuntime(dir,options)).toThrow('REMOTE_PURCHASE_UNSAFE_DATABASE');
    unlinkSync(file); linkSync(target,file);
    expect(()=>new AppRuntime(dir,options)).toThrow('REMOTE_PURCHASE_UNSAFE_DATABASE');
    expect(()=>new AppRuntime(dir)).toThrow('REMOTE_PURCHASE_SANDBOX_REQUIRED');
  } finally {rmSync(dir,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});}
});

it('a grant bound to another connection of the same member does not authorize the simulation purchase', async () => {
  const dir = temp(); initializeRemotePurchaseSandbox(dir);
  const app = new AppRuntime(dir, options);
  try {
    app.setDailyLimit('5000000'); app.setPaused(false);
    const a = await app.issueRemotePurchasePairing('Planner');
    const {singleLimit,totalLimit,expiresAt} = terms();
    app.ledger.createSpendGrant({singleLimit,totalLimit,expiresAt}, {cardMemberId:a.memberId,connectionId:randomUUID(),connectionGeneration:1},
      simulationGrantScope, Date.now(), 'simulated');
    expect(app.requestRemotePurchase(a.token, request('wrong-connection'))).toMatchObject({status:'DENIED', paymentStatus:'NOT_STARTED'});
    expect(app.ledger.managedSummary(Date.now(), 'simulated')).toMatchObject({paid:'0', reserved:'0'});
  } finally { app.close(); rmSync(dir,{recursive:true,force:true}); }
});
