import { YOSH_VERSION } from '../app/product-version';
import { AgentResourceRegistrationInput } from '../resources/agent-resource-registration';
import { DiscoveryInput } from '../resources/mainnet-resource-discovery';
import { MAX_SERIALIZED_RESOURCE_DELIVERY_BYTES, ResourceRequestInputSchema } from '../resources/http-resource';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// Only backend-defined codes cross the stdio boundary; no upstream exception text.
export class AgentReadError extends Error {
  constructor(readonly code: 'AGENT_READ_FAILED' | 'AGENT_UNAUTHORIZED') { super(code); }
}
export class AgentPurchaseInputError extends Error {
  constructor(readonly code: 'RESOURCE_REQUEST_INPUT_REQUIRED' | 'RESOURCE_REQUEST_INPUT_UNSUPPORTED' | 'RESOURCE_REQUEST_INPUT_INVALID' | 'RESOURCE_POST_APPROVAL_REQUIRED') { super(code); }
}

export class AgentPostApprovalError extends Error {
  constructor() { super('RESOURCE_POST_APPROVAL_REQUIRED'); }
}

export const AgentRegistrationErrorCodes = ['RESOURCE_DISCOVERY_NOT_FOUND', 'RESOURCE_DISCOVERY_EXPIRED',
  'RESOURCE_DISCOVERY_CONSUMED', 'RESOURCE_ID_EXISTS', 'RESOURCE_REQUEST_EXISTS', 'RESOURCE_REGISTRY_FULL',
  'RESOURCE_REGISTRATION_INPUT_INVALID', 'RESOURCE_REGISTRATION_UNAVAILABLE', 'AGENT_UNAUTHORIZED'] as const;
export class AgentRegistrationError extends Error {
  constructor(readonly code: typeof AgentRegistrationErrorCodes[number]) { super(code); }
}

export type AgentRead = (operation: 'status' | 'quote') => Promise<unknown>;
export type AgentPurchaseRequest = (input: { requestId: string; resourceId: string; reason: string; query?: string }) => Promise<unknown>;
export type AgentDiscover = (input: unknown) => Promise<unknown>;
export type AgentDelivery = (purchaseId: string, offset: number) => Promise<unknown>;
export type AgentQuote = (resourceId: string, sample: unknown) => Promise<unknown>;

