import { Router } from 'express';
import type { Inventory } from '../../lib/inventory.ts';
import type { SSHClient } from '../../lib/ssh-client.ts';
import type { AuthentikClient } from '../../lib/authentik-client.ts';
import type { CloudflareClient } from '../../lib/cloudflare-client.ts';
import { getGuestStatuses } from '../../lib/guest-status.ts';
import { filterInventoryForUser, requireResourceAccess } from '../access.ts';
import { isAdminUser } from '../auth.ts';
import { authentikConfig, rungsAtOrAbove } from '../../lib/authentik-config.ts';
import { applyGuestEdits, commitGuestEdit, GuestEditValidationError } from '../../operations/edit-guest.ts';

// Anyone with resource access to a guest may RAISE its auth tier (move to a
// narrower rung, or gate an ungated entry); only an admin may LOWER one
// (move to a broader rung, or clear the gate entirely). The dropdown mirrors
// this by disabling the options it forbids, but the client is not a security
// boundary -- this check is the authoritative one.
//
// Cases are evaluated in order; the first match wins. Clearing the gate is
// checked before ladder membership because an empty value is not a ladder
// member and would otherwise be rejected as unknown. An off-ladder value is
// rejected for admins too: sync-authentik's offLadder list exists to report
// drift that already reached the database, not to make new drift easy.
function authGroupChangeError(
  cur: string | undefined,
  next: string | undefined,
  ladder: string[],
  isAdmin: boolean
): { status: number; error: string } | null {
  if (next === undefined) {
    if (cur === undefined || isAdmin) return null;
    return { status: 403, error: "Only an admin may remove an app's authentication requirement" };
  }
  const nextIdx = ladder.indexOf(next);
  if (nextIdx === -1) {
    return { status: 400, error: `Unknown auth group '${next}' (must be one of: ${ladder.join(', ')})` };
  }
  if (isAdmin) return null;
  if (cur === undefined) return null;
  const curIdx = ladder.indexOf(cur);
  if (curIdx === -1) {
    return { status: 403, error: `Only an admin may change '${cur}', which is not on the configured auth group ladder` };
  }
  if (nextIdx < curIdx) {
    return { status: 403, error: "Only an admin may widen an app's audience to a broader group" };
  }
  return null;
}

// unauthenticatedPaths is a bigger audience-widening lever than authGroup
// itself: buildCaddyBlock exempts a listed path from the forward_auth check
// entirely, so a request matching it reaches the backend with no login at
// all, regardless of what rung the entry is gated at. Adding a path is
// therefore the privileged operation -- only adding can make something
// reachable without permission, removing one only narrows -- so anyone with
// resource access may narrow (remove paths, clear the list, or merely
// reorder; reordering is compared as a set and never counts as an addition)
// but adding requires the caller to actually be able to reach the app being
// exempted: admin, or membership in the resulting entry's rung or a rung
// above it. "Resulting" matters because a single request may both gate an
// entry and add a path in the same PATCH -- the paths apply to the
// after-this-request tier, not whatever was stored before it.
//
// A no-op, and therefore unchecked, when the resulting entry has no
// authGroup at all: buildCaddyBlock only emits the @auth_required matcher
// inside its `if (entry.authGroup)` branch, so an exemption on an ungated
// entry never reaches the Caddyfile -- there is nothing to widen.
function unauthenticatedPathsChangeError(
  cur: string[] | undefined,
  next: string[] | undefined,
  resultingAuthGroup: string | undefined,
  ladder: string[],
  isAdmin: boolean,
  callerGroups: string[]
): { status: number; error: string } | null {
  if (isAdmin) return null;
  const curSet = new Set(cur ?? []);
  const added = (next ?? []).filter((p) => !curSet.has(p));
  if (added.length === 0) return null;
  if (!resultingAuthGroup) return null;
  const reachableRungs = rungsAtOrAbove(ladder, resultingAuthGroup);
  const canReach = reachableRungs !== null && callerGroups.some((g) => reachableRungs.includes(g));
  if (canReach) return null;
  return {
    status: 403,
    error: 'Only a member of a group that can reach this app may add an unauthenticated path exemption',
  };
}

