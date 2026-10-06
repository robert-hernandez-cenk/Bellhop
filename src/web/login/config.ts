import { configValue } from '../../lib/config.ts';
import { SETTING_DEFS, settingSchema, type ConfigKey } from '../../lib/settings-defs.ts';
import { managedWebLogin, managedWebLoginProblem, NO_BELLHOP_GUEST } from './managed.ts';

// The four custom settings that together make Bellhop's own OIDC web login usable
// (#69 data-model.md). Read through configValue so the environment override
// and the stored value follow the same precedence as every other setting;
// read per call, never cached, so a Settings-page change applies without a
// restart. When they are not all set, the guest flagged `bellhop: true`
// supplies the client instead (#85, managed.ts).
export type WebLoginConfig =
  | { configured: true; issuer: string; clientId: string; clientSecret: string; redirectUri: string }
  // Key names only -- a secret's value must never reach an error or a log.
  | { configured: false; missing: ConfigKey[] };

// Which source signs people in, for the Settings page (#85). Carries no
// secret and no client ID: the managed guest's name and callback URL only.
// `invalid` is the key-and-variable message for a malformed WEB_UI_OIDC_*
// environment value (never the value).
export type WebLoginStatus =
  | { source: 'custom' }
  | { source: 'managed'; entry: string; redirectUri: string }
  | { source: 'none'; missing: ConfigKey[]; managedProblem?: string; invalid?: string };

export const WEB_LOGIN_KEYS = ['webUiOidcIssuer', 'webUiOidcClientId', 'webUiOidcRedirectUri', 'webUiOidcClientSecret'] as const;

type CustomLogin =
  | { complete: true; issuer: string; clientId: string; clientSecret: string; redirectUri: string }
  | { complete: false; missing: ConfigKey[] };

// The four custom settings as they stand. Throws for an invalid
// environment-sourced value, naming the key and variable.
function readCustom(env: NodeJS.ProcessEnv): CustomLogin {
  const values = new Map<ConfigKey, string>();
  const missing: ConfigKey[] = [];
  for (const key of WEB_LOGIN_KEYS) {
    const { value, source } = configValue(key, env);
    // configValue validates a stored value on read but passes an environment
    // override through untouched, so a malformed WEB_UI_OIDC_* would only
    // surface later as an opaque discovery or redirect failure. Check it here
    // against the same schema the store uses. The message names the key and
    // its env var, never the value (it may be the client secret); the schema
    // messages are fixed text (settings-defs.ts), so the reason is safe too.
    if (source === 'environment') {
      const result = settingSchema(key).safeParse(value);
      if (!result.success) {
        const reason = result.error.issues.map((issue) => issue.message).join('; ');
        const envVar = SETTING_DEFS[key].envVar;
        throw new Error(`Setting '${key}' from environment variable ${envVar} is invalid (${reason}) -- fix or unset ${envVar}`);
      }
    }
    if (value === undefined) missing.push(key);
    else values.set(key, value);
  }
  if (missing.length > 0) return { complete: false, missing };
  return {
    complete: true,
    issuer: values.get('webUiOidcIssuer')!,
    clientId: values.get('webUiOidcClientId')!,
    clientSecret: values.get('webUiOidcClientSecret')!,
    redirectUri: values.get('webUiOidcRedirectUri')!,
  };
}

export function webLoginConfig(env: NodeJS.ProcessEnv = process.env): WebLoginConfig {
  const custom = readCustom(env);
  if (custom.complete) {
    return {
      configured: true,
      issuer: custom.issuer,
      clientId: custom.clientId,
      clientSecret: custom.clientSecret,
      redirectUri: custom.redirectUri,
    };
  }
  // The custom set is incomplete: fall back to the flagged guest's client as
  // a whole (#85) -- never a mix of the two. Custom wins only when all four
  // are set. The managed value is whatever the last refresh resolved
  // (managed.ts), so this stays synchronous.
  const managed = managedWebLogin();
  if (managed) {
    return {
      configured: true,
      issuer: managed.issuer,
      clientId: managed.clientId,
      clientSecret: managed.clientSecret,
      redirectUri: managed.redirectUri,
    };
  }
  return { configured: false, missing: custom.missing };
}

export function webLoginStatus(env: NodeJS.ProcessEnv = process.env): WebLoginStatus {
  let custom: CustomLogin;
  try {
    custom = readCustom(env);
  } catch (err) {
    return { source: 'none', missing: [], invalid: (err as Error).message };
  }
  if (custom.complete) return { source: 'custom' };
  const managed = managedWebLogin();
  if (managed) return { source: 'managed', entry: managed.entry, redirectUri: managed.redirectUri };
  const problem = managedWebLoginProblem();
  // An install with no flagged guest is not told about the managed option as
  // if it were a problem.
  return {
    source: 'none',
    missing: custom.missing,
    ...(problem !== undefined && problem !== NO_BELLHOP_GUEST ? { managedProblem: problem } : {}),
  };
}