/** Official MCP SDK owns negotiation, schemas and transport; Yosh only maps tools. */
export function createAgentServer(read: AgentRead, requestPurchase: AgentPurchaseRequest = async () => { throw new Error('PURCHASE_REQUEST_UNAVAILABLE'); },
  discover: AgentDiscover = async () => { throw new Error('RESOURCE_DISCOVERY_UNAVAILABLE'); },
  delivery: AgentDelivery = async () => { throw new Error('DELIVERY_NOT_AVAILABLE'); },
  quoteResource: AgentQuote = async () => { throw new Error('RESOURCE_QUOTE_UNAVAILABLE'); },
  registerResource: AgentDiscover = async () => { throw new Error('RESOURCE_REGISTRATION_UNAVAILABLE'); }) {
  const server = new McpServer({ name: 'Yosh', version: YOSH_VERSION });
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  for (const [name, operation, description] of [
    ['get_spending_status', 'status', 'Read the Yosh wallet address and shared spending budget. Does not pay.'],
    ['get_market_quote', 'quote', 'Read current x402 quotes for registered resources in the current payment environment. Does not authorize or pay.'],
  ] as const) {
    server.registerTool(name, { description, inputSchema: {}, annotations }, async () => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await read(operation)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof AgentReadError
        ? `${error.code}: Yosh could not complete this read; no payment was requested.`
        : 'APP_UNAVAILABLE: 请启动 Yosh 并启用 Agent 连接；请求未付款。' }] }; }
    });
  }
  server.registerTool('discover_x402_resource', {
    description: 'Inspect one public HTTPS x402 GET request without payment. Unknown JSON POST discovery requires specific approval in the Yosh app before any outbound request. Returns a backend-bound discoveryId and registration proposal. Use register_x402_resource to persist it for user review; discovery cannot create a Spend Grant or pay.',
    inputSchema: DiscoveryInput,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async input => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await discover(input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof AgentPostApprovalError
      ? 'RESOURCE_POST_APPROVAL_REQUIRED: Review and approve this specific POST in Yosh. No outbound request or payment was sent.'
      : 'RESOURCE_DISCOVERY_UNAVAILABLE: No supported unpaid x402 quote was safely retrieved.' }] }; }
  });
  server.registerTool('register_x402_resource', {
    description: 'Register a previously validated discovery in the shared Yosh Resource Registry. Pass the discoveryId returned by discover_x402_resource and resource identity labels only. The backend preserves endpoint, fixed/dynamic typed inputs, sample and delivery metadata. Creation only; cannot edit existing resources or create a Spend Grant, change settings, sign or pay. User reviews the Agent-submitted resource in Yosh before granting spending authority.',
    inputSchema: AgentResourceRegistrationInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async input => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await registerResource(input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const,
      text: `${error instanceof AgentRegistrationError ? error.code : 'RESOURCE_REGISTRATION_UNAVAILABLE'}: No spending permission or payment was created.` }] }; }
  });
  server.registerTool('get_purchase_delivery', {
    description: 'Read one bounded chunk of a completed purchase delivery owned by this Agent. Use nextOffset until null; decode base64 chunks in order as UTF-8 JSON.',
    inputSchema: z.object({ purchaseId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), offset: z.number().int().min(0).max(MAX_SERIALIZED_RESOURCE_DELIVERY_BYTES).default(0) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async input => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await delivery(input.purchaseId, input.offset)) }] }; }
    catch { return { isError: true, content: [{ type: 'text' as const, text: 'DELIVERY_NOT_AVAILABLE: This Agent cannot retrieve that completed delivery.' }] }; }
  });
  server.registerTool('quote_x402_resource', {
    description: 'Read a fresh unpaid quote for a registered resource using validated sample fields. Reports local eligibility; it does not reserve, authorize, sign or submit payment.',
    inputSchema: z.object({ resourceId: z.string().min(1).max(200),
      sample: ResourceRequestInputSchema.optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async input => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await quoteResource(input.resourceId, input.sample ?? {})) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof AgentPostApprovalError
      ? 'RESOURCE_POST_APPROVAL_REQUIRED: Create an explicitly confirmed POST Spend Grant in Yosh before sample quoting.'
      : 'RESOURCE_QUOTE_UNAVAILABLE: No supported unpaid quote was retrieved.' }] }; }
  });
  server.registerTool('request_purchase', {
    description: 'Request a registered paid resource. The local Yosh backend obtains a fresh x402 quote, applies SpendGrant and budget policy, and may execute an approved purchase in its configured payment environment. The Agent cannot provide payment terms or signing data.',
    inputSchema: z.object({
      requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).describe('Stable idempotency key for this purchase request'),
      resourceId: z.string().min(1).max(200).describe('Registered paid resource; the Agent cannot provide an amount'),
      reason: z.string().trim().min(1).max(240).describe('Short user-facing reason for requesting this data'),
      query: z.string().trim().min(1).max(300).optional().describe('Value for a registered resource with one approved query field'),
      request: ResourceRequestInputSchema.optional()
        .describe('Values for query or JSON body fields explicitly allowed by the resource registration'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async input => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await requestPurchase(input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof AgentPurchaseInputError
      ? `${error.code}: ${error.code === 'RESOURCE_POST_APPROVAL_REQUIRED' ? 'Confirm a POST Spend Grant in Yosh.' : 'This resource requires valid declared request fields.'} No purchase was started.`
      : 'PURCHASE_REQUEST_FAILED: 请求未完成；请用原 requestId 查询或恢复购买状态。' }] }; }
  });
  return server;
}
