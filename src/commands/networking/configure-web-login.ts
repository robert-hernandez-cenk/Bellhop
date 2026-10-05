import type { AuthentikClient } from '../../lib/authentik-client.ts';
import { assignSetting, loadInventory, saveInventory, SettingsSchema, type Inventory } from '../../lib/inventory.ts';
import { writeSecret } from '../../lib/config.ts';
import { settingSchema } from '../../lib/settings-defs.ts';
import { warnIfEnvPinned } from '../maintenance/set-config.ts';
import { findEntry, runOidcCredentials } from './oidc-credentials.ts';

export interface ConfigureWebLoginDeps {
  authentik: AuthentikClient;
  inventory: Inventory;
  inventoryPath: string;
}

// Deliberately has no secret field: nothing that prints or logs this result
// can leak the client secret (it lives only inside runConfigureWebLogin).
export interface ConfigureWebLoginResult {
  entry: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  applied: boolean;
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

// Stores Bellhop's own sign-in client (#69, US3) in the settings store in
// one step after sync-authentik --apply, so no secret is copied by hand.
// Every lookup error from runOidcCredentials (unknown entry, not OIDC, no
// client yet, Authentik unconfigured) propagates verbatim, and every check
// runs before the first write, so a failure writes nothing.
export async function runConfigureWebLogin(
  entryName: string,
  opts: { apply?: boolean },
  deps: ConfigureWebLoginDeps
): Promise<ConfigureWebLoginResult> {
  const { issuer, clientId, clientSecret } = await runOidcCredentials(entryName, deps);

  // runOidcCredentials already proved the entry exists.
  const entry = findEntry(deps.inventory, entryName)!;
  const redirectUri = callbackUri(entry.oidcRedirectUris);
  if (!redirectUri) {
    throw new Error(
      `${entryName} has no callback URL ending in /auth/callback in oidcRedirectUris -- add https://<host>/auth/callback (Dashboard: Callback URLs), run sync-authentik --apply, then retry`
    );
  }

  // The same schemas set-config and the Settings page validate with. The
  // messages are fixed text, so the secret is never echoed.
  const values = { webUiOidcIssuer: issuer, webUiOidcClientId: clientId, webUiOidcRedirectUri: redirectUri };
  const parsed = SettingsSchema.safeParse(values);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  const secretCheck = settingSchema('webUiOidcClientSecret').safeParse(clientSecret);
  if (!secretCheck.success) {
    throw new Error(`webUiOidcClientSecret: ${secretCheck.error.issues.map((i) => i.message).join('; ')}`);
  }

  const result: ConfigureWebLoginResult = { entry: entryName, issuer, clientId, redirectUri, applied: false };
  if (!opts.apply) return result;

  // Stored even when this shell's environment pins a key, as set-config
  // does (the web service's environment is not necessarily this shell's),
  // with the same warning.
  for (const key of [...Object.keys(values), 'webUiOidcClientSecret']) warnIfEnvPinned(key);
  const updated = { ...loadInventory(deps.inventoryPath) };
  assignSetting(updated, 'webUiOidcIssuer', issuer);
  assignSetting(updated, 'webUiOidcClientId', clientId);
  assignSetting(updated, 'webUiOidcRedirectUri', redirectUri);
  saveInventory(deps.inventoryPath, updated);
  writeSecret(deps.inventoryPath, 'webUiOidcClientSecret', clientSecret);
  return { ...result, applied: true };
}

// Layout from contracts/cli-and-settings.md. The secret is only ever
// described as set or would-be-set.
export function formatConfigureWebLogin(result: ConfigureWebLoginResult): string {
  const lines = [
    result.applied
      ? `Stored web login settings from ${result.entry}:`
      : `Would store web login settings from ${result.entry} (dry run -- pass --apply to write):`,
    `  webUiOidcIssuer: ${result.issuer}`,
    `  webUiOidcClientId: ${result.clientId}`,
    `  webUiOidcRedirectUri: ${result.redirectUri}`,
    `  webUiOidcClientSecret: ${result.applied ? '(set)' : '(would be set)'}`,
  ];
  if (result.applied) {
    const origin = new URL(result.redirectUri).origin;
    lines.push(
      `Next: sign in at ${origin}/auth/login, then set webUiAuthMode to oidc (Settings page or bellhop set-config webUiAuthMode oidc --apply).`
    );
  }
  return lines.join('\n');
}
