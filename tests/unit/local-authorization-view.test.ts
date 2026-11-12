import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { authorizationPage, authorizationScript } from '../../src/modules/authority/local-authorization-view';

// Small DOM boundary for the reported success-navigation regression. No browser
// or OS acceptance claim: this runs the real shipped script and API responses.
class Element {
  hidden = false; disabled = false; textContent = ''; value = ''; className = '';
  children: Element[] = []; handlers = new Map<string, () => Promise<void>>();
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
