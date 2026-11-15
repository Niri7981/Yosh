import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { authorizationPage, authorizationScript } from '../../src/modules/authority/local-authorization-view';

// Small DOM boundary for the reported success-navigation regression. No browser
// or OS acceptance claim: this runs the real shipped script and API responses.
class Element {
  hidden = false; disabled = false; textContent = ''; value = ''; className = '';
  open = false;
  showModal() { this.open = true; }
  close() { this.open = false; }
  children: Element[] = []; handlers = new Map<string, () => Promise<void>>();
  attributes = new Map<string, string>();
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  addEventListener(event: string, handler: () => Promise<void>) { this.handlers.set(event, handler); }
  focus() {}
}
it('retains the committed grant result instead of reopening its creation form; explicit new action is required', async () => {
  const elements = new Map([...authorizationPage.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const calls: string[] = [];
  const state = { environment: 'offline', member: { label: 'Codex' }, budget: { paused: true, remaining: null },
    connection: { enabled: true, state: 'reconnect_required' }, grants: [], wallets: [], purchases: [],
    resources: [{ resourceId: 'api', displayName: 'Test' }] };
  const context = { document: { getElementById: (id: string) => elements.get(id), querySelectorAll: () => [], createElement: () => new Element() },
    URLSearchParams, location: { hash: '', search: '' }, history: { replaceState() {} }, fetch: async (path: string) => {
      calls.push(path); return { ok: true, json: async () => state };
    } };
  runInNewContext(authorizationScript, context);
  await runInNewContext("completed({state:'CONSUMED',grantId:'original-grant'})", context);
  expect(elements.get('editor')!.hidden).toBe(true);
  expect(elements.get('review')!.hidden).toBe(true);
  expect(elements.get('success')!.hidden).toBe(false);
  expect(elements.get('success-facts')!.children.some(child => child.textContent === 'original-grant')).toBe(true);
  expect(calls).toEqual(['/state']);
  await elements.get('new-grant')!.handlers.get('click')!();
  expect(elements.get('editor')!.hidden).toBe(false);
  expect(elements.get('success')!.hidden).toBe(true);
  expect(calls).toEqual(['/state', '/state']);
});

function activityHarness(environment = 'mainnet') {
  const elements = new Map([...authorizationPage.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const calls: string[] = [];
  const state = { environment, member: { id: 'codex', label: 'Codex' }, budget: { paused: true, remaining: null },
    connection: { enabled: true, state: 'connected' }, grants: [], wallets: [], resources: [], purchases: [] };
  const context = { document: { getElementById: (id: string) => elements.get(id), querySelectorAll: () => [],
    createElement: () => new Element(), createElementNS: () => new Element() },
    URLSearchParams, location: { hash: '', search: '' }, history: { replaceState() {} },
    fetch: async (path: string) => { calls.push(path); return { ok: true, json: async (): Promise<unknown> => state }; } };
  runInNewContext(authorizationScript, context);
  return { elements, calls, context };
}
function descendants(element: Element): Element[] { return [element, ...element.children.flatMap(descendants)]; }
const activityPurchase = { purchaseId: 'original-purchase', resourceId: 'plugin-resource-with-a-very-long-name-snapshot',
  amount: '1000', paymentStatus: 'PAID', deliveryStatus: 'COMPLETE' };
function activityState(purchase: Record<string, unknown>, environment = 'mainnet') {
  return { environment, member: { id: 'codex', label: 'Codex' }, resources: [], purchases: [purchase] };
}

it('opens complete long identifiers as text, returns to the list, and never requests payment or recovery', async () => {
  const { elements, calls, context } = activityHarness();
  const purchase = { ...activityPurchase, resourceId: '<img src=x onerror=alert(1)>' + activityPurchase.resourceId };
  runInNewContext(`renderActivity(${JSON.stringify(activityState(purchase))})`, context);
  const row = descendants(elements.get('purchase-list')!).find(node => node.className === 'activity-row')!;
  await row.handlers.get('click')!();
  const detail = descendants(elements.get('activity-detail')!);
  expect(detail.some(node => node.textContent === purchase.resourceId)).toBe(true);
  expect(detail.some(node => node.textContent === purchase.purchaseId)).toBe(true);
  expect(detail.filter(node => node.textContent === '已交付')).toHaveLength(2);
  expect(detail.some(node => node.textContent === '0.001')).toBe(true);
  expect(elements.get('activity-list-view')!.hidden).toBe(true);
  await detail.find(node => node.className === 'activity-back')!.handlers.get('click')!();
  expect(elements.get('activity-detail')!.hidden).toBe(true);
  expect(calls).toEqual([]);
});

it.each([
  ['PAYMENT_UNKNOWN', 'COMPLETE', 'mainnet', '核对原付款'],
  ['PAID', 'EXHAUSTED', 'mainnet', '已付款 · 未取回结果'],
  ['PAID', 'PENDING', 'mainnet', '已付款 · 交付中'],
  ['APPROVED', 'NOT_PAID', 'mainnet', '已允许'],
  ['PAID', 'COMPLETE', 'offline', '模拟完成'],
])('keeps %s / %s in %s distinct from a completed live purchase', (paymentStatus, deliveryStatus, environment, label) => {
  const { elements, context } = activityHarness(environment);
  runInNewContext(`renderActivity(${JSON.stringify(activityState({ ...activityPurchase, paymentStatus, deliveryStatus }, environment))})`, context);
  const rows = descendants(elements.get('purchase-list')!);
  expect(rows.find(node => node.className === 'activity-badge')!.textContent).toBe(label);
  expect(rows.some(node => node.textContent === '已交付')).toBe(false);
});

it('clears the selected detail when networks change even if both networks contain the same purchase id', async () => {
  const { elements, context } = activityHarness();
  runInNewContext(`renderActivity(${JSON.stringify(activityState(activityPurchase))})`, context);
  await descendants(elements.get('purchase-list')!).find(node => node.className === 'activity-row')!.handlers.get('click')!();
  runInNewContext(`renderActivity(${JSON.stringify(activityState(activityPurchase, 'devnet'))})`, context);
  expect(elements.get('activity-detail')!.hidden).toBe(true);
  expect(elements.get('activity-list-view')!.hidden).toBe(false);
});

it('does not label an explicitly different asset as USDC or invent a purchase time', () => {
  const { elements, context } = activityHarness();
  runInNewContext(`renderActivity(${JSON.stringify(activityState({ ...activityPurchase, assetId: 'another-asset', assetDecimals: 9, network: 'another-network' }))})`, context);
  const rows = descendants(elements.get('purchase-list')!);
  expect(rows.find(node => node.className === 'activity-unit')!.textContent).toBe('资产单位');
  expect(rows.some(node => node.textContent.includes('今天'))).toBe(false);
});

it('clears test amounts and hides all prior scope data when mainnet is unavailable, then reloads devnet', async () => {
  const elements = new Map([...authorizationPage.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const calls: { path: string; network?: string }[] = [];
  const state = { environment: 'devnet', member: { label: 'Codex' }, budget: { paused: true, remaining: '1000' },
    connection: { enabled: true, state: 'connected' }, grants: [], wallets: [], purchases: [],
    resources: [{ resourceId: 'test-api', displayName: 'Test' }] };
  const context = { document: { getElementById: (id: string) => elements.get(id), querySelectorAll: () => [], createElement: () => new Element() },
    URLSearchParams, location: { hash: '', search: '' }, history: { replaceState() {} }, fetch: async (path: string, options: { headers: Record<string, string> }) => {
      const network = options.headers['x-yosh-environment']; calls.push({ path, network });
      return { ok: network !== 'mainnet', json: async () => network === 'mainnet' ? { code: 'LOCAL_WEB_ENVIRONMENT_UNAVAILABLE' } : state };
    } };
  runInNewContext(authorizationScript, context);
  await runInNewContext('refresh(true)', context);
  elements.get('total')!.value = '100';
  elements.get('environment')!.value = 'mainnet';
  await elements.get('environment')!.handlers.get('change')!();
  expect(elements.get('network-content')!.hidden).toBe(true);
  expect(elements.get('total')!.value).toBe('');
  expect(elements.get('environment-notice')!.textContent).toContain('尚未接通');
  expect(calls.at(-1)).toEqual({ path: '/state', network: 'mainnet' });
  elements.get('environment')!.value = 'devnet';
  await elements.get('environment')!.handlers.get('change')!();
  expect(elements.get('network-content')!.hidden).toBe(false);
  expect(elements.get('editor')!.hidden).toBe(false);
  expect(elements.get('grant-environment')!.textContent).toBe('Devnet · Test USDC');
  expect(elements.get('total')!.value).toBe('');
});

it.each(['mainnet', 'devnet', ''])('first page load reads only the explicitly selected network %s', async network => {
  const elements = new Map([...authorizationPage.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const calls: { path: string; network?: string }[] = [];
  const state = { environment: network, member: { label: 'Codex' }, budget: { paused: true, remaining: null },
    connection: { enabled: true, state: 'connected' }, grants: [], wallets: [], purchases: [], resources: [] };
  const context = { URLSearchParams, document: { getElementById: (id: string) => elements.get(id), querySelectorAll: () => [], createElement: () => new Element() },
    location: { hash: '#' + 'a'.repeat(64), search: network ? '?environment=' + network : '' }, history: { replaceState() {} },
    fetch: async (path: string, options: { headers: Record<string, string> }) => {
      calls.push({ path, network: options.headers['x-yosh-environment'] });
      return { ok: true, json: async () => path === '/session' ? { token: 'b'.repeat(64) } : state };
    } };
  runInNewContext(authorizationScript, context);
  await new Promise(resolve => setImmediate(resolve));
  expect(calls.filter(call => call.path === '/state')).toEqual(network ? [{ path: '/state', network }] : []);
  if (!network) expect(elements.get('status')!.textContent).toContain('选择');
});


it('opens the secondary editor explicitly, preserves pending review, and blocks dismissal during confirmation', async () => {
  const { elements, calls, context } = activityHarness();
  const dialog = elements.get('grant-dialog')!;
  elements.get('review')!.hidden = true;
  elements.get('success')!.hidden = true;
  expect(dialog.open).toBe(false);
  await elements.get('open-grant')!.handlers.get('click')!();
  expect(dialog.open).toBe(true);
  expect(calls).toEqual([]);
  runInNewContext('awaiting=true', context);
  await elements.get('close-dialog')!.handlers.get('click')!();
  expect(dialog.open).toBe(true);
  runInNewContext('awaiting=false', context);
  await elements.get('close-dialog')!.handlers.get('click')!();
  expect(dialog.open).toBe(false);
  elements.get('editor')!.hidden = true;
  elements.get('review')!.hidden = false;
  runInNewContext("requestId='original-review'", context);
  await elements.get('open-grant')!.handlers.get('click')!();
  expect(dialog.open).toBe(true);
  expect(elements.get('editor')!.hidden).toBe(true);
  expect(elements.get('review')!.hidden).toBe(false);
  expect(runInNewContext('requestId', context)).toBe('original-review');
  expect(calls).toEqual([]);
});

it('keeps the current network and draft when reselecting it or when pending-request cancellation fails', async () => {
  const { elements, calls, context } = activityHarness();
  await runInNewContext('refresh(true)', context);
  elements.get('total')!.value = '12';
  await elements.get('network-mainnet')!.handlers.get('click')!();
  expect(calls).toEqual(['/state']);
  expect(elements.get('total')!.value).toBe('12');
  runInNewContext("requestId='pending-original'; requestPrefix='';", context);
  context.fetch = async (path: string) => {
    calls.push(path);
    return { ok: false, json: async () => ({ code: 'LOCAL_CONFIRMATION_BUSY' }) };
  };
  await elements.get('network-devnet')!.handlers.get('click')!();
  expect(calls).toEqual(['/state', '/cancel']);
  expect(elements.get('environment')!.value).toBe('mainnet');
  expect(elements.get('network-mainnet')!.attributes.get('aria-pressed')).toBe('true');
  expect(elements.get('network-devnet')!.attributes.get('aria-pressed')).toBe('false');
  expect(elements.get('network-content')!.hidden).toBe(false);
  expect(elements.get('total')!.value).toBe('12');
  expect(elements.get('network-mainnet')!.disabled).toBe(false);
});

it.each(['access_denied_or_locked', 'identity_conflict', 'restore_required'])('does not present a wallet with %s as ready just because an address exists', provisioningState => {
  const { elements, calls, context } = activityHarness();
  const state = { wallets: [{ id: 'devnet', status: 'available', address: 'test-address', provisioningState },
    { id: 'mainnet', status: 'available', address: 'other-network' }] };
  runInNewContext(`currentEnvironment='devnet';renderWallets(${JSON.stringify(state)})`, context);
  const nodes = descendants(elements.get('wallet-list')!);
  expect(nodes.find(node => node.className === 'wallet-state')!.textContent).toBe('待核对');
  expect(nodes.some(node => node.textContent === 'other-network')).toBe(false);
  expect(nodes.some(node => node.textContent === 'test-address')).toBe(true);
  expect(calls).toEqual([]);
});
