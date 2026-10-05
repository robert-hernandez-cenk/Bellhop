import { z } from 'zod';

// The settings issue #64 moved out of data/*.env files and into the one
// settings store, plus the secrets that sit beside them. A leaf module on
// purpose -- it imports only zod (research R2): inventory.ts spreads
// MovedSettingsSchema into SettingsSchema, and src/lib/config.ts (the
// accessor) reads SETTING_DEFS, so if either of those were imported from
// here the authentik-config.ts -> config.ts -> inventory.ts chain would
// close into a cycle.
//
// Defaults deliberately do not live here: they stay with the code that
// applies them (authentik-config.ts, npm-client.ts), since "unset" means
// something different to each consumer (a default value, a skipped step,
// an integration that is off).
//
// Every validation message below is fixed text. zod's own messages for
// these checks never echo the input either, but z.enum's issue carries a
// `received` field holding the rejected value, which is why webUiAuthMode
// is a refine rather than an enum: a secret pasted into the wrong field
// must never come back in an error.

const nonEmpty = z.string().min(1, 'must not be empty');

const httpUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an http:// or https:// URL');

// Comma-separated, ordered low to high; parsed (and deduplicated) by
// parseGroupLadder in authentik-config.ts, which drops blank rungs -- so a
// value of only commas and spaces would parse to an empty ladder, leaving
// every gated entry off it.
const groupLadder = nonEmpty.refine(
  (value) => value.split(',').some((rung) => rung.trim() !== ''),
  'must name at least one group'
);

const positiveIntegerString = z
  .string()
  .refine((value) => /^[0-9]+$/.test(value) && Number(value) > 0, 'must be a positive integer');

export const WEB_UI_AUTH_MODES = ['auto', 'authentik', 'none'] as const;
export type WebUiAuthMode = (typeof WEB_UI_AUTH_MODES)[number];

const webUiAuthMode = z
  .string()
  .refine(
    (value): value is WebUiAuthMode => (WEB_UI_AUTH_MODES as readonly string[]).includes(value),
    'must be one of: auto, authentik, none'
  );

// API tokens never contain whitespace, so a stray space or newline from a
// copy-paste is caught here rather than surfacing later as an opaque 401.
const token = z.string().min(1, 'must not be empty').regex(/^\S+$/, 'must not contain whitespace');

// A password may contain spaces, but a control character (a pasted
// newline, most likely) would never survive the JSON login request intact.
const password = z.string().min(1, 'must not be empty').regex(/^[^\x00-\x1f\x7f]+$/, 'must not contain control characters');

export const MovedSettingsSchema = z.object({
  authentikApiUrl: httpUrl.optional(),
  authentikAdminGroup: nonEmpty.optional(),
  authentikBuiltinAdminGroup: nonEmpty.optional(),
  authentikGroupLadder: groupLadder.optional(),
  authentikOutpostName: nonEmpty.optional(),
  authentikOutpostPort: positiveIntegerString.optional(),
  authentikAuthorizationFlowSlug: nonEmpty.optional(),
  authentikInvalidationFlowSlug: nonEmpty.optional(),
  authentikOidcSigningKeyName: nonEmpty.optional(),
  webUiAuthMode: webUiAuthMode.optional(),
  npmApiUrl: httpUrl.optional(),
  npmApiEmail: nonEmpty.optional(),
});

// Never part of SettingsSchema/Inventory: these live only in the
// secret_settings table, so nothing that serializes the inventory (the
// status page, /api/inventory, snapshots) can ever carry one (research R1).
export const SecretSettingsSchema = z.object({
  authentikApiToken: token.optional(),
  cloudflareDnsApiToken: token.optional(),
  npmApiPassword: password.optional(),
  githubApiToken: token.optional(),
});

export type MovedSettingKey = keyof z.infer<typeof MovedSettingsSchema>;
export type SecretSettingKey = keyof z.infer<typeof SecretSettingsSchema>;
export type ConfigKey = MovedSettingKey | SecretSettingKey;

export const MOVED_SETTINGS_KEYS = Object.keys(MovedSettingsSchema.shape) as MovedSettingKey[];
export const SECRET_SETTINGS_KEYS = Object.keys(SecretSettingsSchema.shape) as SecretSettingKey[];

