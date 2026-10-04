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
function settingsResponse(inv: Inventory) {
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
  };
}

export function settingsRoutes(inventory: Inventory, inventoryPath: string): Router {
  const router = Router();
  router.use(requireAdminGroup);

  router.get('/', (_req, res) => {
    res.json(settingsResponse(inventory));
  });

  router.patch('/', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(body).filter((k) => !(SETTINGS_KEYS as string[]).includes(k));
    if (unknown.length > 0) {
      res.status(400).json({ error: `Unknown setting(s): ${unknown.join(', ')}` });
      return;
    }

    // null (or '') clears a setting; any other value must satisfy the same
    // schema set-config validates against, so both paths reject identically.
    const updates: Partial<Settings> = {};
    for (const [rawKey, value] of Object.entries(body)) {
      const key = rawKey as keyof Settings;
      if (value === null || value === '') {
        updates[key] = undefined;
        continue;
      }
      if (typeof value !== 'string') {
        res.status(400).json({ error: `${key} must be a string or null` });
        return;
      }
      const parsed = SettingsSchema.safeParse({ [key]: value });
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((i) => `${key}: ${i.message}`).join('\n') });
        return;
      }
      assignSetting(updates, key, value);
    }

    try {
      // Partial<Settings> rather than Record<string, ...> so this spread
      // still produces something assignable to Inventory. An explicitly
      // undefined property is what clears the row in saveInventory.
      const onDisk = loadInventory(inventoryPath);
      saveInventory(inventoryPath, { ...onDisk, ...updates });
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
    res.json(settingsResponse(inventory));
  });

  return router;
}
