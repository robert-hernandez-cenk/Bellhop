import { configValue } from '../../lib/config.ts';
import { SETTING_DEFS, settingSchema, type ConfigKey } from '../../lib/settings-defs.ts';

// The four settings that together make Bellhop's own OIDC web login usable
// (#69 data-model.md). Read through configValue so the environment override
// and the stored value follow the same precedence as every other setting;
// read per call, never cached, so a Settings-page change applies without a
// restart.
export type WebLoginConfig =
  | { configured: true; issuer: string; clientId: string; clientSecret: string; redirectUri: string }
  // Key names only -- a secret's value must never reach an error or a log.
  | { configured: false; missing: ConfigKey[] };

const KEYS = ['webUiOidcIssuer', 'webUiOidcClientId', 'webUiOidcRedirectUri', 'webUiOidcClientSecret'] as const;

export function webLoginConfig(env: NodeJS.ProcessEnv = process.env): WebLoginConfig {
  const values = new Map<ConfigKey, string>();
  const missing: ConfigKey[] = [];
  for (const key of KEYS) {
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
  if (missing.length > 0) return { configured: false, missing };
  return {
    configured: true,
    issuer: values.get('webUiOidcIssuer')!,
    clientId: values.get('webUiOidcClientId')!,
    clientSecret: values.get('webUiOidcClientSecret')!,
    redirectUri: values.get('webUiOidcRedirectUri')!,
  };
}
