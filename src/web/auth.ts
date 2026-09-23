import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { authentikConfig } from '../lib/authentik-config.ts';
import { UNCONFIGURED_MESSAGE } from '../lib/authentik-client.ts';
import type { AuthentikClient } from '../lib/authentik-client.ts';

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
}

// Axis 1 of issue #123's design. The default is inferred rather than
// fail-closed on purpose: most adopters either grow into an identity
// provider over time or never want one, and a 401 wall on first run is a
// poor introduction to a toolkit whose other commands have nothing to do
// with Authentik.
//
//   auto (default) -- trusted headers if present, else the local operator
//   authentik      -- trusted headers required, 401 otherwise
//   none           -- always the local operator, headers ignored
//
// 'authentik' exists because 'auto' cannot detect the one failure it cannot
// see: a Caddy config that *lost* its forward_auth directive looks identical
// to a deployment that never had one. Any instance where authentication is
// load-bearing should set it -- see README's "Running without Authentik".
export type AuthMode = 'auto' | 'authentik' | 'none';

export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const raw = env.WEB_UI_AUTH_MODE;
  if (raw === undefined || raw === '') return 'auto';
  if (raw === 'auto' || raw === 'authentik' || raw === 'none') return raw;
  throw new Error(`WEB_UI_AUTH_MODE must be one of auto, authentik, none -- got: ${raw}`);
}

// The synthetic identity used when there is no identity provider. It is put
// *in* the configured admin group rather than special-cased as an admin, so
// isAdminUser and every per-resource permission check keep working with no
// awareness of this mode at all.
function localOperator(env: NodeJS.ProcessEnv): AuthUser {
  const name = env.WEB_UI_LOCAL_USER;
  return {
    username: name !== undefined && name !== '' ? name : 'local',
    groups: [authentikConfig(env).adminGroup],
    localOperator: true,
  };
}

// Caddy's forward_auth to Authentik's embedded outpost adds these headers
// once a request is authenticated. WEB_UI_DEV_USER
// remains the local-dev/test affordance: unlike the local operator, it can
// simulate *specific non-admin group memberships* via WEB_UI_DEV_GROUPS,
// which is what most of this repo's web tests rely on.
export function resolveAuthUser(
  headers: IncomingHttpHeaders,
  env: NodeJS.ProcessEnv = process.env
): AuthUser | undefined {
  const mode = authMode(env);
  if (mode === 'none') return localOperator(env);

  const username = headers['x-authentik-username'];
  if (typeof username === 'string' && username.length > 0) {
    const email = headers['x-authentik-email'];
    const groupsHeader = headers['x-authentik-groups'];
    return {
      username,
      email: typeof email === 'string' ? email : undefined,
      groups: typeof groupsHeader === 'string' && groupsHeader.length > 0 ? groupsHeader.split('|') : [],
    };
  }

  // Checked before the mode gate below, so this bypasses authentication even
  // in strict 'authentik' mode -- intended, and what this repo's own tests
  // rely on (see CLAUDE.md's "Web UI authentication" section), but it does
  // mean strict mode is not an absolute guarantee w.r.t. this variable. This
  // is exactly why WEB_UI_DEV_USER must never be set in a production
  // environment.
  const devUser = env.WEB_UI_DEV_USER;
  if (devUser) {
    const devGroups = env.WEB_UI_DEV_GROUPS;
    return { username: devUser, groups: devGroups ? devGroups.split('|') : [] };
  }

  return mode === 'auto' ? localOperator(env) : undefined;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = resolveAuthUser(req.headers);
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.user = user;
  next();
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
  const config = authentikConfig(env);
  return groups.includes(config.adminGroup) || groups.includes(config.builtinAdminGroup);
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
// syncCaddyLive's case broke an unrelated operation entirely.
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
