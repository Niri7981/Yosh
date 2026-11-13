import { buildSync } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { z } from 'zod';

it('uses its own Mainnet entry and rechecks readiness before cached-client dispatch without an App', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'yosh-mainnet-transport-')));
  const directory = join(root, 'data'); mkdirSync(directory);
  symlinkSync(process.execPath, join(root, 'node'));
  writeFileSync(join(root, 'standalone.cjs'), 'console.log(JSON.stringify({enabled:false,connectionState:"disconnected",paused:true}));');
  const marker = join(root, 'reject-start');
  writeFileSync(join(root, 'mainnet.cjs'), `
const fs = require('node:fs'), path = require('node:path');
const action = process.argv[2], log = path.join(__dirname, 'calls.jsonl');
const record = value => fs.appendFileSync(log, JSON.stringify(value) + '\\n');
record({action, cwd:process.cwd(), app:process.env.YOSH_MAINNET_APP ?? null});
if (action === 'start') {
  if (fs.existsSync(path.join(__dirname, 'reject-start'))) process.exit(1);
  console.log(JSON.stringify({running:true}));
} else if (action === 'install-mcp') {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const message = JSON.parse(line); if (message.id === undefined) return;
    let result;
    if (message.method === 'initialize') result = {protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else if (message.method === 'tools/list') result = {tools:[{name:'get_spending_status',inputSchema:{type:'object',properties:{}}}]};
    else if (message.method === 'tools/call') {
      record({action:'tool',arguments:message.params.arguments});
      result = {content:[{type:'text',text:JSON.stringify({environment:'mainnet',fixture:true})}]};
    } else result = {};
    console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });
} else process.exit(2);
`);
  buildSync({ entryPoints: [resolve('scripts/local-plugin-mcp.ts')], bundle: true, platform: 'node', format: 'cjs',
    define: { __YOSH_LOCAL_AUTH_DEV__: 'true', __YOSH_PLUGIN_DEV__: 'true', __YOSH_STANDALONE_DEV__: 'true', __YOSH_RC5__: 'false' },
    outfile: join(root, 'local-mcp.cjs') });
  const client = new Client({ name: 'mainnet-transport-test', version: '1' });
  const calls = () => readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n')
    .map(line => z.object({ action: z.string(), cwd: z.string().optional(), app: z.null().optional(), arguments: z.record(z.string(), z.unknown()).optional() }).parse(JSON.parse(line)));
  const count = (action: string) => calls().filter(call => call.action === action).length;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(root, 'local-mcp.cjs'), '--data-dir', directory], cwd: root, stderr: 'pipe',
      env: { HOME: directory, PATH: '/usr/bin:/bin', NODE_ENV: 'test', YOSH_MAINNET_APP: '/Applications/forbidden.app' } }));
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === 'get_spending_status')?.inputSchema.properties?.environment).toMatchObject({ enum: ['mainnet'] });
    expect(count('install-mcp')).toBe(1);
    const firstStarts = count('start');
    const result = await client.callTool({ name: 'get_spending_status', arguments: { environment: 'mainnet' } });
    expect(result.isError).not.toBe(true);
    expect(count('start')).toBeGreaterThan(firstStarts);
    expect(calls().filter(call => call.action === 'tool')).toEqual([{ action: 'tool', arguments: {} }]);
    expect(calls().filter(call => call.action !== 'tool').every(call => call.cwd === root && call.app === null)).toBe(true);
    writeFileSync(marker, 'fixture refuses readiness');
    const rejected = await client.callTool({ name: 'get_spending_status', arguments: { environment: 'mainnet' } });
    expect(rejected.isError).toBe(true);
    expect(count('tool')).toBe(1);
    rmSync(marker);
    expect((await client.callTool({ name: 'get_spending_status', arguments: { environment: 'mainnet' } })).isError).not.toBe(true);
    expect(count('install-mcp')).toBe(1);
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});
