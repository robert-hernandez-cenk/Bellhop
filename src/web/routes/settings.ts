import { Router } from 'express';
import { isAdminOf, requireAdminGroup } from '../auth.ts';
import { logWarn } from '../../lib/log.ts';
import {
  loadInventory,
  saveInventory,
  refreshInventory,
  SettingsSchema,
  SETTINGS_KEYS,
  assignSetting,
  type Inventory,
  type Settings,
} from '../../lib/inventory.ts';
import { listDrivers, DEFAULT_PROXY_DRIVER_ID } from '../../lib/proxy/index.ts';
import { managesProxy } from '../../lib/proxy/driver.ts';
import { ACME_DNS_PROVIDERS, DEFAULT_ACME_DNS_PROVIDER } from '../../lib/proxy/ids.ts';
import { clearSecret, configValueAt, storedSecretKeys, writeSecret, type ConfigSource } from '../../lib/config.ts';
import { refreshManagedWebLoginIfUsed, WEB_LOGIN_KEYS, webLoginStatus } from '../login/config.ts';
import { managedWebLogin, refreshManagedWebLogin } from '../login/managed.ts';
import { adminGroupsWith } from '../../lib/authentik-config.ts';
import {
  SECRET_SETTINGS_KEYS,
  SETTING_DEFS,
  isSecretSettingKey,
  settingSchema,
  type ConfigKey,
  type SecretSettingKey,
} from '../../lib/settings-defs.ts';

// The keys an environment variable can override (issue #64): every moved
// setting and every secret. Any other SETTINGS_KEYS entry lives only in the
// store.
function isConfigKey(key: string): key is ConfigKey {
  return Object.hasOwn(SETTING_DEFS, key);
}

// The 400 a web write gets for a key its environment variable pins
// (contracts/settings-api.md). Exported for its test: the no-file form only
// applies to githubApiToken, the one secret that never had a data/ file.
// Names the restart because a running service keeps a variable it loaded
// at startup (dotenv included) until it restarts.
export function envPinnedError(key: ConfigKey): string {
  const { envVar, envFile } = SETTING_DEFS[key];
  const where = envFile === undefined ? '' : ` (or remove it from data/${envFile})`;
  return `${key} is set by the environment variable ${envVar} -- unset ${envVar}${where} and restart the service to manage it here`;
}

// Where each non-secret setting's effective value comes from. A key with no
// environment variable can only be 'settings' or 'none'. Read through
// configValueAt with this route's own inventoryPath (never the registered
// store), so the answer always matches the database these routes write.
function settingSources(inv: Inventory, inventoryPath: string): Record<string, ConfigSource> {
  const sources: Record<string, ConfigSource> = {};
  for (const key of SETTINGS_KEYS) {
    sources[key] = isConfigKey(key)
      ? configValueAt(inventoryPath, key).source
      : inv[key] !== undefined
        ? 'settings'
        : 'none';
  }
  return sources;
}

interface EnvironmentPin {
  variable: string;
  value?: string;
  stored: boolean;
  storedValue?: string;
}

// Every key whose environment variable is currently set (non-empty), so the
// page can show it read-only. A non-secret entry carries the effective value
// it is pinned to; a secret entry never does -- its value must not reach any
// response (contracts/settings-api.md). `stored` says whether the store
// also holds a copy, so an operator can confirm the one-time import landed
// before deleting the data/*.env file that pins it; `storedValue` is that
// copy, for a non-secret key only. The copy is read from the inventory
// (non-secret) or the secret_settings key list rather than through
// configValueAt, which would re-validate it and throw on a malformed row.
function environmentPins(inv: Inventory, inventoryPath: string): Record<string, EnvironmentPin> {
  const pins: Record<string, EnvironmentPin> = {};
  const storedSecrets = storedSecretKeys(inventoryPath);
  for (const key of Object.keys(SETTING_DEFS) as ConfigKey[]) {
    const def = SETTING_DEFS[key];
    const effective = configValueAt(inventoryPath, key);
    if (effective.source !== 'environment') continue;
    if (isSecretSettingKey(key)) {
      pins[key] = { variable: def.envVar, stored: storedSecrets.has(key) };
      continue;
    }
    const storedValue = inv[key];
    pins[key] =
      storedValue === undefined
        ? { variable: def.envVar, value: effective.value, stored: false }
        : { variable: def.envVar, value: effective.value, stored: true, storedValue };
  }
  return pins;
}

// Whether each secret has an effective value and where it comes from --
// never the value, nor any part of it (issue #64, research R10). Read with
// this route's own inventoryPath, like settingSources.
function secretStatus(inventoryPath: string): Record<SecretSettingKey, { set: boolean; source: ConfigSource }> {
  const status = {} as Record<SecretSettingKey, { set: boolean; source: ConfigSource }>; // safe: filled for every key below
  for (const key of SECRET_SETTINGS_KEYS) {
    const effective = configValueAt(inventoryPath, key);
    status[key] = { set: effective.value !== undefined, source: effective.source };
  }
  return status;
}

