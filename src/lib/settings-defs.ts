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
  // Comma-separated, ordered low to high; parsed (and deduplicated) by
  // parseGroupLadder in authentik-config.ts.
  authentikGroupLadder: nonEmpty.optional(),
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

export type SettingGroup = 'general' | 'proxy' | 'authentik' | 'cloudflare' | 'nginx-proxy-manager' | 'github';

export interface SettingDef {
  // The environment variable that overrides the stored value when set and
  // non-empty -- the same name each value was read from before #64.
  envVar: string;
  group: SettingGroup;
  secret: boolean;
}

export const SETTING_DEFS: Record<ConfigKey, SettingDef> = {
  authentikApiUrl: { envVar: 'AUTHENTIK_API_URL', group: 'authentik', secret: false },
  authentikApiToken: { envVar: 'AUTHENTIK_API_TOKEN', group: 'authentik', secret: true },
  authentikAdminGroup: { envVar: 'AUTHENTIK_ADMIN_GROUP', group: 'authentik', secret: false },
  authentikBuiltinAdminGroup: { envVar: 'AUTHENTIK_BUILTIN_ADMIN_GROUP', group: 'authentik', secret: false },
  authentikGroupLadder: { envVar: 'AUTHENTIK_GROUP_LADDER', group: 'authentik', secret: false },
  authentikOutpostName: { envVar: 'AUTHENTIK_OUTPOST_NAME', group: 'authentik', secret: false },
  authentikOutpostPort: { envVar: 'AUTHENTIK_OUTPOST_PORT', group: 'authentik', secret: false },
  authentikAuthorizationFlowSlug: { envVar: 'AUTHENTIK_AUTHORIZATION_FLOW_SLUG', group: 'authentik', secret: false },
  authentikInvalidationFlowSlug: { envVar: 'AUTHENTIK_INVALIDATION_FLOW_SLUG', group: 'authentik', secret: false },
  authentikOidcSigningKeyName: { envVar: 'AUTHENTIK_OIDC_SIGNING_KEY_NAME', group: 'authentik', secret: false },
  webUiAuthMode: { envVar: 'WEB_UI_AUTH_MODE', group: 'general', secret: false },
  cloudflareDnsApiToken: { envVar: 'CLOUDFLARE_DNS_API_TOKEN', group: 'cloudflare', secret: true },
  npmApiUrl: { envVar: 'NPM_API_URL', group: 'nginx-proxy-manager', secret: false },
  npmApiEmail: { envVar: 'NPM_API_EMAIL', group: 'nginx-proxy-manager', secret: false },
  npmApiPassword: { envVar: 'NPM_API_PASSWORD', group: 'nginx-proxy-manager', secret: true },
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
