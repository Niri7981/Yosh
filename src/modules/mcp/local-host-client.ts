import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { PurchaseResourceContract, PurchaseResourceLookup } from './purchase-resource-contract';
import { executeHostPurchase, LocalHostPurchaseOwnerInput, LocalHostPurchasePlan, type HostPurchase } from './local-host-purchase';

const execute = promisify(execFile);
const ownerActions = {
  'pair-statement': { timeout: 210_000, maxBuffer: 16_384, unavailable: 'LOCAL_STATEMENT_OWNER_UNAVAILABLE' },
  'authorize-host-purchase': { timeout: 360_000, maxBuffer: 16_384, unavailable: 'LOCAL_PURCHASE_OWNER_UNAVAILABLE' },
  // Up to 16 query fields with 32 enum values of 300 characters, including JSON escapes.
  'describe-host-resource': { timeout: 70_000, maxBuffer: 1_048_576, unavailable: 'LOCAL_RESOURCE_LOOKUP_UNAVAILABLE' },
};

export function createLocalHostClient(runtime: string, host: { registration: string; label: string }) {
  const { registration, label } = host;
  const home = userInfo().homedir;
  const node = join(runtime, 'node'), launcher = join(runtime, 'mainnet.cjs');
  const env = { HOME: home, PATH: '/usr/bin:/bin', NODE_ENV: 'production' as const };
  async function owner(action: keyof typeof ownerActions, signal: AbortSignal, input?: z.infer<typeof LocalHostPurchaseOwnerInput> | z.infer<typeof PurchaseResourceLookup>): Promise<unknown> {
    const { timeout, maxBuffer, unavailable } = ownerActions[action];
    const command = execute(node, [launcher, action, '--registration', registration, '--label', label], {
      cwd: runtime, timeout, maxBuffer, signal, env,
    });
    command.child.stdin?.on('error', () => { /* Child failure is reported via the exit status. */ });
    command.child.stdin?.end(input ? JSON.stringify(input) : undefined);
    const { stdout } = await command.catch((error: unknown) => {
      const diagnostic = z.object({ stderr: z.string() }).safeParse(error);
      const code = diagnostic.success ? diagnostic.data.stderr.trim().split('\n').at(-1) : '';
      throw new Error(code && /^(?:(?:LOCAL_|MAINNET_)[A-Z0-9_]{1,80}|MPP_NETWORK_FEE_CONSENT_REQUIRED)$/.test(code) ? code : unavailable);
    });
    return JSON.parse(stdout);
  }
  async function statementMember(signal: AbortSignal) {
    return z.object({ memberId: z.uuid() }).strict().parse(await owner('pair-statement', signal));
  }
  async function describeResource(input: z.infer<typeof PurchaseResourceLookup>, signal: AbortSignal) {
    const contract = PurchaseResourceContract.safeParse(await owner('describe-host-resource', signal, input));
    if (!contract.success || contract.data.resourceId !== input.resourceId) throw new Error('LOCAL_RESOURCE_LOOKUP_UNAVAILABLE');
    return contract.data;
  }
  async function purchase(input: HostPurchase, signal: AbortSignal, deliveryOffset?: number) {
    const plan = LocalHostPurchasePlan.parse(await owner('authorize-host-purchase', signal, deliveryOffset === undefined ? input : { ...input, existingOnly: true }));
    signal.throwIfAborted();
    const pay = new Client({ name: 'yosh-member-purchase', version: '1' });
    try {
      await pay.connect(new StdioClientTransport({ command: node, args: [launcher, 'install-mcp'],
        cwd: runtime, stderr: 'ignore', env: { ...env, YOSH_CARD_MEMBER_ID: plan.memberId, YOSH_INTERNAL_PURCHASE: '1' } }), { signal, timeout: 65_000 });
      return await executeHostPurchase(plan, input, (name, args, signal) =>
        pay.callTool({ name, arguments: args }, undefined, { signal, timeout: 150_000 }), signal, deliveryOffset);
    } finally { await pay.close(); }
  }
  return { statementMember, purchase, describeResource };
}
