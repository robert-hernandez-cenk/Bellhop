import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { ensureColumn, openDb } from '../../lib/sqlite.ts';
import { SESSION_MAX_AGE_MS } from '../login/session-store.ts';

// Persistence for Bellhop's MCP authorization server (#65/#66,
// data-model.md): registered clients, pending consents, authorization
// codes, grants and access tokens, in data/sessions.sqlite3 beside the web
// sessions a grant's identity lives in. Every token-like value is stored as
// its SHA-256 hex digest; the raw value exists only in the response that
// hands it out, so a leaked file cannot be replayed. Time comes from the
// injected clock (epoch ms) so tests drive expiry.

export const PENDING_TTL_MS = 10 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
// A registration nobody finished signing in with is dropped after a day,
// so anonymous /register calls cannot grow the table without bound.
export const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_clients (
    client_id TEXT PRIMARY KEY,
    info_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mcp_pending (
    id_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    state TEXT,
    scopes TEXT NOT NULL,
    resource TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mcp_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource TEXT,
    session_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mcp_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    session_hash TEXT NOT NULL,
    refresh_hash TEXT NOT NULL UNIQUE,
    resource TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mcp_access_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

export interface PendingInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
}

export interface PendingRecord extends PendingInput {
  createdAt: number;
}

export interface CodeInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  sessionHash: string;
}

export interface IssuedTokens {
  grantId: number;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface AccessRecord {
  grantId: number;
  clientId: string;
  sessionHash: string;
  resource?: string;
  expiresAt: number;
}

interface PendingRow {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scopes: string;
  resource: string | null;
  created_at: number;
}

interface CodeRow {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string | null;
  session_hash: string;
  created_at: number;
}

interface GrantRow {
  id: number;
  client_id: string;
  session_hash: string;
  resource: string | null;
}

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const newSecret = (): string => randomBytes(32).toString('base64url');

export class McpAuthStore {
  private readonly db: Database.Database;

  constructor(
    path: string,
    private readonly now: () => number = Date.now
  ) {
    this.db = openDb(path, SCHEMA);
    // Set once a client has signed in; only never-used registrations are
    // purged, since MCP clients cache and reuse their client_id.
    ensureColumn(this.db, 'mcp_clients', 'used', 'used INTEGER NOT NULL DEFAULT 0');
  }

  // --- clients ---------------------------------------------------------------

  saveClient(info: OAuthClientInformationFull): void {
    const now = this.now();
    this.db
      .prepare('DELETE FROM mcp_clients WHERE used = 0 AND created_at + ? <= ?')
      .run(UNUSED_CLIENT_TTL_MS, now);
    this.db
      .prepare('INSERT OR REPLACE INTO mcp_clients (client_id, info_json, created_at) VALUES (?, ?, ?)')
      .run(info.client_id, JSON.stringify(info), now);
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare('SELECT info_json FROM mcp_clients WHERE client_id = ?').get(clientId) as
      | { info_json: string }
      | undefined;
    return row ? (JSON.parse(row.info_json) as OAuthClientInformationFull) : undefined;
  }

  // --- pending consents --------------------------------------------------------

