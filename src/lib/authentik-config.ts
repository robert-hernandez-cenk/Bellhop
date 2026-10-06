import { configValue } from './config.ts';
import type { MovedSettingKey } from './settings-defs.ts';

// Every Authentik-instance-specific value this toolkit needs, in one place.
// Before issue #123 these were several hardcoded literals spread across
// src/web/auth.ts, src/commands/networking/sync-authentik.ts,
// src/commands/networking/sync-proxy.ts, src/lib/authentik-client.ts, and
// two web-client files -- the two admin group names alone had five
// independent copies. Defaults reproduce those literals exactly, so an
// operator who sets none of these sees no behavior change at all.
//
// The single default app-users group name/env-var pair lived here until
// issue #158 replaced the gated/ungated boolean with a named ladder rung --
// there is no longer a "gated but unnamed" state for a single default group
// to fill.
//
// Read at call time rather than frozen at module load, through the config
// accessor (issue #64): an environment variable still wins, then the stored
// setting, then the defaults below -- so a value saved on the Settings page
// applies on the next request with no restart.
export interface AuthentikConfig {
  adminGroup: string;
  builtinAdminGroup: string;
  groupLadder: string[];
  outpostName: string;
  outpostPort: number;
  authorizationFlowSlug: string;
  invalidationFlowSlug: string;
  oidcSigningKeyName: string;
}

const DEFAULT_ADMIN_GROUP = 'bellhop-admins';
const DEFAULT_BUILTIN_ADMIN_GROUP = 'authentik Admins';
const DEFAULT_OUTPOST_NAME = 'authentik Embedded Outpost';
const DEFAULT_OUTPOST_PORT = 9000;
const DEFAULT_AUTHORIZATION_FLOW_SLUG = 'default-provider-authorization-implicit-consent';
const DEFAULT_INVALIDATION_FLOW_SLUG = 'default-invalidation-flow';

// The Authentik certificate-keypair used to sign OIDC provider tokens
// (native OIDC gating, issue #1). A stock Authentik install always has this
// self-signed cert, so it's a safe default an operator overrides only when
// they've deliberately set up their own signing key.
const DEFAULT_OIDC_SIGNING_KEY_NAME = 'authentik Self-signed Certificate';

// Ordered low (broadest audience) to high (narrowest). An entry's authGroup
// names one rung; sync-authentik binds its Application to that rung and
// every rung above it, so the top rung is effectively "admin only" and the
// old "admins always get in" special case is just a rung like any other.
// The default rungs are product-named groups an operator creates in
// Authentik; the top rung is Authentik's own built-in admin group.
// AUTHENTIK_GROUP_LADDER overrides the whole list. Each rung is named for
// who belongs in it (#97):
//   bellhop-public-readonly  the most constrained tier
//   bellhop-public           public users of an external, public-facing
//                            site; self-created accounts are acceptable
//   bellhop-friends-family   friends and family to share more with, such
//                            as external websites
//   bellhop-admin-family     household members such as a spouse: more
//                            than friends, close to an administrator
const DEFAULT_GROUP_LADDER =
  'bellhop-public-readonly,bellhop-public,bellhop-friends-family,bellhop-admin-family,authentik Admins';

// An empty environment variable counts as unset (the accessor's rule) -- a
// KEY= line in data/authentik.env is a far likelier way to express "I did
// not set this" than an intentional empty group name.
function str(env: NodeJS.ProcessEnv, key: MovedSettingKey, fallback: string): string {
  return configValue(key, env).value ?? fallback;
}

// Duplicates collapse to their first occurrence rather than throwing:
// authentikConfig() runs on every web request (src/web/auth.ts), so it must
// never be a source of request failures. A repeated rung is unambiguous
// anyway -- the earlier (broader) position is the one that matters.
function groupLadder(env: NodeJS.ProcessEnv): string[] {
  return parseGroupLadder(configValue('authentikGroupLadder', env).value);
}

