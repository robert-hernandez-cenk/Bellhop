import { Router } from 'express';
import type { AuthentikClient } from '../../lib/authentik-client.ts';
import { requireAdminGroup, requireUserDirectory } from '../auth.ts';

export function usersRoutes(authentik: AuthentikClient): Router {
  const router = Router();
  router.use(requireAdminGroup);
  router.use(requireUserDirectory(authentik));

  router.get('/', async (_req, res) => {
    try {
      res.json(await authentik.listUsers());
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/', async (req, res) => {
    const { username, email, groupIds } = req.body ?? {};
    if (typeof username !== 'string' || username.length === 0) {
      res.status(400).json({ error: 'username is required' });
      return;
    }
    if (typeof email !== 'string' || email.length === 0) {
      res.status(400).json({ error: 'email is required' });
      return;
    }
    let user;
    try {
      user = await authentik.createUser({
        username,
        email,
        groupIds: Array.isArray(groupIds) ? groupIds : [],
      });
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    // The account was already created successfully above -- a failure here
    // (e.g. no recovery flow configured on the Authentik brand) must not be
    // reported as if the whole
    // request failed, or the admin retries and hits a confusing "username
    // already exists" error against an account that was actually created.
    // The recovery link can still be generated later via the standalone
    // POST /:id/recovery-link endpoint.
    try {
      const recoveryLink = await authentik.getRecoveryLink(user.id);
      res.status(201).json({ user, recoveryLink });
    } catch (err) {
      res.status(201).json({
        user,
        recoveryLink: null,
        recoveryLinkError: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const { username, email, groupIds } = req.body ?? {};
      const user = await authentik.updateUser(req.params.id, {
        username: typeof username === 'string' ? username : undefined,
        email: typeof email === 'string' ? email : undefined,
        groupIds: Array.isArray(groupIds) ? groupIds : undefined,
      });
      res.json(user);
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/:id/deactivate', async (req, res) => {
    try {
      const target = await authentik.getUser(req.params.id);
      // Known limitation: req.user.username is resolved from the
      // Caddy-forwarded header at request time, not from :id. An admin who
      // renames their own account via PATCH and then immediately targets
      // their old-username-resolved id here would not match, and this
      // guard would not fire. Not cheaply fixable -- there's no other
      // stable "who is making this request" identifier in this app.
      if (target.username === req.user?.username) {
        res.status(400).json({ error: "You can't deactivate your own account" });
        return;
      }
      res.json(await authentik.setUserActive(req.params.id, false));
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/:id/reactivate', async (req, res) => {
    try {
      res.json(await authentik.setUserActive(req.params.id, true));
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/:id/recovery-link', async (req, res) => {
    try {
      res.json({ recoveryLink: await authentik.getRecoveryLink(req.params.id) });
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const target = await authentik.getUser(req.params.id);
      // Known limitation: req.user.username is resolved from the
      // Caddy-forwarded header at request time, not from :id. An admin who
      // renames their own account via PATCH and then immediately targets
      // their old-username-resolved id here would not match, and this
      // guard would not fire. Not cheaply fixable -- there's no other
      // stable "who is making this request" identifier in this app.
      if (target.username === req.user?.username) {
        res.status(400).json({ error: "You can't delete your own account" });
        return;
      }
      await authentik.deleteUser(req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
