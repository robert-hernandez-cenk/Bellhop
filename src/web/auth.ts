import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { authentikConfig } from '../lib/authentik-config.ts';
import { configValue } from '../lib/config.ts';
import { UNCONFIGURED_MESSAGE } from '../lib/authentik-client.ts';
import type { AuthentikClient } from '../lib/authentik-client.ts';
import { parseCookies, SESSION_COOKIE } from './login/cookies.ts';
import type { SessionService } from './login/sessions.ts';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      // Set only while an impersonation override is active -- the real,
      // non-overlaid identity, so admin-only control endpoints and job
      // attribution can always recover who is really acting. See
      // src/web/impersonation.ts.
      realUser?: AuthUser;
    }
  }
}

export interface AuthUser {
  username: string;
  email?: string;
  groups: string[];
  // Set only by applyImpersonation -- the group name currently being
  // impersonated, or absent for a normal session.
  impersonating?: string;
  // Set only for the synthetic identity used when no identity provider is in
  // play (see authMode below). Drives the web UI's unauthenticated banner;
  // admin rights come from group membership like everyone else.
  localOperator?: boolean;
  // The identity provider's stable user id (the OIDC `sub` claim, issue #58
  // and #69) -- used to match a guest's recorded creator across username
  // renames (src/lib/permissions.ts's isGuestCreator) rather than by
  // username alone. Always set for a session identity; absent for dev/test
  // identities and the synthetic local operator, which have no such id.
  uid?: string;
  // Set only for an identity resolved from a Bellhop web-login session
  // (#69, src/web/login/sessions.ts) -- never for the dev user or the local
  // operator. Survives the impersonation overlay, which replaces only groups.
  // The Settings page's webUiAuthMode guard reads it: only a requester who
  // has proved they can sign in may switch sign-in on. Not part of whoami.
  viaOidc?: true;
}

// #69 research R10. The modes are:
//
//   oidc -- a Bellhop web-login session is required: /api answers 401 and
//           a page navigation is sent to /auth/login without one
//   none -- no authentication: a request with no session is served as the
//           full-admin local operator (the default, so a fresh clone works
//           before any identity provider exists)
//
// A session is honored in both modes (R6), which is what lets an operator
// sign in and prove an admin identity before switching to oidc.
export type AuthMode = 'oidc' | 'none';

// Read through the config accessor (issue #64): WEB_UI_AUTH_MODE wins, then
// the stored webUiAuthMode setting. A stored value was already validated by
// the accessor (and openInventoryDb migrated the retired ones), so the
// checks below only ever reject the environment variable -- echoing it, as
// before, since it is the operator's own value.
export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const raw = configValue('webUiAuthMode', env).value;
  if (raw === undefined) return 'none';
  if (raw === 'oidc' || raw === 'none') return raw;
  if (raw === 'auto' || raw === 'authentik') {
    throw new Error(
      `WEB_UI_AUTH_MODE=${raw} is no longer supported -- use oidc (sign-in required) or none (no authentication); see docs/authentik.md`
    );
  }
  throw new Error(`WEB_UI_AUTH_MODE must be one of oidc, none -- got: ${raw}`);
}

// The local operator's username: WEB_UI_LOCAL_USER, else 'local'. Exported for
// backfill-guest-creators, which must recognize (and skip) its jobs.
export function localOperatorUsername(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.WEB_UI_LOCAL_USER;
  return name !== undefined && name !== '' ? name : 'local';
}

// The synthetic identity used when there is no identity provider. It is put
// *in* the configured admin group rather than special-cased as an admin, so
// isAdminUser and every per-resource permission check keep working with no
// awareness of this mode at all.
function localOperator(env: NodeJS.ProcessEnv): AuthUser {
  return {
    username: localOperatorUsername(env),
    groups: [authentikConfig(env).adminGroup],
    localOperator: true,
  };
}