export function dashboardRoutes(
  inventory: Inventory,
  inventoryPath: string,
  ssh: SSHClient,
  authentik: AuthentikClient,
  cloudflare: CloudflareClient
): Router {
  const router = Router();
  router.get('/inventory', (req, res) => {
    const groups = req.user?.groups ?? [];
    const { hosts, guests } = filterInventoryForUser(inventoryPath, groups, inventory);
    // Both-or-neither (see customScriptSource/CLAUDE.md's Settings bullet):
    // null unless both settings are actually set, so the client's
    // communityScriptsUrl never has to re-derive that rule itself. Read
    // directly off `inventory` (not customScriptSource(), which throws on a
    // half-configured pair) -- a route that lists inventory must never 500
    // over a Settings misconfiguration the admin-only Settings page/set-config
    // are the actual place to fix.
    const customScripts =
      inventory.customScriptsRepo && inventory.customScriptsBranch
        ? { repo: inventory.customScriptsRepo, branch: inventory.customScriptsBranch }
        : null;
    res.json({ hosts, guests, domain: inventory.domain, customScripts });
  });

  // The client used to hardcode both admin group names to decide what to
  // show. Serving the decision (isAdmin) plus the names (adminGroups, for
  // the two places the client genuinely compares names) is what let those
  // duplicated constants be deleted from web-client -- it is a separate
  // build with no imports from src/, so a shared constant was never an
  // option. isAdmin is computed from req.user.groups, i.e. the *overlaid*
  // groups during an active impersonation, which is exactly what the
  // Sidebar computed itself before. capabilities.userDirectory reflects the
  // actually-injected AuthentikClient's own isConfigured() -- not a
  // process.env read -- so it can never disagree with what every other
  // Authentik-backed route on this same client is about to do.
  router.get('/whoami', (req, res) => {
    const user = req.user!;
    const config = authentikConfig();
    res.json({
      ...user,
      localOperator: !!user.localOperator,
      isAdmin: isAdminUser(user.groups),
      adminGroups: { app: config.adminGroup, authentikBuiltin: config.builtinAdminGroup },
      capabilities: { userDirectory: authentik.isConfigured() },
    });
  });

  router.get('/guests/status', async (req, res) => {
    const groups = req.user?.groups ?? [];
    const { hosts, guests } = filterInventoryForUser(inventoryPath, groups, inventory);
    // getGuestStatuses still queries every host in inventory.hosts (unfiltered)
    // for connectivity -- a guest could live on a host the caller can't see
    // but is itself still visible, so its parent host must still be reached.
    // Only the *reported* failures (host names it couldn't reach) are
    // filtered here, so a restricted caller never learns the name of a host
    // they're blocked from just because that host happened to be unreachable.
    const result = await getGuestStatuses(ssh, { ...inventory, guests });
    const allowedHostNames = new Set(hosts.map((h) => h.name));
    res.json({ ...result, failures: result.failures.filter((name) => allowedHostNames.has(name)) });
  });

  // Dashboard-driven inline edit of a guest's subdomains/port/caddyManual/
  // insecureBackendTls -- the only fields editable from there, each its own
  // input saving independently (subdomains/port on blur, caddyManual/
  // insecureBackendTls immediately on change since a checkbox has no blur
  // moment). Lets an operator set a port on a guest that has none yet, then
  // add a subdomain that actually routes to it, instead of silently
  // defaulting to port 80. Field parsing lives in applyGuestEdits;
  // validation, the TLS probe, the save, and the live Caddy/Authentik push
  // live in commitGuestEdit (src/operations/edit-guest.ts), shared with the
  // MCP server's edit_guest tool (#16); this route only owns the
  // caller-identity checks below, which depend on the requesting user and
  // so stay web-specific.
  router.patch(
    '/inventory/guests/:name',
    requireResourceAccess(inventoryPath, (req) => ({ type: 'guest', name: req.params.name as string })),
    async (req, res) => {
      const current = inventory.guests.find((g) => g.name === req.params.name);
      if (!current) {
        res.status(404).json({ error: `Unknown guest: ${req.params.name}` });
        return;
      }

      let updated;
      try {
        updated = applyGuestEdits(current, req.body);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }

      if ('authGroup' in req.body) {
        const problem = authGroupChangeError(
          current.authGroup,
          updated.authGroup,
          authentikConfig().groupLadder,
          isAdminUser(req.user?.groups ?? [])
        );
        if (problem) {
          res.status(problem.status).json({ error: problem.error });
          return;
        }
      }

      // Checked after authGroupChangeError, so when a request both changes
      // authGroup invalidly and adds a path, the authGroup rejection is what
      // the caller sees -- authGroupChangeError runs first and returns
      // before this is ever reached. When only the authGroup change is
      // valid (or absent), this check evaluates against the *resulting*
      // authGroup (updated.authGroup), which already reflects this same
      // request's own authGroup edit.
      if ('unauthenticatedPaths' in req.body) {
        const pathsProblem = unauthenticatedPathsChangeError(
          current.unauthenticatedPaths,
          updated.unauthenticatedPaths,
          updated.authGroup,
          authentikConfig().groupLadder,
          isAdminUser(req.user?.groups ?? []),
          req.user?.groups ?? []
        );
        if (pathsProblem) {
          res.status(pathsProblem.status).json({ error: pathsProblem.error });
          return;
        }
      }

      try {
        const result = await commitGuestEdit(
          { ssh, inventory, inventoryPath, authentik, cloudflare },
          req.params.name as string,
          updated,
          'subdomains' in req.body || 'port' in req.body
        );
        res.json(result);
      } catch (err) {
        if (err instanceof GuestEditValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    }
  );

  return router;
}
