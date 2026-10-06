import type { AuthentikClient } from '../../lib/authentik-client.ts';
import { effectiveAuth, type GuestEntry, type Inventory } from '../../lib/inventory.ts';
import { settingSchema } from '../../lib/settings-defs.ts';
import { logWarn } from '../../lib/log.ts';
import { OidcCredentialsError, runOidcCredentials } from '../../commands/networking/oidc-credentials.ts';

// Bellhop's own sign-in client, derived from the guest flagged `bellhop: true`
// (#85) rather than from the four webUiOidc* settings. Read live from
// Authentik and held in this process only -- never stored, serialized, or
// logged -- so a rotated secret or an edited callback URL takes effect on the
// next refresh without a restart.
export interface ManagedLogin {
  entry: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface ManagedWebLoginDeps {
  // A function, not a value: the web service keeps one live Inventory that
  // edits mutate in place, and a refresh must see the current flag and gate.
  inventory: () => Inventory;
  authentik: AuthentikClient;
}

// The problem when no guest carries the flag; an unmanaged install is not
// told about it as a failure (the sign-in page leaves it out).
export const NO_BELLHOP_GUEST = 'No guest is flagged as Bellhop';

let deps: ManagedWebLoginDeps | undefined;
let current: ManagedLogin | undefined;
let problem: string | undefined;
// Single-flight: a burst of sign-ins and re-checks shares one lookup.
let inflight: Promise<void> | undefined;

export function configureManagedWebLogin(next: ManagedWebLoginDeps): void {
  deps = next;
}

// Test-only: forgets the configuration and everything resolved.
export function resetManagedWebLogin(): void {
  deps = undefined;
  current = undefined;
  problem = undefined;
  inflight = undefined;
}

// The value the web login uses when the custom settings are not all set.
// Synchronous: webLoginConfig() and the MCP authorization server read it
// without awaiting; refreshManagedWebLogin() is what keeps it current.
export function managedWebLogin(): ManagedLogin | undefined {
  return current;
}

// Why there is no usable managed login, in fixed text that names the guest
// and what to fix, never a value. Undefined when one resolved.
export function managedWebLoginProblem(): string | undefined {
  return problem;
}

// The entry's callback URL for Bellhop's own web login: the fixed
// /auth/callback route (src/web/routes/auth.ts), matched on the URL's
// pathname so a sibling like /auth/callback/extra never qualifies.
function callbackUri(uris: readonly string[] | undefined): string | undefined {
  return (uris ?? []).find((uri) => {
    try {
      return new URL(uri).pathname === '/auth/callback';
    } catch {
      return false;
    }
  });
}

function fail(message: string): void {
  current = undefined;
  problem = message;
}

type Qualified = { entry: GuestEntry; redirectUri: string } | { problem: string };

// Whether the inventory's flagged guest could supply the web login, judged
// from the inventory alone (no Authentik lookup): the flagged guest exists,
// is OIDC-gated, and has a usable /auth/callback URL. When several URLs end in
// /auth/callback the first listed is used. The problem is fixed text naming
// the guest and the fix.
function qualify(inventory: Inventory): Qualified {
  const entry: GuestEntry | undefined = inventory.guests.find((g) => g.bellhop);
  if (!entry) return { problem: NO_BELLHOP_GUEST };
  if (effectiveAuth(entry) !== 'oidc') {
    return { problem: `${entry.name} is not OIDC-gated (set an auth group and OIDC mode)` };
  }
  const redirectUri = callbackUri(entry.oidcRedirectUris);
  if (!redirectUri) return { problem: `${entry.name} has no callback URL ending in /auth/callback` };
  // The same rule the custom setting has (https, except on loopback, since
  // the sign-in cookies are Secure). The schema's messages are fixed text.
  const redirectCheck = settingSchema('webUiOidcRedirectUri').safeParse(redirectUri);
  if (!redirectCheck.success) {
    const reason = redirectCheck.error.issues.map((issue) => issue.message).join('; ');
    return { problem: `${entry.name}'s callback URL is not usable: ${reason}` };
  }
  return { entry, redirectUri };
}

// The problem that would stop the flagged guest supplying the web login, or
// undefined when it qualifies. Used to refuse an edit that would take away
// the only sign-in (src/operations/edit-guest.ts).
export function managedGuestProblem(inventory: Inventory): string | undefined {
  const result = qualify(inventory);
  return 'problem' in result ? result.problem : undefined;
}

async function resolve(): Promise<void> {
  if (!deps) return;
  const inventory = deps.inventory();
  const qualified = qualify(inventory);
  if ('problem' in qualified) return fail(qualified.problem);
  const { entry, redirectUri } = qualified;

  try {
    const { issuer, clientId, clientSecret } = await runOidcCredentials(entry.name, {
      authentik: deps.authentik,
      inventory,
    });
    current = { entry: entry.name, issuer, clientId, clientSecret, redirectUri };
    problem = undefined;
  } catch (err) {
    if (err instanceof OidcCredentialsError) {
      // The entry is not (or not yet) a Bellhop-owned OpenID client: nothing
      // to keep. Its message is fixed text naming the guest and the fix.
      return fail(err.message);
    }
    // Authentik could not answer: keep the last good value (an outage must
    // not sign everyone out) and say so -- but only while it is still this
    // guest's client at this callback; after the flag moved or the callback
    // changed it is stale, and must not keep signing people in. The message
    // is the transport's or Authentik's, never the secret.
    if (current && (current.entry !== entry.name || current.redirectUri !== redirectUri)) current = undefined;
    problem = 'Authentik could not be reached';
    logWarn(`Managed web login for ${entry.name} could not be refreshed: ${err instanceof Error ? err.message : 'unexpected error'}${current ? '; keeping the last resolved client' : ''}`);
  }
}

// Re-reads the flagged guest and its client. Never throws, so a sign-in or a
// session re-check can await it unconditionally.
export function refreshManagedWebLogin(): Promise<void> {
  inflight ??= resolve()
    .catch((err) => {
      problem = 'Authentik could not be reached';
      logWarn(`Managed web login refresh failed: ${err instanceof Error ? err.message : 'unexpected error'}`);
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}
