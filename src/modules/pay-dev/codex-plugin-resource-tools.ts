import { z } from 'zod';
import type { AppRuntime } from '../app/app-runtime';
import type { SpendPrincipal } from '../authority/spend-grant';
import { PaidResourceIdSchema } from '../resources/paid-resources';
import { isPayDevelopmentDirectory } from './isolation';
import { IS_CODEX_PLUGIN_DEVELOPMENT } from './profile';
import { assertDevelopmentOrigin } from './environment';

const QuoteInput = z.object({ resourceId: z.string().min(1).max(200), sample: z.object({}).strict().optional() }).strict();
const Quote = z.object({ resourceId: PaidResourceIdSchema, amount: z.string().regex(/^[1-9]\d*$/),
  decimals: z.literal(6), display: z.string(), asset: z.string(), network: z.string(), payTo: z.string(), resourceUrl: z.string() });

/** Only the already-supported Offline fixture IDs are quotable here. Arbitrary
 * HTTP discovery/registration keeps its normal public-HTTPS policy unchanged. */
export async function readPluginOfflineQuote(app: Pick<AppRuntime, 'directory' | 'quotePaidResources' | 'quoteRegisteredResource'>, origin: string, raw: unknown, principal: SpendPrincipal) {
  if (!IS_CODEX_PLUGIN_DEVELOPMENT || !isPayDevelopmentDirectory(app.directory)) throw new Error('OFFLINE_RESOURCE_TOOL_UNAVAILABLE');
  assertDevelopmentOrigin(origin);
  const input = QuoteInput.parse(raw);
  if (!PaidResourceIdSchema.safeParse(input.resourceId).success) {
    return { ...await app.quoteRegisteredResource(input.resourceId, input.sample ?? {}, principal.cardMemberId),
      spendingAuthorityCreated: false, testOnly: true };
  }
  const quotes = z.object({ resources: z.array(z.unknown()) }).parse(await app.quotePaidResources(origin, principal.cardMemberId));
  const matches = quotes.resources.filter(value => z.object({ resourceId: z.literal(input.resourceId) }).safeParse(value).success);
  if (matches.length !== 1) throw new Error('OFFLINE_RESOURCE_TOOL_UNAVAILABLE');
  // Another registered resource's unavailable quote must not hide this fixed
  // fixture. Validate all returned economics on the selected entry only.
  const quote = Quote.parse(matches[0]);
  return { resourceId: quote.resourceId, request: { method: 'GET', url: new URL(quote.resourceUrl, origin).href },
    amount: quote.amount, display: quote.display, network: quote.network, assetId: quote.asset, assetDecimals: quote.decimals,
    payTo: quote.payTo, paymentSent: false, spendingAuthorityCreated: false, testOnly: true,
    notice: 'Offline fixture quote only. Review a Spend Grant in Yosh Codex Plugin Dev before purchasing. No real funds or external API was accessed.' };
}
