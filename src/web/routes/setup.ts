import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { ensureBellhopKey, keyFromFile } from '../../lib/bellhop-key.ts';
import type { OperationDeps } from '../../operations/types.ts';
import {
  HostEndpointSchema,
  InstallKeyRequestSchema,
  SetupActionError,
  installKey,
  saveHost,
  suggestMidSchemeFor,
  testHost,
} from '../setup/proxmox.ts';
import {
  MidSchemeSchema,
  SettingsSchema,
  assignSetting,
  loadInventory,
  refreshInventory,
  saveInventory,
  type HostEntry,
  type Inventory,
} from '../../lib/inventory.ts';
import type { MidScheme } from '../../lib/inventory.ts';
import { ProxyChoiceSchema, proxyStepState, saveProxyChoice } from '../setup/proxy.ts';
import { SETUP_COOKIE, SETUP_COOKIE_OPTIONS, requireSetupAuth } from '../setup/gate.ts';
import { REQUIRED_SETUP_STEPS, SetupIncompleteError, type SetupService } from '../setup/service.ts';

export interface HostSummary {
  name: string;
  address: string;
  user: string;
  port: number;
  midScheme?: MidScheme;
  // A host with no midScheme yet: what the walkthrough offers to start from.
  suggestedMidScheme?: MidScheme;
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
export type SetupRouteDeps = Pick<OperationDeps, 'ssh' | 'authentik' | 'cloudflare'>;

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('\n');
}

export function setupRoutes(setup: SetupService, routeDeps?: SetupRouteDeps): express.Router {
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

  // The deps the step-1 actions run with: the shared inventory plus the
  // service's SSH client (the one transport).
  const opDeps = (): OperationDeps => {
    const opts = setup.opts!; // safe: see above
    if (!routeDeps) throw new Error('setup routes were mounted without SSH access');
    return { ...routeDeps, inventory: opts.inventory, inventoryPath: opts.inventoryPath };
  };

  // A SetupActionError carries its own status and a message that is safe to
  // show; anything else is a bug and goes to the error handler.
  const handle =
    (fn: (req: Request, res: Response) => Promise<void> | void) =>
    async (req: Request, res: Response, next: express.NextFunction) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof SetupActionError) res.status(err.status).json({ error: err.message });
        else next(err);
      }
    };

  // The message names the field and never echoes a value, so a password in
  // the body can't leak through a validation error.
  const parseBody = <T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw new SetupActionError(zodMessage(parsed.error), 400);
    return parsed.data;
  };

  const requireKey = () => {
    const key = setup.key();
    if (!key) throw new SetupActionError("choose or generate Bellhop's SSH key first", 400);
    return key;
  };

  api.get(
    '/state',
    handle(async (_req, res) => {
      const { inventory } = setup.opts!; // safe: see above
      const key = setup.key();
      const hosts: HostSummary[] = [];
      for (const host of inventory.hosts) {
        const summary = hostSummary(host);
        if (!host.midScheme && routeDeps) {
          const suggested = await suggestMidSchemeFor(routeDeps.ssh, inventory, host);
          if (suggested) summary.suggestedMidScheme = suggested;
        }
        hosts.push(summary);
      }
      res.json({
        completedSteps: setup.state().completedSteps,
        requiredSteps: [...REQUIRED_SETUP_STEPS],
        hosts,
        settings: basicsSettings(inventory),
        key: key ? { mode: key.mode, path: key.path, publicKey: key.authorizedKeysLine } : null,
        storages: [...new Set(inventory.hosts.flatMap((h) => (h.storages ?? []).map((s) => s.name)))].sort(),
      });
    })
  );

  // Step 1 (FR-008): Bellhop's own key, generated or a named file.
  api.post(
    '/key',
    handle((req, res) => {
      const body = parseBody(
        z.discriminatedUnion('mode', [
          z.object({ mode: z.literal('generated') }),
          z.object({ mode: z.literal('file'), path: z.string().trim().min(1, 'is required') }),
        ]),
        req
      );
      let key;
      try {
        key = body.mode === 'generated' ? ensureBellhopKey(setup.opts!.dataDir) : keyFromFile(body.path);
      } catch (err) {
        throw new SetupActionError((err as Error).message, 400);
      }
      setup.setKey(key);
      res.json({
        mode: key.mode,
        path: key.path,
        publicKey: key.authorizedKeysLine,
        authorizedKeysLine: key.authorizedKeysLine,
      });
    })
  );

  api.post(
    '/hosts/install-key',
    handle(async (req, res) => {
      const key = requireKey();
      const { password, ...endpoint } = parseBody(InstallKeyRequestSchema, req);
      await installKey(opDeps().ssh, endpoint, password, key.authorizedKeysLine);
      res.json({ installed: true });
    })
  );

  api.post(
    '/hosts/test',
    handle(async (req, res) => {
      const key = requireKey();
      res.json(await testHost(opDeps().ssh, parseBody(HostEndpointSchema, req), key.path));
    })
  );

  api.post(
    '/hosts',
    handle(async (req, res) => {
      const key = requireKey();
      const saved = await saveHost(opDeps(), parseBody(HostEndpointSchema, req), key.path);
      const host = hostSummary(saved.host);
      if (!saved.host.midScheme && saved.suggestedMidScheme) host.suggestedMidScheme = saved.suggestedMidScheme;
      res.json({ host, peers: saved.peers });
    })
  );

  // Step 1 is complete once a host has a midScheme (FR-016).
  api.put(
    '/hosts/:name/mid-scheme',
    handle((req, res) => {
      const opts = setup.opts!; // safe: see above
      const name = String(req.params.name);
      if (!opts.inventory.hosts.some((h) => h.name === name)) {
        throw new SetupActionError(`no host named "${name}" in the inventory`, 404);
      }
      const midScheme = parseBody(MidSchemeSchema, req);
      const updated = loadInventory(opts.inventoryPath);
      updated.hosts = updated.hosts.map((h) => (h.name === name ? { ...h, midScheme } : h));
      try {
        saveInventory(opts.inventoryPath, updated);
      } catch (err) {
        throw new SetupActionError((err as Error).message, 400);
      }
      refreshInventory(opts.inventory, opts.inventoryPath);
      const { completedSteps } = setup.completeStep('proxmox');
      res.json({ host: hostSummary(opts.inventory.hosts.find((h) => h.name === name)!), completedSteps });
    })
  );

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

  // Step 3 (#87): the reverse proxy. Reading and saving never touch the
  // proxy; the check (below, US3) is read-only too.
  api.get(
    '/proxy',
    handle((_req, res) => {
      res.json(proxyStepState(setup));
    })
  );

  api.put(
    '/proxy',
    handle((req, res) => {
      res.json({ state: saveProxyChoice(setup, parseBody(ProxyChoiceSchema, req)) });
    })
  );

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