  // Returns the raw id (the consent form field and its cookie's value).
  createPending(input: PendingInput): string {
    const id = newSecret();
    const now = this.now();
    this.db.prepare('DELETE FROM mcp_pending WHERE created_at + ? <= ?').run(PENDING_TTL_MS, now);
    this.db
      .prepare(
        `INSERT INTO mcp_pending (id_hash, client_id, redirect_uri, code_challenge, state, scopes, resource, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sha256(id),
        input.clientId,
        input.redirectUri,
        input.codeChallenge,
        input.state ?? null,
        input.scopes.join(' '),
        input.resource ?? null,
        now
      );
    return id;
  }

  getPending(idHash: string): PendingRecord | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_pending WHERE id_hash = ?').get(idHash) as PendingRow | undefined;
    return row && this.now() < row.created_at + PENDING_TTL_MS ? toPending(row) : undefined;
  }

  // Approval restarts the clock, so the 10 minutes cover the Authentik
  // sign-in that follows rather than the time spent reading the page.
  touchPending(idHash: string): void {
    this.db.prepare('UPDATE mcp_pending SET created_at = ? WHERE id_hash = ?').run(this.now(), idHash);
  }

  // Read-and-delete in one transaction: a pending consent completes once.
  consumePending(idHash: string): PendingRecord | undefined {
    const take = this.db.transaction((): PendingRow | undefined => {
      const row = this.db.prepare('SELECT * FROM mcp_pending WHERE id_hash = ?').get(idHash) as PendingRow | undefined;
      if (row) this.db.prepare('DELETE FROM mcp_pending WHERE id_hash = ?').run(idHash);
      return row;
    });
    const row = take();
    return row && this.now() < row.created_at + PENDING_TTL_MS ? toPending(row) : undefined;
  }

  // --- authorization codes -----------------------------------------------------

  issueCode(input: CodeInput): string {
    const code = newSecret();
    const now = this.now();
    this.db.prepare('DELETE FROM mcp_codes WHERE created_at + ? <= ?').run(CODE_TTL_MS, now);
    this.db
      .prepare(
        `INSERT INTO mcp_codes (code_hash, client_id, redirect_uri, code_challenge, resource, session_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sha256(code), input.clientId, input.redirectUri, input.codeChallenge, input.resource ?? null, input.sessionHash, now);
    return code;
  }

  // For the SDK's local PKCE check, which runs before the exchange.
  peekCode(clientId: string, code: string): CodeInput | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_codes WHERE code_hash = ?').get(sha256(code)) as CodeRow | undefined;
    return this.liveCode(clientId, row);
  }

  consumeCode(clientId: string, code: string): CodeInput | undefined {
    const hash = sha256(code);
    const take = this.db.transaction((): CodeRow | undefined => {
      const row = this.db.prepare('SELECT * FROM mcp_codes WHERE code_hash = ?').get(hash) as CodeRow | undefined;
      if (row) this.db.prepare('DELETE FROM mcp_codes WHERE code_hash = ?').run(hash);
      return row;
    });
    return this.liveCode(clientId, take());
  }

  private liveCode(clientId: string, row: CodeRow | undefined): CodeInput | undefined {
    if (!row || row.client_id !== clientId || this.now() >= row.created_at + CODE_TTL_MS) return undefined;
    return {
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      ...(row.resource !== null ? { resource: row.resource } : {}),
      sessionHash: row.session_hash,
    };
  }

  // --- grants and tokens ---------------------------------------------------------

