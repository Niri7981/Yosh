import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { z } from 'zod';

/** Real Codex host, no model turn, account login, or purchase invocation. */
export function codexHost(executable: string, home: string, cwd: string, overrides: string[] = [], env = process.env) {
  const child = spawn(executable, ['app-server', '--stdio', ...overrides.flatMap(value => ['-c', value])], {
    cwd, env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.unknown().optional() }).passthrough().safeParse(JSON.parse(line));
    if (!message.success || message.data.id === undefined) return;
    const entry = pending.get(message.data.id);
    if (!entry) return;
    pending.delete(message.data.id);
    if (message.data.error) {
      const code = z.object({ code: z.number() }).safeParse(message.data.error);
      entry.reject(new Error(`CODEX_HOST_REQUEST_FAILED: ${entry.method} (${code.success ? code.data.code : 'unknown'})`));
    }
    else entry.resolve(message.data.result);
  });
  child.on('error', () => { for (const entry of pending.values()) entry.reject(new Error('CODEX_HOST_UNAVAILABLE')); });
  child.on('exit', () => { for (const entry of pending.values()) entry.reject(new Error('CODEX_HOST_EXITED')); pending.clear(); });
  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ method })}\n`);
  const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CODEX_HOST_TIMEOUT: ${method}`)); }, 35_000);
    pending.set(id, { method, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  return { child, request, notify, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 5_000);
    try { await exited; } finally { clearTimeout(timer); lines.close(); }
  } };
}
