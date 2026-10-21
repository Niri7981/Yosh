import { appRuntime } from '@/modules/app/app-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const app = appRuntime();
  let principal;
  try { principal = app.authenticateAgent(request); }
  catch { return Response.json({ code: 'AGENT_UNAUTHORIZED' }, { status: 401 }); }
  try {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].length !== 1) return Response.json({ code: 'INVALID_OPERATION' }, { status: 400 });
    const operation = query.get('operation');
    if (operation === 'status') {
      const balance = await app.readAuthorityBalance();
      const overview = await app.overview();
      const member = app.memberOverview(principal.cardMemberId);
      return Response.json({ wallet: { ...overview.wallet, balance }, budget: overview.budget, grant: member.grant, authority: member.authority,
        spendingAuthorized: member.authority.readiness.transactionExecution.eligible,
        readiness: member.authority.readiness,
        registeredResources: overview.service.registeredResources, execution: overview.service.execution,
        paymentEnabled: overview.service.paymentEnabled, recentPurchases: member.purchases.slice(0, 10) }, { headers: { 'cache-control': 'no-store' } });
    }
    if (operation !== 'quote') return Response.json({ code: 'UNKNOWN_OPERATION' }, { status: 400 });
    return Response.json(await app.quotePaidResources(new URL(request.url).origin, principal.cardMemberId), { headers: { 'cache-control': 'no-store' } });
  } catch { return Response.json({ code: 'AGENT_READ_FAILED', error: '暂时无法读取；请求未付款。' }, { status: 503 }); }
}