function currentSettings(inv: Inventory): Settings {
  const settings: Settings = {};
  for (const key of SETTINGS_KEYS) {
    const value = inv[key];
    if (value !== undefined) assignSetting(settings, key, value);
  }
  return settings;
}

// The value that is derived rather than configured (issue #124):
// set-guest-vpn's LAN gateway comes from each host's own midScheme.
// Shown read-only so an admin can see what they actually resolve to.
function derivedValues(inv: Inventory) {
  return {
    lanGateways: inv.hosts
      .filter((h) => h.midScheme)
      .map((h) => ({ host: h.name, gateway: h.midScheme!.gateway })),
  };
}

// Every registered proxy driver, in registration order (Caddy, Caddy (admin
// API), nginx, Nginx Proxy Manager, then None) -- issue #33: the Settings
// page's dropdown is populated from this rather than a hardcoded option
// list, so a future driver needs no client change. Independent of inventory: every driver is always listed, whether
// or not it's the one currently active.
function proxyDriversInfo() {
  return listDrivers().map((driver) => ({
    id: driver.id,
    label: driver.label,
    defaultConfigPath: driver.defaultConfigPath,
    suggestedStatusPagePath: driver.statusPage?.suggestedPath ?? null,
    managesProxy: managesProxy(driver),
    // Which TLS sources this driver can serve, in TLS_SOURCES order, and the
    // one an unset tlsSource means for it (issue #72) -- the Settings page
    // derives the TLS source dropdown, its unsupported warning, and which
    // certificate fields to show from these alone.
    tlsSources: [...driver.capabilities.tlsSources],
    defaultTlsSource: driver.capabilities.defaultTlsSource,
    usesCertResolver: driver.usesCertResolver ?? false,
    usesApiUrl: driver.usesApiUrl ?? false,
    // true only for the Nginx Proxy Manager driver (issue #73) -- the
    // Settings page shows its npmApiUrl/npmApiEmail/npmApiPassword fields
    // on the Proxy tab only for a driver that sets this.
    usesNpmApi: driver.usesNpmApi ?? false,
    configPathNote: driver.configPathNote ?? null,
  }));
}

// Shared by GET and PATCH so the two can never drift on shape -- both
// return the current settings/derived values plus the static driver list/
// default, the last two being the same on every call regardless of what, if
// anything, was just written.
function settingsResponse(inv: Inventory, inventoryPath: string) {
  return {
    settings: currentSettings(inv),
    derived: derivedValues(inv),
    proxyDrivers: proxyDriversInfo(),
    defaultProxyDriver: DEFAULT_PROXY_DRIVER_ID,
    // The DNS providers tlsSource 'acme-dns' can use and the one an unset
    // acmeDnsProvider means (issue #72) -- same "independent of inventory,
    // same on every call" shape as proxyDrivers/defaultProxyDriver above, so
    // the Settings page's dropdown is populated from this rather than a
    // hardcoded list.
    acmeDnsProviders: [...ACME_DNS_PROVIDERS],
    defaultAcmeDnsProvider: DEFAULT_ACME_DNS_PROVIDER,
    // Issue #64: `settings` above stays the *stored* values (what the inputs
    // edit); these say where each effective value comes from, and which keys
    // an environment variable currently pins.
    sources: settingSources(inv, inventoryPath),
    environment: environmentPins(inv, inventoryPath),
    secrets: secretStatus(inventoryPath),
    // Which source signs people in (#85); no secret of any kind. Callers
    // refresh the managed login first so this is current, not cached.
    webLogin: webLoginStatus(),
  };
}