export type SettingGroup = 'general' | 'proxy' | 'authentik' | 'cloudflare' | 'github';

export interface SettingDef {
  // The environment variable that overrides the stored value when set and
  // non-empty -- the same name each value was read from before #64.
  envVar: string;
  group: SettingGroup;
  secret: boolean;
  // The data/ file that set the variable before #64, named in the Settings
  // page's env-pinned refusal so an operator knows where to remove it.
  // Absent for githubApiToken, which is new and never had a file.
  envFile?: EnvFile;
}

export type EnvFile = 'authentik.env' | 'cloudflare-api.env' | 'nginx-proxy-manager.env';

export const SETTING_DEFS: Record<ConfigKey, SettingDef> = {
  authentikApiUrl: { envVar: 'AUTHENTIK_API_URL', group: 'authentik', secret: false, envFile: 'authentik.env' },
  authentikApiToken: { envVar: 'AUTHENTIK_API_TOKEN', group: 'authentik', secret: true, envFile: 'authentik.env' },
  authentikAdminGroup: { envVar: 'AUTHENTIK_ADMIN_GROUP', group: 'authentik', secret: false, envFile: 'authentik.env' },
  authentikBuiltinAdminGroup: { envVar: 'AUTHENTIK_BUILTIN_ADMIN_GROUP', group: 'authentik', secret: false, envFile: 'authentik.env' },
  authentikGroupLadder: { envVar: 'AUTHENTIK_GROUP_LADDER', group: 'authentik', secret: false, envFile: 'authentik.env' },
  authentikOutpostName: { envVar: 'AUTHENTIK_OUTPOST_NAME', group: 'authentik', secret: false, envFile: 'authentik.env' },
  authentikOutpostPort: { envVar: 'AUTHENTIK_OUTPOST_PORT', group: 'authentik', secret: false, envFile: 'authentik.env' },
  authentikAuthorizationFlowSlug: { envVar: 'AUTHENTIK_AUTHORIZATION_FLOW_SLUG', group: 'authentik', secret: false, envFile: 'authentik.env' },
  authentikInvalidationFlowSlug: { envVar: 'AUTHENTIK_INVALIDATION_FLOW_SLUG', group: 'authentik', secret: false, envFile: 'authentik.env' },
  authentikOidcSigningKeyName: { envVar: 'AUTHENTIK_OIDC_SIGNING_KEY_NAME', group: 'authentik', secret: false, envFile: 'authentik.env' },
  webUiAuthMode: { envVar: 'WEB_UI_AUTH_MODE', group: 'general', secret: false, envFile: 'authentik.env' },
  cloudflareDnsApiToken: { envVar: 'CLOUDFLARE_DNS_API_TOKEN', group: 'cloudflare', secret: true, envFile: 'cloudflare-api.env' },
  // issue #73: these three now sit in the proxy group -- the Settings page
  // shows them on the Proxy tab, only while the Nginx Proxy Manager driver
  // is selected, rather than on their own tab. envVar/envFile unchanged.
  npmApiUrl: { envVar: 'NPM_API_URL', group: 'proxy', secret: false, envFile: 'nginx-proxy-manager.env' },
  npmApiEmail: { envVar: 'NPM_API_EMAIL', group: 'proxy', secret: false, envFile: 'nginx-proxy-manager.env' },
  npmApiPassword: { envVar: 'NPM_API_PASSWORD', group: 'proxy', secret: true, envFile: 'nginx-proxy-manager.env' },
  githubApiToken: { envVar: 'GITHUB_API_TOKEN', group: 'github', secret: true },
};

export function isSecretSettingKey(key: string): key is SecretSettingKey {
  return (SECRET_SETTINGS_KEYS as string[]).includes(key);
}

// The schema that validates one key's value, whichever of the two objects
// it lives in.
export function settingSchema(key: ConfigKey): z.ZodTypeAny {
  return isSecretSettingKey(key)
    ? SecretSettingsSchema.shape[key]
    : MovedSettingsSchema.shape[key];
}
