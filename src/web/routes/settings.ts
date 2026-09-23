import { Router } from 'express';
import { requireAdminGroup } from '../auth.ts';
import {
  loadInventory,
  saveInventory,
  refreshInventory,
  findCaddyEntry,
  SettingsSchema,
  SETTINGS_KEYS,
  type Inventory,
  type Settings,
} from '../../lib/inventory.ts';

function currentSettings(inv: Inventory): Settings {
  const settings: Settings = {};
  for (const key of SETTINGS_KEYS) {
    const value = inv[key];
    if (value !== undefined) settings[key] = value;
  }
  return settings;
}

// The two values that are derived rather than configured (issue #124):
// set-guest-vpn's LAN gateway comes from each host's own midScheme, and
// the Windows service's firewall scope comes from the caddy: true entry.
// Shown read-only so an admin can see what they actually resolve to.
function derivedValues(inv: Inventory) {
  const caddy = findCaddyEntry(inv);
  return {
    lanGateways: inv.hosts
      .filter((h) => h.midScheme)
      .map((h) => ({ host: h.name, gateway: h.midScheme!.gateway })),
    caddy: caddy?.ip ? { name: caddy.name, ip: caddy.ip } : null,
  };
}

export function settingsRoutes(inventory: Inventory, inventoryPath: string): Router {
  const router = Router();
  router.use(requireAdminGroup);

  router.get('/', (_req, res) => {
    res.json({ settings: currentSettings(inventory), derived: derivedValues(inventory) });
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
      updates[key] = value;
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
    res.json({ settings: currentSettings(inventory), derived: derivedValues(inventory) });
  });

  return router;
}
