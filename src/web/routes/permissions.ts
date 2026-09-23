import { Router } from 'express';
import { requireAdminGroup } from '../auth.ts';
import {
  loadPermissionRules,
  savePermissionGroup,
  clearPermissionGroup,
  type ResourceRef,
  type PermissionMode,
} from '../../lib/permissions.ts';

function isValidMode(value: unknown): value is PermissionMode {
  return value === 'allow-list' || value === 'block-list';
}

function isValidResources(value: unknown): value is ResourceRef[] {
  return (
    Array.isArray(value) &&
    value.every(
      (r) =>
        r &&
        typeof r === 'object' &&
        (r.type === 'host' || r.type === 'guest') &&
        typeof r.name === 'string' &&
        r.name.length > 0
    )
  );
}

export function permissionsRoutes(inventoryPath: string): Router {
  const router = Router();
  router.use(requireAdminGroup);

  router.get('/', (_req, res) => {
    const rules = loadPermissionRules(inventoryPath);
    res.json([...rules.entries()].map(([groupName, permission]) => ({ groupName, ...permission })));
  });

  router.put('/:group', (req, res) => {
    const { mode, resources } = req.body ?? {};
    if (!isValidMode(mode)) {
      res.status(400).json({ error: "mode must be 'allow-list' or 'block-list'" });
      return;
    }
    if (!isValidResources(resources)) {
      res.status(400).json({ error: "resources must be an array of { type: 'host'|'guest', name: string }" });
      return;
    }
    // Check for duplicate (type, name) pairs
    const seen = new Set<string>();
    for (const r of resources) {
      const key = `${r.type}:${r.name}`;
      if (seen.has(key)) {
        res.status(400).json({ error: 'resources must not contain duplicate entries' });
        return;
      }
      seen.add(key);
    }
    savePermissionGroup(inventoryPath, req.params.group, { mode, resources });
    res.json({ groupName: req.params.group, mode, resources });
  });

  router.delete('/:group', (req, res) => {
    clearPermissionGroup(inventoryPath, req.params.group);
    res.status(204).end();
  });

  return router;
}
