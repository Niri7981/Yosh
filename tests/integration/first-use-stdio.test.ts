import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('does not start the owner at discovery and cancels an outstanding owner request on stdio disconnect', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-first-use-stdio-')));
  const entry = join(root, 'first-use-mcp.cjs');
  const client = new Client({ name: 'independent-test-host', version: '1' });
  try {
    const args = ['--registration', randomUUID(), '--label', 'Independent reader'];
    await build({ plugins: [{ name: 'fixture-host-binding', setup(builder) {
      builder.onResolve({ filter: /\/installed-host$/ }, () => ({ path: 'host', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: 'export const resolveInstalledHost = () => (' + JSON.stringify({ registration: args[1], label: args[3] }) + ');',
      }));
    } }], entryPoints: [resolve('scripts/first-use-mcp.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs' });
    symlinkSync(process.execPath, join(root, 'node'));
    writeFileSync(join(root, 'mainnet.cjs'), `
      const fs = require('node:fs');
      process.once('SIGTERM', () => { fs.writeFileSync('disconnected', '1'); process.exit(0); });
      fs.writeFileSync('started', JSON.stringify(process.argv.slice(2)));
      setTimeout(() => process.exit(1), 5000);
    `);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, ...args], stderr: 'ignore' }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['list_account_purchases', 'describe_purchase_resource', 'request_purchase', 'recover_purchase_delivery']);
    expect(existsSync(join(root, 'started'))).toBe(false);
    const pending = client.callTool({ name: 'list_account_purchases', arguments: {} }).catch(() => undefined);
    await expect.poll(() => existsSync(join(root, 'started'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'started'), 'utf8'))).toEqual(['pair-statement', ...args]);
    await client.close();
    await pending;
    await expect.poll(() => existsSync(join(root, 'disconnected'))).toBe(true);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
