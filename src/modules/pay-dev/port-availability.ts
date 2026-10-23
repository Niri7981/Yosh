import { createServer } from 'node:net';

/** Probe without contacting or stopping an existing listener. The real service
 * bind remains authoritative if another process claims a port after this check. */
export async function assertLoopbackPortsAvailable(ports: readonly number[]) {
  if (new Set(ports).size !== ports.length
    || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535))
    throw new Error('PAY_DEVELOPMENT_PORT_CONFIGURATION_INVALID');
  for (const port of ports) {
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(new Error('PAY_DEVELOPMENT_PORT_UNAVAILABLE')));
      probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        probe.close(error => error ? reject(new Error('PAY_DEVELOPMENT_PORT_UNAVAILABLE')) : resolve());
      });
    });
  }
}
