import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { requireLocalRequest } from '../http/local-request';
import { SpendPrincipalSchema, type SpendPrincipal } from '../authority/spend-grant';
import { McpSessions, type McpSessionEvent } from './session';

const CapabilitySchema = z.enum(['read', 'request_purchase', 'read_statement']);
const agentCapabilities: Array<z.infer<typeof CapabilitySchema>> = ['read', 'request_purchase'];

export const ConnectionSchema = z.object({
  origin: z.string().refine(value => {
    try { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === value; }
    catch { return false; }
  }),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  cardMemberId: z.string().uuid(),
  connectionId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  capabilities: z.array(CapabilitySchema).min(1),
}).strict();
export const connectionFile = (directory: string, memberId?: string) => memberId
  ? join(directory, 'members', memberId, 'mcp-connection.json')
  : join(directory, 'mcp-connection.json');

/** Agent capabilities never expose management operations, keys or arbitrary signing. */
export class AgentConnection {
  private descriptor?: z.infer<typeof ConnectionSchema>;
  private lastSeen: number | null = null;
  private sessions: McpSessions;
  private integration?: { provider: 'codex'; configured: boolean; serverName: string };
  constructor(private directory: string, private cardMemberId: string, private isCardMemberActive: (id: string) => boolean,
    private memberFile = false, now: () => number = Date.now) {
    this.sessions = new McpSessions(now);
    // The descriptor is an installation capability, not a process capability.
    // Keep it across a normal restart; host-session liveness starts empty.
    try {
      const file = this.file();
      const metadata = lstatSync(file);
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) return;
      const saved = ConnectionSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      if (saved.cardMemberId === this.cardMemberId && isCardMemberActive(this.cardMemberId)) this.descriptor = saved;
    } catch { /* Missing or invalid descriptors grant no access. */ }
  }
  private file() { return connectionFile(this.directory, this.memberFile ? this.cardMemberId : undefined); }
  private removeFile() {
    try { unlinkSync(this.file()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private write(descriptor: z.infer<typeof ConnectionSchema>) {
    const parsed = ConnectionSchema.parse(descriptor);
    mkdirSync(this.memberFile ? join(this.directory, 'members', this.cardMemberId) : this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file()}.tmp`;
    writeFileSync(temporary, JSON.stringify(parsed), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file());
    this.descriptor = parsed;
    this.lastSeen = null;
    this.sessions.clear();
  }
  setEnabled(enabled: boolean, origin: string, statementOnly = false) {
    if (!enabled) { this.descriptor = undefined; this.lastSeen = null; this.sessions.clear(); this.removeFile(); return; }
    if (!this.isCardMemberActive(this.cardMemberId)) throw new Error('CARD_MEMBER_REVOKED');
    const token = randomBytes(32).toString('base64url');
    this.write({ origin, token, cardMemberId: this.cardMemberId, connectionId: randomUUID(), generation: 1, capabilities: statementOnly ? ['read_statement'] : [...agentCapabilities] });
  }
  enableLocalScope(origin: string, principal: SpendPrincipal, scope: 'read_statement' | 'request_purchase') {
    if (principal.cardMemberId !== this.cardMemberId || !this.isCardMemberActive(this.cardMemberId))
      throw new Error('LOCAL_AUTHORIZATION_AGENT_CHANGED');
    const current = this.descriptor;
    if (current && (current.connectionId !== principal.connectionId || current.generation !== principal.connectionGeneration
      || current.origin !== origin || current.capabilities.includes('read'))) throw new Error('LOCAL_AUTHORIZATION_AGENT_CHANGED');
    if (current?.capabilities.includes(scope)) return;
    this.write({ origin, token: randomBytes(32).toString('base64url'), cardMemberId: this.cardMemberId,
      connectionId: principal.connectionId, generation: principal.connectionGeneration,
      capabilities: [...current?.capabilities ?? [], scope] });
  }

  /** Explicit credential rotation invalidates the old token and live session. */
  rotateCredential(): SpendPrincipal | undefined {
    if (!this.descriptor) return undefined;
    if (!this.isCardMemberActive(this.descriptor.cardMemberId)) throw new Error('CARD_MEMBER_REVOKED');
    const next: z.infer<typeof ConnectionSchema> = { ...this.descriptor, token: randomBytes(32).toString('base64url'), generation: this.descriptor.generation + 1 };
    this.write(next);
    return SpendPrincipalSchema.parse({ cardMemberId: next.cardMemberId, connectionId: next.connectionId, connectionGeneration: next.generation });
  }
  principal(capability: z.infer<typeof CapabilitySchema>): SpendPrincipal | undefined {
    const value = this.descriptor;
    if (!value?.capabilities.includes(capability)) return undefined;
    if (!this.isCardMemberActive(value.cardMemberId)) return undefined;
    return { cardMemberId: value.cardMemberId, connectionId: value.connectionId, connectionGeneration: value.generation };
  }
  authenticate(request: Request, capability: z.infer<typeof CapabilitySchema> = 'read') {
    requireLocalRequest(request);
    if (request.headers.has('origin')) throw new Error('AGENT_UNAUTHORIZED');
    const actual = Buffer.from(request.headers.get('authorization') ?? '');
    const token = this.descriptor?.token;
    const expected = Buffer.from(`Bearer ${token ?? ''}`);
    if (!token || !(this.descriptor?.capabilities.includes(capability) || (capability === 'read_statement' && this.descriptor?.capabilities.includes('read'))) || !this.isCardMemberActive(this.descriptor.cardMemberId)
      || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('AGENT_UNAUTHORIZED');
    this.lastSeen = Date.now();
    return { cardMemberId: this.descriptor.cardMemberId, connectionId: this.descriptor.connectionId, connectionGeneration: this.descriptor.generation };
  }
  status() {
    const enabled = Boolean(this.descriptor && this.isCardMemberActive(this.descriptor.cardMemberId));
    const capabilities = enabled ? this.descriptor?.capabilities ?? [] : [];
    const liveness = this.sessions.status();
    return { enabled, lastSeen: this.lastSeen, access: capabilities.includes('request_purchase') ? 'purchase_intent' as const : 'read_only' as const, capabilities,
      ...(this.integration ? { integration: { ...this.integration, ...liveness,
        state: !enabled ? 'disconnected' as const : liveness.connected ? 'connected' as const : 'reconnect_required' as const } } : {}) };
  }
  setIntegration(configured: boolean, serverName: string) {
    this.integration = { provider: 'codex', configured, serverName };
    if (!configured) this.sessions.clear();
  }
  observeSession(event: McpSessionEvent) {
    if (!this.descriptor || !this.integration?.configured || this.integration.provider !== event.provider
      || !this.isCardMemberActive(this.cardMemberId)) throw new Error('MCP_INTEGRATION_UNAVAILABLE');
    this.sessions.observe(event);
  }
}

export function readConnection(directory: string, memberId?: string) {
  if (memberId) z.string().uuid().parse(memberId);
  let raw: string;
  try { raw = readFileSync(connectionFile(directory, memberId), 'utf8'); }
  catch (error) {
    if (!memberId || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // The original default-member file remains compatible with existing generic hosts.
    raw = readFileSync(connectionFile(directory), 'utf8');
  }
  const connection = ConnectionSchema.parse(JSON.parse(raw));
  if (memberId && connection.cardMemberId !== memberId) throw new Error('MCP_MEMBER_MISMATCH');
  return connection;
}
