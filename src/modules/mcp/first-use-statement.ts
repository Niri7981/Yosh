import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readBoundedResourceDelivery } from '../resources/read-market-snapshot';
import { accountReadPath, StatementInput, type StatementQuery } from './account-read-contract';
import { PurchaseResourceLookup } from './purchase-resource-contract';
import { describeLocalResource, describePurchaseResourceTool, hostPurchaseTool, LocalHostPurchaseToolInput, requestLocalPurchase, type HostPurchase } from './local-host-purchase';
import { connectionFile, ConnectionSchema } from './connection';
import { AgentDeliveryRecoveryInput, DeliveryRecoveryErrors } from './purchase-read-contract';

const origin = 'http://127.0.0.1:13449';
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const statementInput = StatementInput.extend({ environment: z.literal('mainnet').optional() });
type ReadStatement = (query: StatementQuery, signal: AbortSignal) => Promise<unknown>;

export function createFirstUseStatementServer(read: ReadStatement, purchase: (input: HostPurchase, signal: AbortSignal, deliveryOffset?: number) => Promise<unknown>,
  describe: (input: z.infer<typeof PurchaseResourceLookup>, signal: AbortSignal) => Promise<unknown>,
  recoverDelivery: (purchaseId: string, signal: AbortSignal) => Promise<unknown>) {
  const server = new McpServer({ name: 'yosh', version: '1' });
  server.registerTool('list_account_purchases', {
    description: 'View the shared Mainnet account statement. On first use Yosh opens a native confirmation window on this Mac. Direct the user to that window to verify the agent name and statement-only access; no Yosh app needs to be opened. The same call continues after approval. Totals cover the entire query; use nextBefore as before to page. This tool grants no spending authority.',
    inputSchema: statementInput, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (args, { signal }) => {
    try {
      const query = StatementInput.strip().parse(args);
      if (query.from !== undefined && query.until !== undefined && query.until <= query.from) throw new Error('ACCOUNT_READ_INPUT_INVALID');
      return text(await read(query, signal));
    } catch (error) {
      const code = error instanceof Error && /^(?:LOCAL_|MAINNET_|ACCOUNT_READ_|AGENT_UNAUTHORIZED)[A-Z0-9_]*$/.test(error.message)
        ? error.message : 'LOCAL_STATEMENT_UNAVAILABLE';
      return { ...text({ code }), isError: true };
    }
  });
  server.registerTool(describePurchaseResourceTool.name, { ...describePurchaseResourceTool, inputSchema: PurchaseResourceLookup },
    (input, { signal }) => describeLocalResource(describe, input, signal));
  server.registerTool(hostPurchaseTool.name, { ...hostPurchaseTool, inputSchema: LocalHostPurchaseToolInput },
    (input, { signal }) => requestLocalPurchase(purchase, input, signal));
  server.registerTool('recover_purchase_delivery', {
    description: 'Retry delivery for this Agent’s confirmed paid Mainnet MPP purchase using its original credential and purchase ID. Returns the original receipt and the saved first result chunk when available. No new payment or signature.',
    inputSchema: AgentDeliveryRecoveryInput.extend({ environment: z.literal('mainnet') }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ purchaseId }, { signal }) => {
    try { return text(await recoverDelivery(purchaseId, signal)); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      const allowed = Object.hasOwn(DeliveryRecoveryErrors, code) || ['AGENT_UNAUTHORIZED', 'LOCAL_HOST_BINDING_MISMATCH', 'LOCAL_PURCHASE_BINDING_MISMATCH'].includes(code);
      return { ...text({ purchaseId, code: allowed ? code : 'MPP_DELIVERY_RECOVERY_UNAVAILABLE' }), isError: true };
    }
  });
  return server;
}

/** The first-use reader accepts only a statement descriptor owned by this
 * registration's new member. The established payment host's default file is
 * never considered, even when the selected descriptor was revoked. */
export async function readMemberStatement(directory: string, memberId: string, query: StatementQuery,
  signal: AbortSignal, request: typeof fetch = fetch) {
  const file = connectionFile(directory, z.uuid().parse(memberId));
  let connection: z.infer<typeof ConnectionSchema>;
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 16_384 || realpathSync(file) !== file)
        throw new Error('LOCAL_STATEMENT_CONNECTION_INVALID');
      connection = ConnectionSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
    } finally { closeSync(fd); }
  } catch { throw new Error('LOCAL_STATEMENT_CONNECTION_UNAVAILABLE'); }
  if (connection.origin !== origin || connection.cardMemberId !== memberId || !connection.capabilities.includes('read_statement')
      || connection.capabilities.includes('read')) throw new Error('LOCAL_STATEMENT_CONNECTION_INVALID');
  const response = await request(origin + accountReadPath('list_account_purchases', query), {
    headers: { authorization: 'Bearer ' + connection.token }, redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 || response.status === 403 ? 'LOCAL_STATEMENT_CONNECTION_REVOKED'
      : response.status === 400 ? 'ACCOUNT_READ_INPUT_INVALID' : 'ACCOUNT_READ_UNAVAILABLE');
  }
  const statement = await readBoundedResourceDelivery(response, { format: 'json', mimeTypes: ['application/json'], maxBytes: 65_536 });
  if (!z.object({ environment: z.literal('live_mainnet') }).safeParse(statement).success) throw new Error('LOCAL_STATEMENT_ENVIRONMENT_MISMATCH');
  return statement;
}
