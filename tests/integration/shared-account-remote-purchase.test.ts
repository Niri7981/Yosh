import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { startRemoteReadRelay } from '../../src/modules/remote/forwarder';
import { remotePurchaseFixture } from '../helpers/remote-purchase-fixture';
import { testingSshHost } from '../helpers/remote-read-ssh-fixture';

const pairing = z.object({ id: z.uuid(), memberId: z.uuid(), token: z.string().min(40) });
const reply = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.literal('text'), text:z.string() })).nonempty() });
const purchase = z.object({ purchaseId: z.uuid(), status: z.string(), amountAtomic: z.string(), simulated: z.literal(true) });
const sshAvailable = ['/usr/bin/ssh','/usr/bin/ssh-keygen','/usr/sbin/sshd'].every(p => existsSync(p));

it.skipIf(!sshAvailable)('enforces per-agent Grants and a shared wallet at the remote MCP boundary; a lost purchase reply cannot cause a second debit', async () => {
  const f = await remotePurchaseFixture();
  const clients: Client[] = [];
  let ssh: Awaited<ReturnType<typeof testingSshHost>> | undefined, relay: Awaited<ReturnType<typeof startRemoteReadRelay>> | undefined;
  try {
    ssh = await testingSshHost(); relay = await startRemoteReadRelay({listenPort:0, tunnelPort:ssh.tunnelPort});
    await ssh.connect(Number(new URL(f.origin).port));
    const endpoint = new URL('http://127.0.0.1:' + relay.port + '/mcp');
    const connect = async (token: string) => {
      const client = new Client({ name: 'isolated-remote-p2-acceptance', version:'1' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch:f.nativeFetch, requestInit:{headers:{authorization:'Bearer '+token}} }));
      return client;
    };
    const pair = async (label: string, scope = 'purchase') => {
      const response = await f.manage({action:'pair',label,scopes:[scope]});
      expect(response.status).toBe(201);
      return pairing.parse(await response.json());
    };
    const args = (requestId: string) => ({requestId, resourceId: 'market-snapshot'});
    const call = async (c: Client, name: string, input: Record<string,unknown>) => {
      const output = reply.parse(await c.callTool({name,arguments:input}));
      if (output.isError) return { error:output.content[0].text };
      return JSON.parse(output.content[0].text) as unknown;
    };
    const buy = (c: Client, id: string) => call(c, 'request_purchase', args(id));
    const status = (c: Client, requestId: string) => call(c, 'get_purchase', {requestId});
    const rejection = z.union([z.object({error:z.string()}),z.object({status:z.literal('DENIED')})]);
    const grant = async (account: {id:string}, totalLimit = '9000000', singleLimit = '3000000') =>
      f.manage({action:'grant',id:account.id,resourceId:'market-snapshot',totalLimit,singleLimit,expiresAt:Date.now()+300_000});
    const paidCount = () => {
      const db = new DatabaseSync(join(f.directory,'app-ledger.sqlite'), {readOnly:true});
      try { return db.prepare("SELECT count(*) AS n FROM purchase_events WHERE type='payment.PAID'").get()?.n; } finally { db.close(); }
    };

    expect((await f.manage({action:'pair',label:'Declined',scopes:['purchase']})).status).toBe(403);
    f.consent(true);
    const researcher = await pair('Research'), buyer = await pair('Travel'), auditor = await pair('Books','statement');
    expect(researcher.token.startsWith('yrp1_') && buyer.token.startsWith('yrp1_')).toBe(true);
    expect(new Set([researcher.memberId,buyer.memberId,auditor.memberId]).size).toBe(3);
    const a = await connect(researcher.token), b = await connect(buyer.token), read = await connect(auditor.token);
    expect((await a.listTools()).tools.map(t => t.name).sort()).toEqual(['get_purchase','request_purchase']);
    expect((await read.listTools()).tools.map(t => t.name)).not.toContain('request_purchase');
    expect(rejection.safeParse(await buy(read,'reader-cannot-pay')).success).toBe(true);
    expect(rejection.safeParse(await buy(b,'b-no-grant')).success).toBe(true);
    f.app.setDailyLimit('5000000'); f.app.setPaused(false);
    f.consent(false);
    expect((await grant(researcher)).status).toBe(403);
    f.consent(true);
    const aGrant = z.object({grantId:z.uuid()}).parse(JSON.parse(await f.owner('grant','--id',researcher.id,
      '--resource','market-snapshot','--single','3000000','--total','9000000','--expires-at',String(Date.now()+300_000))));
    expect(aGrant.grantId).toBe(f.app.spendGrantSummary(researcher.memberId)?.id);
    expect(await buy(b,'b-cannot-use-a')).toMatchObject({status:'DENIED',reason:'SPEND_GRANT_REQUIRED'});
    expect(rejection.safeParse(await call(b,'request_purchase',{...args('impersonation'),memberId:researcher.memberId})).success).toBe(true);
    expect((await grant(buyer)).ok).toBe(true);
    expect(paidCount()).toBe(0);
    const candidates = [{c:a,account:researcher,key:'research-race'}, {c:b,account:buyer,key:'travel-race'}];
    const outcomes = await Promise.all(candidates.map(candidate => buy(candidate.c,candidate.key)));
    const wins = outcomes.map((o,i)=>({...candidates[i],result:purchase.safeParse(o)})).filter(r=>r.result.success && r.result.data.status==='PAID');
    expect(wins.length).toBe(1); const win = wins[0]; const won = purchase.parse(outcomes[candidates.findIndex(v => v.key === win.key)]);
    expect(won.amountAtomic).toBe('3000000');
    const lose = candidates.find(v => v.key!==win.key)!;
    expect(outcomes[candidates.indexOf(lose)]).toMatchObject({status:'DENIED',reason:'DAILY_BUDGET_EXCEEDED'});
    const record = f.app.ledger.listForAdministration().filter(row=>row.status==='PAID');
    expect(record).toHaveLength(1); expect(record[0]).toMatchObject({ ownerCardMemberId:win.account.memberId, grantId:f.app.spendGrantSummary(win.account.memberId)?.id });
    expect(rejection.safeParse(await status(lose.c,win.key)).success).toBe(true);
    expect(f.app.ledger.managedSummary(Date.now(),'simulated')).toMatchObject({paid:'3000000',reserved:'0'});
    expect(paidCount()).toBe(1);
    await ssh.stopLink(); await ssh.connect(Number(new URL(f.origin).port));
    const fresh = await connect(win.account.token);
    expect(await buy(fresh,win.key)).toMatchObject({purchaseId:won.purchaseId,status:'PAID'});
    expect(paidCount()).toBe(1);

    // Commit a second purchase, then physically drop its HTTP reply before the agent sees it.
    f.app.setDailyLimit('8000000');
    f.loseNextReply();
    await expect(buy(fresh,'connection-lost-after-debit')).rejects.toThrow();
    expect(paidCount()).toBe(2);
    f.reopen();
    const previous = purchase.parse(await status(fresh,'connection-lost-after-debit'));
    expect(previous.status).toBe('PAID');
    expect(await buy(fresh,'connection-lost-after-debit')).toMatchObject({purchaseId:previous.purchaseId,status:'PAID'});
    expect(paidCount()).toBe(2);
    f.app.setDailyLimit('15000000'); f.app.setPaused(true);
    expect(await buy(fresh,'paused')).toMatchObject({status:'DENIED',reason:'PAYMENTS_PAUSED'});
    f.app.setPaused(false);
    const revoked = await f.manage({action:'revoke_grant',id:win.account.id,grantId:f.app.spendGrantSummary(win.account.memberId)?.id});
    expect(revoked.ok).toBe(true);
    expect(rejection.safeParse(await buy(fresh,'grant-revoked')).success).toBe(true);
    expect((await f.manage({action:'revoke',id:win.account.id})).ok).toBe(true);
    await expect(fresh.listTools()).rejects.toThrow();
    expect((await lose.c.listTools()).tools.some(t=>t.name==='request_purchase')).toBe(true);
    expect(() => f.app.setExecution('live_devnet')).toThrow();
    expect((await grant(lose.account,'3000000','2000000')).ok).toBe(true);
    expect(await buy(lose.c,'above-grant-single')).toMatchObject({status:'DENIED',reason:'SPEND_GRANT_SINGLE_LIMIT_EXCEEDED'});
    expect((await grant(lose.account,'3000000')).ok).toBe(true);
    const raceSameId = await Promise.all([buy(lose.c,'within-new-grant'), buy(lose.c,'within-new-grant')]);
    const same = raceSameId.map(r => purchase.parse(r));
    expect(same[0]).toMatchObject({status:'PAID',amountAtomic:'3000000'});
    expect(same[1]).toMatchObject({purchaseId:same[0].purchaseId,status:'PAID'});
    expect(paidCount()).toBe(3);
    expect(await buy(lose.c,'above-grant-total')).toMatchObject({status:'DENIED',reason:'SPEND_GRANT_TOTAL_LIMIT_EXCEEDED'});
    expect((await grant(lose.account,'9000000')).ok).toBe(true);
    f.advance(310_000);
    expect(rejection.safeParse(await buy(lose.c,'expired-grant')).success).toBe(true);
    expect(f.app.spendGrantSummary(lose.account.memberId)?.status).toBe('EXPIRED');
    const audit = z.object({totals:z.object({paidAtomic:z.string(),reservedAtomic:z.string()})}).parse(await call(read,'list_account_purchases',{}));
    expect(audit.totals).toEqual({paidAtomic:'9000000',reservedAtomic:'0'});
    expect(paidCount()).toBe(3); expect(f.refusedNetwork).toBe(0);
  } finally {
    for (const c of clients) await c.close();
    await relay?.close(); await ssh?.close(); await f.close();
  }
}, 60_000);
