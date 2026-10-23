import { createServer, type Server } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { assertLoopbackPortsAvailable } from '../../src/modules/pay-dev/port-availability';

const listeners: Server[] = [];
afterEach(async () => { for (const server of listeners.splice(0)) await new Promise<void>(done => server.close(() => done())); });
async function listener() {
  const server = createServer(); listeners.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_PORT_REQUIRED');
  return { server, port: address.port };
}

it('rejects an occupied candidate port while leaving its existing listener running', async () => {
  const existing = await listener();
  await expect(assertLoopbackPortsAvailable([existing.port])).rejects.toThrow('PAY_DEVELOPMENT_PORT_UNAVAILABLE');
  expect(existing.server.listening).toBe(true);
});

it('releases a successful probe so the real service can bind afterwards', async () => {
  const existing = await listener();
  const index = listeners.indexOf(existing.server); listeners.splice(index, 1);
  await new Promise<void>(done => existing.server.close(() => done()));
  await expect(assertLoopbackPortsAvailable([existing.port])).resolves.toBeUndefined();
  const service = createServer(); listeners.push(service);
  await new Promise<void>((done, reject) => { service.once('error', reject); service.listen(existing.port, '127.0.0.1', done); });
  expect(service.listening).toBe(true);
});

it('checks the complete configured port set and rejects duplicate or invalid ports', async () => {
  const first = await listener(); const second = await listener(); const third = await listener();
  listeners.splice(listeners.indexOf(first.server), 1); await new Promise<void>(done => first.server.close(() => done()));
  await expect(assertLoopbackPortsAvailable([first.port, second.port, third.port])).rejects.toThrow('PAY_DEVELOPMENT_PORT_UNAVAILABLE');
  expect(second.server.listening).toBe(true); expect(third.server.listening).toBe(true);
  await expect(assertLoopbackPortsAvailable([13149, 13149])).rejects.toThrow('PAY_DEVELOPMENT_PORT_CONFIGURATION_INVALID');
  await expect(assertLoopbackPortsAvailable([0])).rejects.toThrow('PAY_DEVELOPMENT_PORT_CONFIGURATION_INVALID');
});
