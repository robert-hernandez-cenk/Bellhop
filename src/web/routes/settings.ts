import { Router } from 'express';
import { requireAdminGroup } from '../auth.ts';
import {
  loadInventory,
  saveInventory,
  refreshInventory,
  findProxyEntry,
  SettingsSchema,
  SETTINGS_KEYS,
  assignSetting,
  type Inventory,
  type Settings,
} from '../../lib/inventory.ts';
import { listDrivers, DEFAULT_PROXY_DRIVER_ID } from '../../lib/proxy/index.ts';
import { managesProxy } from '../../lib/proxy/driver.ts';
import { CADDY_TLS_MODES } from '../../lib/proxy/ids.ts';
import { DEFAULT_CADDY_TLS } from '../../lib/proxy/routes.ts';
import { clearSecret, configValueAt, writeSecret, type ConfigSource } from '../../lib/config.ts';
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
export function envPinnedError(key: ConfigKey): string {
  const { envVar, envFile } = SETTING_DEFS[key];
  const where = envFile === undefined ? '' : ` (or remove it from data/${envFile})`;
  return `${key} is set by the environment variable ${envVar} -- unset ${envVar}${where} to manage it here`;
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

// Every key whose environment variable is currently set (non-empty), so the
// page can show it read-only. A non-secret entry carries the effective value
// it is pinned to; a secret entry never does -- its value must not reach any
// response (contracts/settings-api.md).
function environmentPins(inventoryPath: string): Record<string, { variable: string; value?: string }> {
  const pins: Record<string, { variable: string; value?: string }> = {};
  for (const key of Object.keys(SETTING_DEFS) as ConfigKey[]) {
    const def = SETTING_DEFS[key];
    const effective = configValueAt(inventoryPath, key);
    if (effective.source !== 'environment') continue;
    pins[key] = def.secret ? { variable: def.envVar } : { variable: def.envVar, value: effective.value };
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

// The two values that are derived rather than configured (issue #124):
// set-guest-vpn's LAN gateway comes from each host's own midScheme, and
// the Windows service's firewall scope comes from the proxy: true entry.
// Shown read-only so an admin can see what they actually resolve to.
function derivedValues(inv: Inventory) {
  const proxy = findProxyEntry(inv);
  return {
    lanGateways: inv.hosts
      .filter((h) => h.midScheme)
      .map((h) => ({ host: h.name, gateway: h.midScheme!.gateway })),
    proxy: proxy?.ip ? { name: proxy.name, ip: proxy.ip } : null,
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
    usesSharedCertificate: driver.usesSharedCertificate ?? false,
    usesCertResolver: driver.usesCertResolver ?? false,
    usesApiUrl: driver.usesApiUrl ?? false,
    // true only for the two Caddy drivers (issue #51) -- the Settings page
    // shows the Caddy TLS dropdown only for a driver that sets this.
    usesCaddyTls: driver.usesCaddyTls ?? false,
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
    // The four ways the two Caddy drivers can obtain a certificate (issue
    // #51) and which one an unset proxyCaddyTls resolves to -- same
    // "independent of inventory, same on every call" shape as
    // proxyDrivers/defaultProxyDriver above, so the Settings page's Caddy
    // TLS dropdown is populated from this rather than a hardcoded list.
    caddyTlsModes: [...CADDY_TLS_MODES],
    defaultCaddyTls: DEFAULT_CADDY_TLS,
    // Issue #64: `settings` above stays the *stored* values (what the inputs
    // edit); these say where each effective value comes from, and which keys
    // an environment variable currently pins.
    sources: settingSources(inv, inventoryPath),
    environment: environmentPins(inventoryPath),
    secrets: secretStatus(inventoryPath),
  };
}

export function settingsRoutes(inventory: Inventory, inventoryPath: string): Router {
  const router = Router();
  router.use(requireAdminGroup);

  router.get('/', (_req, res) => {
    res.json(settingsResponse(inventory, inventoryPath));
  });

  router.patch('/', (req, res) => {
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
    // Reflect the write in the shared in-memory object immediately rather
    // than waiting for the next request's reload middleware.
    refreshInventory(inventory, inventoryPath);
    res.json(settingsResponse(inventory, inventoryPath));
  });

  return router;
}