// The ladder parsing rules on a raw comma-separated string, with unset or
// empty meaning the default ladder. Exported for the #158 migration in
// inventory.ts, which resolves the raw value itself (stored setting or env
// var, issue #64) from the database it is opening, so the parsing and
// dedup rules stay defined only here.
export function parseGroupLadder(rawValue: string | undefined): string[] {
  const raw = rawValue !== undefined && rawValue !== '' ? rawValue : DEFAULT_GROUP_LADDER;
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
    adminGroup: str(env, 'authentikAdminGroup', DEFAULT_ADMIN_GROUP),
    builtinAdminGroup: str(env, 'authentikBuiltinAdminGroup', DEFAULT_BUILTIN_ADMIN_GROUP),
    groupLadder: groupLadder(env),
    outpostName: str(env, 'authentikOutpostName', DEFAULT_OUTPOST_NAME),
    outpostPort: outpostPort(env),
    authorizationFlowSlug: str(env, 'authentikAuthorizationFlowSlug', DEFAULT_AUTHORIZATION_FLOW_SLUG),
    invalidationFlowSlug: str(env, 'authentikInvalidationFlowSlug', DEFAULT_INVALIDATION_FLOW_SLUG),
    oidcSigningKeyName: str(env, 'authentikOidcSigningKeyName', DEFAULT_OIDC_SIGNING_KEY_NAME),
  };
}

// The one parsed value. Throwing beats coercing: a NaN here would reach the
// generated proxy configuration as a silently broken forward_auth target.
// Same spirit as parsePositiveInt in src/cli.ts. A stored value was already
// validated by the accessor (which throws naming the setting, never the
// value); this check covers the environment variable, whose value is the
// operator's own shell's and has always been echoed back.
function outpostPort(env: NodeJS.ProcessEnv): number {
  const raw = configValue('authentikOutpostPort', env).value;
  if (raw === undefined) return DEFAULT_OUTPOST_PORT;
  if (!/^[0-9]+$/.test(raw) || Number(raw) === 0) {
    throw new Error(`AUTHENTIK_OUTPOST_PORT must be a positive integer, got: ${raw}`);
  }
  return Number(raw);
}

// Whether this deployment has an Authentik API to talk to at all. Gates
// user/group CRUD, the impersonation group picker, and
// sync-authentik -- all of which need the REST API, not just forward-auth
// headers. Deliberately independent of webUiAuthMode (src/web/auth.ts):
// running Authentik forward-auth without handing this app an admin token is
// a legitimate setup. Each half may come from its environment variable or
// its stored setting independently.
export function authentikConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    configValue('authentikApiUrl', env).value !== undefined && configValue('authentikApiToken', env).value !== undefined
  );
}

// The admin/builtin-admin group names a settings PATCH would leave in
// effect, without writing anything -- the no-self-lockout guard (issue
// #64, US6) uses this to check whether the real requester would still be
// an administrator afterward. `overrides` holds only the two keys the
// request body actually touches: a key present with a string value means
// "set to this"; present with `undefined` means "clear it" (back to the
// default below); a key left out of `overrides` entirely keeps today's
// effective value (environment, then stored setting, then the default),
// resolved the same way authentikConfig() itself resolves it. Reuses
// authentikConfig's own default literals rather than repeating them.
export function adminGroupsWith(
  overrides: { authentikAdminGroup?: string; authentikBuiltinAdminGroup?: string },
  env: NodeJS.ProcessEnv = process.env
): { adminGroup: string; builtinAdminGroup: string } {
  const current = authentikConfig(env);
  return {
    adminGroup:
      'authentikAdminGroup' in overrides ? overrides.authentikAdminGroup ?? DEFAULT_ADMIN_GROUP : current.adminGroup,
    builtinAdminGroup:
      'authentikBuiltinAdminGroup' in overrides
        ? overrides.authentikBuiltinAdminGroup ?? DEFAULT_BUILTIN_ADMIN_GROUP
        : current.builtinAdminGroup,
  };
}

// The rungs an entry's Application must be bound to: the one it names plus
// every narrower one above it. null means the group is not on the ladder at
// all -- the caller reports that rather than guessing an audience.
export function rungsAtOrAbove(ladder: string[], group: string): string[] | null {
  const idx = ladder.indexOf(group);
  if (idx === -1) return null;
  return ladder.slice(idx);
}
