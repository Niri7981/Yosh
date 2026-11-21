import { parseStoredPurchaseStatus, paymentStatusFor } from './purchase-state';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { monetaryScopeId, type MonetaryScope } from './monetary-scope';
import type { StatementQuery } from '../mcp/account-read-contract';

/** A paid receipt and a budget reservation are disjoint. Keep the original
 * asset identity and never infer an actual fee from a quote or a fee ceiling. */
export function accountStatement(db: DatabaseSync, scope: MonetaryScope, query: StatementQuery) {
  const id = monetaryScopeId(scope);
  const where = ['p.monetary_scope_id=?']; const args: SQLInputValue[] = [id];
  const created = "json_extract(p.purchase,'$.createdAt')";
  if (query.from !== undefined && query.until !== undefined && query.until <= query.from) throw new Error('ACCOUNT_READ_INPUT_INVALID');
  if (query.agentId) { where.push('p.owner_card_member_id=?'); args.push(query.agentId); }
  if (query.from !== undefined) { where.push(`${created}>=?`); args.push(query.from); }
  if (query.until !== undefined) { where.push(`${created}<?`); args.push(query.until); }
  const filter = where.join(' AND ');
  let page = filter;
  const pageArgs = [...args];
  if (query.before) {
    const cursor = db.prepare(`SELECT p.rowid AS position FROM purchases p WHERE ${filter} AND p.id=?`).get(...args, query.before);
    if (!cursor) throw new Error('ACCOUNT_READ_INPUT_INVALID');
    page += ' AND p.rowid<?'; pageArgs.push(cursor.position);
  }
  const limit = query.limit ?? 10;
  const rows = db.prepare(`SELECT p.id AS purchaseId,p.owner_card_member_id AS agentId,m.label AS agentLabel,
    ${created} AS createdAt,json_extract(p.purchase,'$.providerId') AS merchant,json_extract(p.purchase,'$.payTo') AS payee,
    json_extract(p.purchase,'$.resourceId') AS resourceId,coalesce(json_extract(p.purchase,'$.paymentScheme'),json_extract(p.purchase,'$.scheme')) AS scheme,
    CASE WHEN json_type(p.purchase,'$.mpp')='object' THEN 'mpp' WHEN json_type(p.purchase,'$.x402Challenge')='object' OR json_type(p.quote,'$.x402Version')='integer' THEN 'x402' END AS protocol,
    json_extract(p.purchase,'$.resultAudience') AS resultAudience, p.status AS status,p.amount AS amountAtomic,d.state AS deliveryStatus,
    (SELECT max(e.at) FROM purchase_events e WHERE e.purchase_id=p.id AND e.type='payment.PAID') AS paidAt
    FROM purchases p LEFT JOIN card_members m ON m.id=p.owner_card_member_id LEFT JOIN purchase_delivery d ON d.purchase_id=p.id
    WHERE ${page} ORDER BY p.rowid DESC LIMIT ?`).all(...pageArgs, limit + 1);
  const reserved = (s: SQLInputValue) => s === 'APPROVED' || s === 'PAYING' || s === 'PAYMENT_UNKNOWN';
  const entries = rows.slice(0, limit).map(r => ({ ...r, paymentStatus: paymentStatusFor(parseStoredPurchaseStatus(r.status)), paymentMethod: scope.environment === 'simulated' ? 'simulated' : r.protocol ? 'solana' : null,
    paidAtomic: r.status === 'PAID' ? r.amountAtomic : '0', reservedAtomic: reserved(r.status) ? r.amountAtomic : '0', fee: null }));
  let paid = 0n, held = 0n;
  for (const row of db.prepare(`SELECT p.status,p.amount FROM purchases p WHERE ${filter} AND p.status IN ('PAID','APPROVED','PAYING','PAYMENT_UNKNOWN')`).iterate(...args)) {
    if (row.status === 'PAID') paid += BigInt(String(row.amount)); else held += BigInt(String(row.amount));
  }
  return { environment: scope.environment, asset: { network: scope.network, id: scope.assetId, decimals: scope.assetDecimals },
    entries, totals: { paidAtomic: paid.toString(), reservedAtomic: held.toString() }, nextBefore: rows.length > limit ? rows[limit - 1].purchaseId : null };
}
