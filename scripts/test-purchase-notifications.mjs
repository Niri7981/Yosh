import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
const executable = process.argv[2];
assert.ok(executable, 'Pass the compiled PurchaseNotificationsTest executable');
const secret = 'notification-transport-fixture-token-12345';
const hash = b => createHash('sha256').update(b).digest('hex');
const server = createServer(async (request, response) => {
  assert.equal(request.url, '/api/app/notifications?after=17');
  assert.equal(request.method, 'GET');
  const chunks = [];
  for await (const b of request) chunks.push(b);
  const body = Buffer.concat(chunks);
  const nonce = request.headers['x-2049-nonce'];
  const message = ['2049-management-v1', 'GET', request.url, request.headers['x-2049-timestamp'], nonce, hash(body)].join('\n');
  assert.equal(request.headers['x-2049-proof'], createHmac('sha256', secret).update(message).digest('hex'));
  const bytes = Buffer.from(JSON.stringify({ storeId: 'a'.repeat(64), cursor: 18, events: [] }));
  response.writeHead(200, { 'content-type': 'application/json', 'x-2049-response-proof': createHmac('sha256', secret)
    .update(['2049-management-response-v1', nonce, '200', hash(bytes)].join('\n')).digest('hex') });
  response.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [`http://127.0.0.1:${server.address().port}`], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Native transport fixture exited ${code}`)));
  });
} finally { server.close(); }