// The signed-in user for a request, or undefined when it is unauthenticated
// (#69 research R6). Takes only the request's headers, and of those reads
// only Cookie, so the raw WebSocket upgrade (src/web/routes/jobs.ts) resolves
// a user exactly as requireAuth does. X-authentik-* headers are never read
// (FR-018): with Bellhop's own sign-in, a header is just something any client
// can send.
//
//   1. a valid bellhop_session cookie -- in either mode, re-checked with the
//      provider when due (SessionService.resolve);
//   2. WEB_UI_DEV_USER -- the local-dev/test affordance. Unlike the local
//      operator it can simulate *specific non-admin group memberships* via
//      WEB_UI_DEV_GROUPS, which most of this repo's web tests rely on. It
//      outranks the local operator so the suite's global
//      WEB_UI_DEV_USER=test-user keeps working with the none default, and it
//      applies in oidc mode too -- which is exactly why it must never be set
//      in a production environment;
//   3. none mode -- the local operator;
//   4. otherwise unauthenticated.
export async function resolveRequestUser(
  headers: IncomingHttpHeaders,
  sessions: SessionService,
  env: NodeJS.ProcessEnv = process.env
): Promise<AuthUser | undefined> {
  const sessionId = parseCookies(headers.cookie)[SESSION_COOKIE];
  if (sessionId) {
    const user = await sessions.resolve(sessionId);
    if (user) return user;
  }

  const devUser = env.WEB_UI_DEV_USER;
  if (devUser) {
    const devGroups = env.WEB_UI_DEV_GROUPS;
    return { username: devUser, groups: devGroups ? devGroups.split('|') : [] };
  }

  return authMode(env) === 'none' ? localOperator(env) : undefined;
}

// The global authentication middleware (contracts/http-auth.md). Mounted in
// buildApp after the /auth routes, so sign-in itself never needs a session.
// Unauthenticated: an /api call gets 401 JSON (the client's fetch wrapper
// turns that into a redirect to sign in); a page GET/HEAD is redirected to
// /auth/login carrying the path and query it asked for; anything else gets
// 401, since a redirect cannot replay a form post.
export function requireAuth(sessions: SessionService): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = await resolveRequestUser(req.headers, sessions);
    if (user) {
      req.user = user;
      next();
      return;
    }
    const isApi = req.originalUrl === '/api' || req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/api?');
    if (!isApi && (req.method === 'GET' || req.method === 'HEAD')) {
      res.redirect(302, `/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };
}

// The single admin predicate. Before issue #123 this expression was written
// out four separate times (requireAdminGroup, requireRealAdminGroup,
// access.ts's isAdmin, and impersonation.ts's rejected-target check) against
// two hardcoded constants that had five copies between them.
//
// The app group is distinct from Authentik's own built-in superuser group;
// membership in either is sufficient (issue #86), so there is always a path
// into the Users page without a manual, out-of-band Authentik group edit.
export function isAdminUser(groups: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return isAdminOf(groups, authentikConfig(env));
}

// The same check against an explicit pair of group names -- the Settings
// page's lockout guards (issue #64) test a requester against the names a
// pending change *would* set, before anything is written.
export function isAdminOf(groups: string[], adminGroups: { adminGroup: string; builtinAdminGroup: string }): boolean {
  return groups.includes(adminGroups.adminGroup) || groups.includes(adminGroups.builtinAdminGroup);
}

export function requireAdminGroup(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminUser(req.user?.groups ?? [])) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}

// Authorizes the impersonation control endpoints themselves
// (src/web/routes/impersonation.ts) against the real, non-overlaid
// identity. Using requireAdminGroup there instead would check the
// (possibly impersonated) req.user.groups -- the moment an admin
// impersonates a non-admin group, that check would 403 the very endpoint
// needed to turn impersonation off, locking them into that view until a
// server restart.
export function requireRealAdminGroup(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminUser((req.realUser ?? req.user)?.groups ?? [])) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}

// Axis 2 of issue #123's design: gates the routes that need Authentik's REST
// API, not merely a forward-auth header. Without this they surfaced
// UnconfiguredAuthentikClient's throw as a generic 500 at best, and in
// syncProxyLive's case broke an unrelated operation entirely.
//
// Takes the actual AuthentikClient instance mounted into the app rather than
// re-reading process.env, so this gate can never disagree with what the
// route handler it guards is about to call -- and so tests can exercise it
// by injecting UnconfiguredAuthentikClient instead of mutating process.env
// (which would also 503 every other test using an injected fake client that
// never sets AUTHENTIK_API_URL/AUTHENTIK_API_TOKEN).
export function requireUserDirectory(authentik: AuthentikClient): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!authentik.isConfigured()) {
      res.status(503).json({ error: UNCONFIGURED_MESSAGE });
      return;
    }
    next();
  };
}
