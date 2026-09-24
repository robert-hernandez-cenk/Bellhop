// Every Authentik-instance-specific value this toolkit needs, in one place.
// Before issue #123 these were several hardcoded literals spread across
// src/web/auth.ts, src/commands/networking/sync-authentik.ts,
// src/commands/networking/sync-caddy.ts, src/lib/authentik-client.ts, and
// two web-client files -- the two admin group names alone had five
// independent copies. Defaults reproduce those literals exactly, so an
// operator who sets none of these sees no behavior change at all.
//
// The single default app-users group name/env-var pair lived here until
// issue #158 replaced the gated/ungated boolean with a named ladder rung --
// there is no longer a "gated but unnamed" state for a single default group
// to fill.
//
// Read at call time rather than frozen at module load: src/web/server.ts and
// src/cli.ts both dotenv-load data/authentik.env at startup, and a
// module-load-time snapshot would race that.
export interface AuthentikConfig {
  adminGroup: string;
  builtinAdminGroup: string;
  groupLadder: string[];
  outpostName: string;
  outpostPort: number;
  authorizationFlowSlug: string;
  invalidationFlowSlug: string;
}

const DEFAULT_ADMIN_GROUP = 'bellhop-admins';
const DEFAULT_BUILTIN_ADMIN_GROUP = 'authentik Admins';
const DEFAULT_OUTPOST_NAME = 'authentik Embedded Outpost';
const DEFAULT_OUTPOST_PORT = 9000;
const DEFAULT_AUTHORIZATION_FLOW_SLUG = 'default-provider-authorization-implicit-consent';
const DEFAULT_INVALIDATION_FLOW_SLUG = 'default-invalidation-flow';

// Ordered low (broadest audience) to high (narrowest). An entry's authGroup
// names one rung; sync-authentik binds its Application to that rung and
// every rung above it, so the top rung is effectively "admin only" and the
// old "admins always get in" special case is just a rung like any other.
// The default rungs are product-named groups an operator creates in
// Authentik; the top rung is Authentik's own built-in admin group.
// AUTHENTIK_GROUP_LADDER overrides the whole list.
const DEFAULT_GROUP_LADDER = 'bellhop-app-users-open,bellhop-app-users,bellhop-users,authentik Admins';

// An empty string counts as unset -- a KEY= line in data/authentik.env is a
// far likelier way to express "I did not set this" than an intentional
// empty group name.
function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  return raw !== undefined && raw !== '' ? raw : fallback;
}

// Duplicates collapse to their first occurrence rather than throwing:
// authentikConfig() runs on every web request (src/web/auth.ts), so it must
// never be a source of request failures. A repeated rung is unambiguous
// anyway -- the earlier (broader) position is the one that matters.
function groupLadder(env: NodeJS.ProcessEnv): string[] {
  const raw = str(env, 'AUTHENTIK_GROUP_LADDER', DEFAULT_GROUP_LADDER);
  const seen = new Set<string>();
  const ladder: string[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    ladder.push(name);
  }
  return ladder;
}

export function authentikConfig(env: NodeJS.ProcessEnv = process.env): AuthentikConfig {
  return {
    adminGroup: str(env, 'AUTHENTIK_ADMIN_GROUP', DEFAULT_ADMIN_GROUP),
    builtinAdminGroup: str(env, 'AUTHENTIK_BUILTIN_ADMIN_GROUP', DEFAULT_BUILTIN_ADMIN_GROUP),
    groupLadder: groupLadder(env),
    outpostName: str(env, 'AUTHENTIK_OUTPOST_NAME', DEFAULT_OUTPOST_NAME),
    outpostPort: outpostPort(env),
    authorizationFlowSlug: str(env, 'AUTHENTIK_AUTHORIZATION_FLOW_SLUG', DEFAULT_AUTHORIZATION_FLOW_SLUG),
    invalidationFlowSlug: str(env, 'AUTHENTIK_INVALIDATION_FLOW_SLUG', DEFAULT_INVALIDATION_FLOW_SLUG),
  };
}

// The one parsed value. Throwing beats coercing: a NaN here would reach the
// generated Caddyfile as a silently broken forward_auth target. Same spirit
// as parsePositiveInt in src/cli.ts.
function outpostPort(env: NodeJS.ProcessEnv): number {
  const raw = env.AUTHENTIK_OUTPOST_PORT;
  if (raw === undefined || raw === '') return DEFAULT_OUTPOST_PORT;
  if (!/^[0-9]+$/.test(raw) || Number(raw) === 0) {
    throw new Error(`AUTHENTIK_OUTPOST_PORT must be a positive integer, got: ${raw}`);
  }
  return Number(raw);
}

// Whether this deployment has an Authentik API to talk to at all. Gates
// user/group CRUD, the impersonation group picker, and
// sync-authentik -- all of which need the REST API, not just forward-auth
// headers. Deliberately independent of WEB_UI_AUTH_MODE (src/web/auth.ts):
// running Authentik forward-auth without handing this app an admin token is
// a legitimate setup.
export function authentikConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.AUTHENTIK_API_URL && env.AUTHENTIK_API_TOKEN);
}

// The rungs an entry's Application must be bound to: the one it names plus
// every narrower one above it. null means the group is not on the ladder at
// all -- the caller reports that rather than guessing an audience.
export function rungsAtOrAbove(ladder: string[], group: string): string[] | null {
  const idx = ladder.indexOf(group);
  if (idx === -1) return null;
  return ladder.slice(idx);
}