  createGrant(input: { clientId: string; sessionHash: string; resource?: string }): IssuedTokens {
    const refreshToken = newSecret();
    // A grant cannot outlive its sign-in (30 days); drop any that did, with
    // their access tokens, so dead rows don't accumulate.
    const cutoff = this.now() - SESSION_MAX_AGE_MS;
    this.db.prepare('DELETE FROM mcp_access_tokens WHERE grant_id IN (SELECT id FROM mcp_grants WHERE created_at <= ?)').run(cutoff);
    this.db.prepare('DELETE FROM mcp_grants WHERE created_at <= ?').run(cutoff);
    this.db.prepare('UPDATE mcp_clients SET used = 1 WHERE client_id = ?').run(input.clientId);
    const result = this.db
      .prepare('INSERT INTO mcp_grants (client_id, session_hash, refresh_hash, resource, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.clientId, input.sessionHash, sha256(refreshToken), input.resource ?? null, this.now());
    const grantId = Number(result.lastInsertRowid);
    return { grantId, refreshToken, ...this.issueAccess(grantId) };
  }

  // A live grant of this client, with a new refresh token in place of the
  // presented one (which stops working at once) and a new access token.
  rotateRefresh(clientId: string, refreshToken: string): (IssuedTokens & { sessionHash: string }) | undefined {
    const grant = this.db
      .prepare('SELECT id, client_id, session_hash, resource FROM mcp_grants WHERE refresh_hash = ?')
      .get(sha256(refreshToken)) as GrantRow | undefined;
    if (!grant || grant.client_id !== clientId) return undefined;
    const next = newSecret();
    this.db.prepare('UPDATE mcp_grants SET refresh_hash = ? WHERE id = ?').run(sha256(next), grant.id);
    return { grantId: grant.id, refreshToken: next, sessionHash: grant.session_hash, ...this.issueAccess(grant.id) };
  }

  private issueAccess(grantId: number): { accessToken: string; expiresInSeconds: number } {
    const accessToken = newSecret();
    const now = this.now();
    this.db.prepare('DELETE FROM mcp_access_tokens WHERE expires_at <= ?').run(now);
    this.db
      .prepare('INSERT INTO mcp_access_tokens (token_hash, grant_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(accessToken), grantId, now + ACCESS_TOKEN_TTL_MS);
    return { accessToken, expiresInSeconds: ACCESS_TOKEN_TTL_MS / 1000 };
  }

  resolveAccess(accessToken: string): AccessRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT t.grant_id, t.expires_at, g.client_id, g.session_hash, g.resource
           FROM mcp_access_tokens t JOIN mcp_grants g ON g.id = t.grant_id
          WHERE t.token_hash = ?`
      )
      .get(sha256(accessToken)) as
      | { grant_id: number; expires_at: number; client_id: string; session_hash: string; resource: string | null }
      | undefined;
    if (!row || this.now() >= row.expires_at) return undefined;
    return {
      grantId: row.grant_id,
      clientId: row.client_id,
      sessionHash: row.session_hash,
      ...(row.resource !== null ? { resource: row.resource } : {}),
      expiresAt: row.expires_at,
    };
  }

  // RFC 7009: a refresh token ends its grant (and every access token from
  // it); an access token ends only itself; anything else is ignored. Only
  // the presenting client's own tokens are touched. Returns the ended
  // grant's session hash, for the caller to end that sign-in too.
  revoke(clientId: string, token: string): string | undefined {
    const hash = sha256(token);
    const grant = this.db.prepare('SELECT id, client_id FROM mcp_grants WHERE refresh_hash = ?').get(hash) as
      | { id: number; client_id: string }
      | undefined;
    if (grant) {
      return grant.client_id === clientId ? this.deleteGrant(grant.id) : undefined;
    }
    this.db
      .prepare(
        `DELETE FROM mcp_access_tokens WHERE token_hash = ?
           AND grant_id IN (SELECT id FROM mcp_grants WHERE client_id = ?)`
      )
      .run(hash, clientId);
    return undefined;
  }

  // Ends a grant and its access tokens; returns the session hash it held
  // (undefined if there was no such grant), for the caller to delete that
  // sign-in -- the store does not own the sessions table.
  deleteGrant(grantId: number): string | undefined {
    return this.db.transaction((): string | undefined => {
      const row = this.db.prepare('SELECT session_hash FROM mcp_grants WHERE id = ?').get(grantId) as
        | { session_hash: string }
        | undefined;
      this.db.prepare('DELETE FROM mcp_access_tokens WHERE grant_id = ?').run(grantId);
      this.db.prepare('DELETE FROM mcp_grants WHERE id = ?').run(grantId);
      return row?.session_hash;
    })();
  }

  close(): void {
    this.db.close();
  }
}

function toPending(row: PendingRow): PendingRecord {
  return {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    ...(row.state !== null ? { state: row.state } : {}),
    scopes: row.scopes === '' ? [] : row.scopes.split(' '),
    ...(row.resource !== null ? { resource: row.resource } : {}),
    createdAt: row.created_at,
  };
}
