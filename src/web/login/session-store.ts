import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { ensureColumn, openDb } from '../../lib/sqlite.ts';

// Server-side state for Bellhop's own web login (#69; data-model.md,
// research R3): signed-in sessions and pending sign-in attempts, in
// data/sessions.sqlite3 -- a file of its own so inventory/bellhop.db's
// full-replace writer never sees it. The browser holds only an opaque random
// id; the row key is that id's SHA-256, so a leaked copy of the database
// cannot be replayed as a cookie. All time comes from the injected `now`
// (epoch ms), so tests drive expiry with a fake clock.

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const ATTEMPT_MAX_AGE_MS = 10 * 60 * 1000;
// A session's identity is re-checked with the provider at most this often...
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;
// ...and, after a re-check that could not reach the provider, not again for this long.
export const CHECK_RETRY_MS = 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    uid TEXT NOT NULL,
    email TEXT,
    groups_json TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    id_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_checked_at INTEGER NOT NULL,
    last_attempt_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS login_attempts (
    id_hash TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    nonce TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    return_to TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

export interface SessionIdentity {
  username: string;
  uid: string;
  email: string | null;
  groups: string[];
  refreshToken: string;
  idToken: string;
}

export interface SessionRecord extends SessionIdentity {
  createdAt: number;
  lastCheckedAt: number;
  lastAttemptAt: number | null;
}

// What a successful re-check writes back. `uid` and `createdAt` are never
// updated (a changed `sub` is a refusal, handled by deleting the session);
// `idToken` is optional because a refresh response may omit a new one, in
// which case the previous one is kept for the sign-out hint.
export interface SessionRefresh {
  username: string;
  email: string | null;
  groups: string[];
  refreshToken: string;
  idToken?: string;
}

export interface LoginAttemptInput {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  // Set when MCP consent started this sign-in (#65/#66): the pending
  // authorization's hash, so the callback finishes that instead of setting
  // a browser session cookie.
  mcpPendingHash?: string;
}

export interface LoginAttemptRecord extends LoginAttemptInput {
  createdAt: number;
}

interface SessionRow {
  username: string;
  uid: string;
  email: string | null;
  groups_json: string;
  refresh_token: string;
  id_token: string;
  created_at: number;
  last_checked_at: number;
  last_attempt_at: number | null;
}

interface AttemptRow {
  state: string;
  nonce: string;
  code_verifier: string;
  return_to: string;
  created_at: number;
  mcp_pending_hash: string | null;
}

// Exported for SessionService's single-flight map, keyed like the table.
export const hashId = (id: string): string => createHash('sha256').update(id).digest('hex');
const newId = (): string => randomBytes(32).toString('base64url');

export class SessionStore {
  private readonly db: Database.Database;

  // `path` is a file under data/ or ':memory:'. Expired rows are purged on open.
  constructor(
    path: string,
    private readonly now: () => number = Date.now
  ) {
    this.db = openDb(path, SCHEMA);
    ensureColumn(this.db, 'login_attempts', 'mcp_pending_hash', 'mcp_pending_hash TEXT');
    this.purgeExpired();
  }

  // Stores a new session and returns the raw cookie value -- the only time it
  // exists server-side. Purges expired rows first so the table does not grow
  // without bound on a long-running service.
  createSession(identity: SessionIdentity): string {
    this.purgeExpired();
    const id = newId();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id_hash, username, uid, email, groups_json, refresh_token, id_token, created_at, last_checked_at, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        hashId(id),
        identity.username,
        identity.uid,
        identity.email,
        JSON.stringify(identity.groups),
        identity.refreshToken,
        identity.idToken,
        now,
        now
      );
    return id;
  }

  // The session for a raw cookie value, or undefined if unknown or past its
  // 30 days (in which case the row is deleted on the spot).
  getSession(id: string): SessionRecord | undefined {
    if (id === '') return undefined;
    return this.getSessionByHash(hashId(id));
  }

  // The same, by the stored key. An MCP grant (#65/#66) holds only this
  // hash, never the raw id, so a leaked database cannot be replayed as a
  // cookie. Every cookie-keyed method below is a wrapper over its ByHash twin.
  getSessionByHash(idHash: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined;
    if (!row) return undefined;
    if (this.now() >= row.created_at + SESSION_MAX_AGE_MS) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
      return undefined;
    }
    return {
      username: row.username,
      uid: row.uid,
      email: row.email,
      groups: JSON.parse(row.groups_json) as string[],
      refreshToken: row.refresh_token,
      idToken: row.id_token,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
      lastAttemptAt: row.last_attempt_at,
    };
  }

  // Whether the provider should be asked again about this session: 5 minutes
  // since the last successful check, and 1 minute since the last attempt that
  // could not reach the provider.
  checkDue(session: SessionRecord): boolean {
    const now = this.now();
    if (now - session.lastCheckedAt < CHECK_INTERVAL_MS) return false;
    return session.lastAttemptAt === null || now - session.lastAttemptAt >= CHECK_RETRY_MS;
  }

  // A successful re-check: refresh identity and tokens (the refresh token
  // rotates every time), stamp last_checked_at, clear the failed-attempt mark.
  updateAfterCheck(id: string, refresh: SessionRefresh): void {
    this.updateAfterCheckByHash(hashId(id), refresh);
  }

  updateAfterCheckByHash(idHash: string, refresh: SessionRefresh): void {
    this.db
      .prepare(
        `UPDATE sessions SET username = ?, email = ?, groups_json = ?, refresh_token = ?,
           id_token = COALESCE(?, id_token), last_checked_at = ?, last_attempt_at = NULL
         WHERE id_hash = ?`
      )
      .run(
        refresh.username,
        refresh.email,
        JSON.stringify(refresh.groups),
        refresh.refreshToken,
        refresh.idToken ?? null,
        this.now(),
        idHash
      );
  }

  // A re-check that could not reach the provider: identity is left as it
  // was, and the next attempt waits CHECK_RETRY_MS. `tokens` carries what a
  // refresh grant returned before a later step failed (RecheckResult's
  // `unreachable`): the presented refresh token is already spent, so the
  // rotated one must be kept or the next attempt would be refused. An absent
  // field keeps the stored value.
  markCheckAttempt(id: string, tokens: { refreshToken?: string; idToken?: string } = {}): void {
    this.markCheckAttemptByHash(hashId(id), tokens);
  }

  markCheckAttemptByHash(idHash: string, tokens: { refreshToken?: string; idToken?: string } = {}): void {
    this.db
      .prepare(
        `UPDATE sessions SET last_attempt_at = ?, refresh_token = COALESCE(?, refresh_token),
           id_token = COALESCE(?, id_token)
         WHERE id_hash = ?`
      )
      .run(this.now(), tokens.refreshToken ?? null, tokens.idToken ?? null, idHash);
  }

  // Sign-out, or a re-check the provider refused.
  deleteSession(id: string): void {
    this.deleteSessionByHash(hashId(id));
  }

  deleteSessionByHash(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  // Records a pending sign-in and returns the raw value for its login
  // cookie. /auth/login needs no session, so abandoned attempts (a crawler,
  // a sign-in never finished) would otherwise pile up until the next
  // restart: each new one first drops the expired ones.
  createAttempt(input: LoginAttemptInput): string {
    const id = newId();
    this.db.prepare('DELETE FROM login_attempts WHERE created_at + ? <= ?').run(ATTEMPT_MAX_AGE_MS, this.now());
    this.db
      .prepare(
        'INSERT INTO login_attempts (id_hash, state, nonce, code_verifier, return_to, created_at, mcp_pending_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(hashId(id), input.state, input.nonce, input.codeVerifier, input.returnTo, this.now(), input.mcpPendingHash ?? null);
    return id;
  }

  // Reads and deletes a pending sign-in in one transaction, so a callback
  // can be replayed at most once. An attempt older than 10 minutes yields
  // undefined (and is still deleted).
  consumeAttempt(id: string): LoginAttemptRecord | undefined {
    if (id === '') return undefined;
    const idHash = hashId(id);
    const take = this.db.transaction((): AttemptRow | undefined => {
      const row = this.db.prepare('SELECT * FROM login_attempts WHERE id_hash = ?').get(idHash) as AttemptRow | undefined;
      if (row) this.db.prepare('DELETE FROM login_attempts WHERE id_hash = ?').run(idHash);
      return row;
    });
    const row = take();
    if (!row || this.now() >= row.created_at + ATTEMPT_MAX_AGE_MS) return undefined;
    return {
      state: row.state,
      nonce: row.nonce,
      codeVerifier: row.code_verifier,
      returnTo: row.return_to,
      createdAt: row.created_at,
      ...(row.mcp_pending_hash !== null ? { mcpPendingHash: row.mcp_pending_hash } : {}),
    };
  }

  // Deletes sessions past 30 days and attempts past 10 minutes.
  purgeExpired(): void {
    const now = this.now();
    this.db.prepare('DELETE FROM sessions WHERE created_at + ? <= ?').run(SESSION_MAX_AGE_MS, now);
    this.db.prepare('DELETE FROM login_attempts WHERE created_at + ? <= ?').run(ATTEMPT_MAX_AGE_MS, now);
  }

  close(): void {
    this.db.close();
  }
}
