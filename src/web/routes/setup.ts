import express, { type Request, type Response } from 'express';
import {
  SettingsSchema,
  assignSetting,
  loadInventory,
  refreshInventory,
  saveInventory,
  type HostEntry,
  type Inventory,
} from '../../lib/inventory.ts';
import type { MidScheme } from '../../lib/inventory.ts';
import { SETUP_COOKIE, SETUP_COOKIE_OPTIONS, requireSetupAuth } from '../setup/gate.ts';
import { REQUIRED_SETUP_STEPS, SetupIncompleteError, type SetupService } from '../setup/service.ts';

export interface HostSummary {
  name: string;
  address: string;
  user: string;
  port: number;
  midScheme?: MidScheme;
}

export function hostSummary(host: HostEntry): HostSummary {
  return {
    name: host.name,
    address: host.ssh_target,
    user: host.ssh_user,
    port: host.ssh_port ?? 22,
    ...(host.midScheme ? { midScheme: host.midScheme } : {}),
  };
}

const BASICS_KEYS = ['domain', 'dnsServer', 'backupStorage', 'nfsServer'] as const;

export function basicsSettings(inventory: Inventory): Partial<Pick<Inventory, (typeof BASICS_KEYS)[number]>> {
  const settings: Partial<Pick<Inventory, (typeof BASICS_KEYS)[number]>> = {};
  for (const key of BASICS_KEYS) {
    if (inventory[key] !== undefined) settings[key] = inventory[key];
  }
  return settings;
}

// The first-run setup walkthrough's routes (issue #86,
// contracts/http-setup.md): the token exchange at GET /setup and the
// /api/setup API. Mounted ahead of requireAuth, since there is no sign-in
// during setup; the setup cookie is the authorization.
export function setupRoutes(setup: SetupService): express.Router {
  const router = express.Router();

  // The setup address. A valid token becomes the setup cookie and the
  // browser is sent back without the token in its address bar; a wrong
  // one gets no cookie, and the page then asks for the setup address. With
  // no token, the client app serves the page (server.ts's SPA fallback).
  router.get('/setup', (req: Request, res: Response, next) => {
    if (!setup.isPending()) {
      res.redirect(303, '/');
      return;
    }
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (token === undefined) {
      next();
      return;
    }
    if (setup.tokenMatches(token)) res.cookie(SETUP_COOKIE, token, SETUP_COOKIE_OPTIONS);
    res.redirect(303, '/setup');
  });

  const api = express.Router();

  // No cookie needed: the client uses it to tell "setup is over" apart from
  // "this browser has not opened the setup address".
  api.get('/status', (_req, res) => {
    res.json({ phase: setup.phase() });
  });

  api.use(requireSetupAuth(setup));

  // The walkthrough reads and writes the same shared inventory object the
  // rest of the app does, refreshed from disk first like every /api route.
  api.use((_req, _res, next) => {
    const opts = setup.opts!; // safe: requireSetupAuth only passes while pending, which needs opts
    refreshInventory(opts.inventory, opts.inventoryPath);
    next();
  });

  api.get('/state', (_req, res) => {
    const { inventory } = setup.opts!; // safe: see above
    res.json({
      completedSteps: setup.state().completedSteps,
      requiredSteps: [...REQUIRED_SETUP_STEPS],
      hosts: inventory.hosts.map(hostSummary),
      settings: basicsSettings(inventory),
      storages: [...new Set(inventory.hosts.flatMap((h) => (h.storages ?? []).map((s) => s.name)))].sort(),
    });
  });

  // Step 2 (FR-017): the same SettingsSchema rules set-config and the
  // Settings page apply, saved through the same load-assign-save path. An
  // empty optional value clears it.
  api.put('/basics', (req, res) => {
    const opts = setup.opts!; // safe: see above
    const body = (req.body ?? {}) as Record<string, unknown>;
    const values: Record<string, string | undefined> = {};
    for (const key of BASICS_KEYS) {
      const raw = body[key];
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        res.status(400).json({ error: `${key}: must be a string` });
        return;
      }
      values[key] = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
    }
    if (values.domain === undefined) {
      res.status(400).json({ error: 'domain: is required' });
      return;
    }
    const parsed = SettingsSchema.pick({ domain: true, dnsServer: true, backupStorage: true, nfsServer: true }).safeParse(values);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n') });
      return;
    }
    const updated = { ...loadInventory(opts.inventoryPath) };
    for (const key of BASICS_KEYS) assignSetting(updated, key, values[key]);
    saveInventory(opts.inventoryPath, updated);
    refreshInventory(opts.inventory, opts.inventoryPath);
    const { completedSteps } = setup.completeStep('basics');
    res.json({ settings: basicsSettings(opts.inventory), completedSteps });
  });

  // Finish (FR-019/FR-007): refused while a required step is incomplete;
  // otherwise setup ends for good and the setup cookie is cleared.
  api.post('/finish', (_req, res) => {
    try {
      setup.finish();
    } catch (err) {
      if (err instanceof SetupIncompleteError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    res.clearCookie(SETUP_COOKIE, SETUP_COOKIE_OPTIONS);
    res.json({ redirect: '/' });
  });

  router.use('/api/setup', api);
  return router;
}
