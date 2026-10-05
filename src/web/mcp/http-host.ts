import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer, type McpDeps, type McpServerOptions } from '../../mcp/build-server.ts';
import { PromptTracker } from '../../mcp/elicitation.ts';

// The MCP server over Streamable HTTP, inside the web service (#65/#66,
// research R8). Every MCP session (Mcp-Session-Id) gets its own McpServer,
// so elicitation and the oninitialized ping workaround work per session,
// while all of them share the web service's JobRunner (jobs are owned by
// 'web' and outlive the client) and one PromptTracker (one dialog per
// prompt across sessions, FR-005). Authentication happens before this:
// handle() is given the request's already-verified principal, and a session
// only ever answers the principal that opened it (FR-003).

export const MCP_SESSION_IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// `id` is what a session is bound to ('api-key', or 'grant:<n>' for a
// signed-in client); `username` is what jobs record.
export interface McpPrincipal {
  id: string;
  username: string;
}

interface HostedSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  principal: string;
  // The server's actor, updated on every request so jobs record the
  // identity's current username (a rename lands on the next re-check).
  actor: { username: string };
  lastSeen: number;
  // Requests still being answered; the idle sweep never closes a session
  // with one in flight (a long wait_for_job).
  active: number;
}

export interface McpHttpHostOptions {
  deps: McpDeps;
  serverOptions?: Omit<McpServerOptions, 'actor' | 'tracker' | 'transport'>;
  // Test-only clock for the idle sweep.
  now?: () => number;
}

export class McpHttpHost {
  private readonly sessions = new Map<string, HostedSession>();
  private readonly tracker: PromptTracker;
  private readonly now: () => number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly options: McpHttpHostOptions) {
    this.tracker = new PromptTracker(options.deps.jobRunner.events);
    this.now = options.now ?? Date.now;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Never holds the web service open on its own.
    this.sweeper.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  async handle(req: Request, res: Response, principal: McpPrincipal): Promise<void> {
    const header = req.headers['mcp-session-id'];
    const sessionId = typeof header === 'string' ? header : undefined;
    if (sessionId !== undefined) {
      const session = this.sessions.get(sessionId);
      // 404 is what makes a client start a new session (the transport's own
      // convention for an unknown or expired id).
      // 404 is what makes a client start a new session (the transport's own
      // convention for an unknown or expired id). Another caller's session
      // answers the same: after a re-authorization the same person holds a
      // new grant, and 404 lets the client recover by re-initializing.
      if (!session || session.principal !== principal.id) return sendError(res, 404, -32001, 'Session not found');
      session.actor.username = principal.username;
      this.track(session, req, res);
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      return sendError(res, 400, -32000, 'No MCP session: send an initialize request first');
    }

    const actor = { username: principal.username };
    const server = buildMcpServer(this.options.deps, {
      ...this.options.serverOptions,
      actor,
      tracker: this.tracker,
      transport: 'http',
    });
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, server, principal: principal.id, actor, lastSeen: this.now(), active: 0 });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) this.sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  // Counts a request in flight until its response closes, and idleness from
  // then. A POST whose response closes before it finished means the client
  // dropped the connection without a DELETE (killed, network gone): its
  // requests are cancelled as if the client had sent notifications/cancelled,
  // so a wait_for_job it left behind withdraws its dialog and releases the
  // shared prompt claim instead of holding it until the dialog times out.
  // Only POSTs carry requests: a GET is the client's long-lived listening
  // stream and must not keep the session from ever going idle.
  private track(session: HostedSession, req: Request, res: Response): void {
    session.lastSeen = this.now();
    if (req.method !== 'POST') return;
    session.active++;
    session.lastSeen = this.now();
    res.on('close', () => {
      session.active--;
      session.lastSeen = this.now();
      if (res.writableFinished) return;
      const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
      for (const message of messages) {
        const m = message as { id?: unknown; method?: unknown };
        if ((typeof m.id === 'string' || typeof m.id === 'number') && typeof m.method === 'string') {
          session.transport.onmessage?.({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: m.id, reason: 'The MCP client disconnected' },
          });
        }
      }
    });
  }

  // Closes every session idle for MCP_SESSION_IDLE_MS with nothing in flight
  // (FR-006). Cancelling nothing: the jobs belong to the web runner, not to
  // the session.
  sweep(): void {
    const cutoff = this.now() - MCP_SESSION_IDLE_MS;
    for (const [id, session] of this.sessions) {
      if (session.active === 0 && session.lastSeen <= cutoff) {
        this.sessions.delete(id);
        void session.server.close();
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    const open = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(open.map((session) => session.server.close()));
  }
}

function sendError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}