export function settingsRoutes(inventory: Inventory, inventoryPath: string): Router {
  const router = Router();
  router.use(requireAdminGroup);

  router.get('/', async (_req, res) => {
    // The flagged guest and its client are read again on every settings read
    // (admin only, so cheap), so the status shows an edit or a rotation now.
    await refreshManagedWebLoginIfUsed();
    res.json(settingsResponse(inventory, inventoryPath));
  });

  router.patch('/', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // One unknown-key check over both lists (issue #64): a body may mix
    // non-secret settings and secrets.
    const unknown = Object.keys(body).filter(
      (k) => !(SETTINGS_KEYS as string[]).includes(k) && !isSecretSettingKey(k)
    );
    if (unknown.length > 0) {
      res.status(400).json({ error: `Unknown setting(s): ${unknown.join(', ')}` });
      return;
    }

    // null (or '') clears a setting; any other value must satisfy the same
    // schema set-config validates against, so both paths reject identically.
    // Every key is validated before anything is written. An error names the
    // key and the schema's fixed message, never the value: a secret pasted
    // into the wrong field must not come back in a response.
    const updates: Partial<Settings> = {};
    const secretUpdates = new Map<SecretSettingKey, string | undefined>();
    for (const [rawKey, raw] of Object.entries(body)) {
      const value = raw === null || raw === '' ? undefined : raw;
      if (value !== undefined && typeof value !== 'string') {
        res.status(400).json({ error: `${rawKey} must be a string or null` });
        return;
      }
      if (isSecretSettingKey(rawKey)) {
        if (value !== undefined) {
          const parsed = settingSchema(rawKey).safeParse(value);
          if (!parsed.success) {
            res.status(400).json({ error: parsed.error.issues.map((i) => `${rawKey}: ${i.message}`).join('\n') });
            return;
          }
        }
        secretUpdates.set(rawKey, value);
        continue;
      }
      const key = rawKey as keyof Settings; // safe: the unknown-key check above admitted only SETTINGS_KEYS and secrets
      if (value === undefined) {
        updates[key] = undefined;
        continue;
      }
      const parsed = SettingsSchema.safeParse({ [key]: value });
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((i) => `${key}: ${i.message}`).join('\n') });
        return;
      }
      assignSetting(updates, key, value);
    }

    // A key its environment variable pins (issue #64, research R9) would be
    // stored but never take effect, so the page refuses it -- clearing
    // included -- rather than appear to save. Nothing in the request is
    // written. The CLI's set-config stores and warns instead: its
    // environment is not necessarily the service's.
    for (const key of Object.keys(body)) {
      if (isConfigKey(key) && configValueAt(inventoryPath, key).source === 'environment') {
        res.status(400).json({ error: envPinnedError(key) });
        return;
      }
    }

    // Issue #64 US6: refuse a change that would lock the real (never the
    // impersonated) requester out of admin entirely, computed without
    // writing anything. An impersonating admin never reaches here at all --
    // requireAdminGroup already 403'd on the overlaid, non-admin
    // req.user.groups before this handler ran -- so this guard only ever
    // sees a real admin's own groups. Skipped for the synthetic local
    // operator, who has no real account to lock out.
    const ADMIN_GROUP_KEYS = ['authentikAdminGroup', 'authentikBuiltinAdminGroup'] as const;
    const adminGroupOverrides: { authentikAdminGroup?: string; authentikBuiltinAdminGroup?: string } = {};
    for (const key of ADMIN_GROUP_KEYS) {
      if (key in updates) adminGroupOverrides[key] = updates[key];
    }
    // The admin group names as they will be once this request is saved --
    // shared by both guards below.
    const adminGroupsAfter = adminGroupsWith(adminGroupOverrides);
    if (Object.keys(adminGroupOverrides).length > 0) {
      const realUser = req.realUser ?? req.user;
      if (realUser && !realUser.localOperator) {
        if (!isAdminOf(realUser.groups, adminGroupsAfter)) {
          // Names whichever of the two fields the request body touches --
          // the first one, in the body's own key order, when both do.
          const key = Object.keys(body).find((k): k is (typeof ADMIN_GROUP_KEYS)[number] =>
            (ADMIN_GROUP_KEYS as readonly string[]).includes(k)
          )!; // safe: adminGroupOverrides is non-empty, so at least one of these keys is in body
          res.status(409).json({
            error: `Refusing to change ${key}: you would no longer be an administrator (your groups: ${realUser.groups.join(', ')})`,
          });
          return;
        }
      }
    }

    // Refuse switching webUiAuthMode to oidc until an administrator has
    // proved they can sign in (#69 US4, FR-020): otherwise every later
    // request, including the one needed to undo it, would be refused or lose
    // this page. Checked in the contract's order -- the four OIDC settings
    // are complete once this request is saved, then the real requester
    // (never an impersonated view) has a web-login session. A session is
    // honored in none mode too (research R6), which is what lets the operator
    // prove they can sign in before turning it on. Clearing the mode or
    // setting none needs no such check: confirming that leaving oidc is
    // deliberate is the Settings page's job (client-side). A resend of oidc
    // while it is already in force changes nothing, so it is not refused.
    //
    // The completeness check also runs on every save while oidc stays in
    // force: clearing a login setting then would make sign-in impossible
    // and lock everyone out of this page within one re-check interval.
    // Changing a value is allowed (only the provider could tell whether the
    // new one works); the CLI remains the recovery path (FR-021).
    //
    // The admin check is on the real identity under the post-save admin
    // groups, and is not redundant with requireAdminGroup or the lockout
    // guard: requireAdminGroup judges the impersonation-overlaid groups, and
    // the lockout guard only runs when this request changes admin groups, so a
    // real non-admin whose impersonation entry names an admin group (entries
    // persist until restart) passes both.
    const modeBefore = configValueAt(inventoryPath, 'webUiAuthMode').value;
    const modeAfter = 'webUiAuthMode' in updates ? updates.webUiAuthMode : modeBefore;
    const switchingToOidc = modeAfter === 'oidc' && modeBefore !== 'oidc';
    if (modeAfter === 'oidc') {
      // The effective value of each login setting after this request: the
      // value it sets or clears, else what is in force now. No key in the
      // body can be env-pinned (refused above), so a body key's effective
      // value is exactly what it writes. While oidc merely stays in force,
      // only a key this request clears counts, so an unrelated save is never
      // refused for a gap it did not make.
      const missing = WEB_LOGIN_KEYS.filter((key) => {
        if (isSecretSettingKey(key) && secretUpdates.has(key)) return secretUpdates.get(key) === undefined;
        if (key in updates) return updates[key as keyof Settings] === undefined;
        return switchingToOidc && configValueAt(inventoryPath, key).value === undefined;
      });
      // A usable flagged guest (#85) signs people in whenever the custom set
      // is not complete, so it counts as configured: nobody is locked out by
      // a gap in the custom values. Read fresh, so this judges Authentik's
      // current state, and only when there is a gap to excuse. It does not
      // excuse clearing a value while oidc stays in force and the complete
      // custom set is what signs people in now: existing sessions belong to
      // that client, and a re-check against the flagged guest's different
      // client would sign everyone out.
      if (missing.length > 0) await refreshManagedWebLogin();
      const customInEffect = !switchingToOidc && webLoginStatus().source === 'custom';
      if (missing.length > 0 && (customInEffect || managedWebLogin() === undefined)) {
        res.status(409).json({
          error: switchingToOidc
            ? `Web login is not configured: flag Bellhop's own guest in its Advanced settings, or set ${missing.join(', ')} on the Web login tab first`
            : `Refusing to clear ${missing.join(', ')} while webUiAuthMode is oidc: nobody could sign in. Set webUiAuthMode to none first`,
        });
        return;
      }
    }
    if (switchingToOidc) {
      if (!(req.realUser ?? req.user)?.viaOidc) {
        res.status(409).json({
          error: 'Sign in through /auth/login first, so Bellhop can confirm you can still sign in after this change',
        });
        return;
      }
      const requester = (req.realUser ?? req.user)!; // safe: viaOidc above proved a user exists
      if (!isAdminOf(requester.groups, adminGroupsAfter)) {
        res.status(409).json({
          error: `You are signed in as ${requester.username}, who would not be an admin after this change`,
        });
        return;
      }
    }

    // The mode in force before this write, for the audit line below. No
    // env pin can be in play here: the pinned-key check above refused one.
    const authModeBefore = 'webUiAuthMode' in updates ? configValueAt(inventoryPath, 'webUiAuthMode').value : undefined;

    try {
      // Partial<Settings> rather than Record<string, ...> so this spread
      // still produces something assignable to Inventory. An explicitly
      // undefined property is what clears the row in saveInventory.
      if (Object.keys(updates).length > 0) {
        const onDisk = loadInventory(inventoryPath);
        saveInventory(inventoryPath, { ...onDisk, ...updates });
      }
      // Secrets never pass through saveInventory: they live only in the
      // secret_settings table (research R1).
      for (const [key, value] of secretUpdates) {
        if (value === undefined) clearSecret(inventoryPath, key);
        else writeSecret(inventoryPath, key, value);
      }
    } catch (err) {
      // Everything the request body itself could get wrong (unknown key,
      // wrong type, schema validation) is already rejected with 400 above
      // -- a throw here means the database read/write itself failed
      // (corrupt file, held lock), which is a server error, not a client
      // one.
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    // Leaving oidc turns sign-in off for the whole web UI, so it is worth a
    // line in the service log naming who did it (the real user, never an
    // impersonated view). An unset mode is none.
    if (authModeBefore === 'oidc' && 'webUiAuthMode' in updates && updates.webUiAuthMode !== 'oidc') {
      const who = (req.realUser ?? req.user)?.username ?? 'unknown';
      logWarn(
        `Sign-in mode changed from oidc to ${updates.webUiAuthMode ?? 'none'} by ${who} -- the web UI no longer requires sign-in`
      );
    }
    if (authModeBefore !== 'oidc' && 'webUiAuthMode' in updates && updates.webUiAuthMode === 'oidc') {
      const who = (req.realUser ?? req.user)?.username ?? 'unknown';
      logWarn(`webUiAuthMode set to oidc by ${who}`);
    }
    // Reflect the write in the shared in-memory object immediately rather
    // than waiting for the next request's reload middleware.
    refreshInventory(inventory, inventoryPath);
    await refreshManagedWebLoginIfUsed();
    res.json(settingsResponse(inventory, inventoryPath));
  });

  return router;
}
