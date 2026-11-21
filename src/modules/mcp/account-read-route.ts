import type { AppRuntime } from '../app/app-runtime';
import { StatementInput, ResultInput } from './account-read-contract';

export function handleAccountRead(app: AppRuntime, kind: 'statement' | 'result', request: Request) {
  const respond = (data: unknown, status: number) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
  try {
    const principal = app.authenticateAgent(request, kind === 'statement' ? 'read_statement' : 'read');
    const query: Record<string, unknown> = Object.create(null);
    for (const [key, value] of new URL(request.url).searchParams) {
      if (Object.hasOwn(query, key)) return respond({ code: 'ACCOUNT_READ_INPUT_INVALID' }, 400);
      query[key] = ['limit', 'from', 'until', 'offset'].includes(key) && /^(0|[1-9]\d{0,15})$/.test(value) ? Number(value) : value;
    }
    if (kind === 'statement') {
      const input = StatementInput.safeParse(query);
      if (!input.success) return respond({ code: 'ACCOUNT_READ_INPUT_INVALID' }, 400);
      return respond(app.readAccountStatement(principal, input.data), 200);
    }
    const input = ResultInput.safeParse(query);
    if (!input.success) return respond({ code: 'ACCOUNT_READ_INPUT_INVALID' }, 400);
    const result = app.readAccountResult(principal, input.data);
    return result ? respond(result, 200) : respond({ code: 'ACCOUNT_RESULT_NOT_AVAILABLE' }, 404);
  } catch (error) {
    if (error instanceof Error && ['AGENT_UNAUTHORIZED','CARD_MEMBER_REVOKED'].includes(error.message)) return respond({ code: 'AGENT_UNAUTHORIZED' }, 401);
    if (error instanceof Error && error.message === 'ACCOUNT_READ_INPUT_INVALID') return respond({ code: error.message }, 400);
    return respond({ code: 'ACCOUNT_READ_UNAVAILABLE' }, 503);
  }
}
