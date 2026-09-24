import { stringify } from 'yaml';
import type { SSHClient } from '../lib/ssh-client.ts';
import type { Inventory } from '../lib/inventory.ts';
import type { AuthentikClient } from '../lib/authentik-client.ts';
import { runSyncCaddy } from '../commands/networking/sync-caddy.ts';
import { runRenderStatusPage, statusPagePathSkipMessage } from '../commands/networking/render-status-page.ts';
import { runSyncAuthentik, conflictExplanation, OFF_LADDER_EXPLANATION, MISSING_RUNG_EXPLANATION } from '../commands/networking/sync-authentik.ts';
import type { ForwardSkip, OffLadderEntry, OidcSkip } from '../commands/networking/sync-authentik.ts';
import { logInfo, logWarn } from '../lib/log.ts';
import type { CloudflareClient } from '../lib/cloudflare-client.ts';
import { UnconfiguredCloudflareClient, CLOUDFLARE_UNCONFIGURED_MESSAGE } from '../lib/cloudflare-client.ts';
import { runPruneAcmeChallenges } from '../commands/networking/prune-acme-challenges.ts';

export interface SyncCaddyLiveResult {
  // Slug conflicts reported by sync-authentik: entries with an authGroup set
  // whose slug is already held in Authentik by an Application this toolkit
  // does not own. Returned rather than only logged because the Dashboard's
  // guest PATCH calls syncCaddyLive straight from its Express handler,
  // outside any job context -- logWarn's console.error reaches the service's
  // stderr there and nothing the operator can see.
  authentikConflicts: string[];
  // The subset of authentikConflicts adopt-oidc-client can take over
  // (sync-authentik's adoptableConflicts), so a Dashboard banner can offer
  // adoption instead of "resolve by hand" (FR-011).
  authentikAdoptableConflicts: string[];
  // Entries whose authGroup names a group absent from AUTHENTIK_GROUP_LADDER,
  // and ladder rungs absent from Authentik itself. Surfaced for the same
  // reason as authentikConflicts: the Dashboard's guest PATCH calls
  // syncCaddyLive straight from its Express handler, outside any job, so a
  // logWarn alone would only reach the service's stderr.
  authentikOffLadder: OffLadderEntry[];
  authentikMissingRungs: string[];
  // Native OIDC gating (issue #1): OIDC entries sync-authentik left alone
  // (no callback URL, missing signing key or scope mapping), and owned
  // OpenID clients whose issuer discovery document could not be fetched
  // after the apply. Returned for the same outside-any-job reason as the
  // fields above; the save itself still succeeds, since the client in
  // Authentik is correct either way.
  authentikOidcSkipped: OidcSkip[];
  // Forward-auth entries left alone because the provider name they need is
  // taken (sync-authentik's forwardSkipped) -- the forward-mode counterpart
  // of authentikOidcSkipped, returned for the same reason.
  authentikForwardSkipped: ForwardSkip[];
  authentikOidcDiscoveryFailures: { slug: string; issuer: string; error: string }[];
}

export const PRUNE_ACME_SKIP_MESSAGE = `prune-acme-challenges: skipped, ${CLOUDFLARE_UNCONFIGURED_MESSAGE}`;

// Last step of the push-live sequence (issue #162). Every failure is turned
// into a warning: a stale TXT record is harmless, so a Cloudflare outage or a
// bad token must never fail the Dashboard edit or provisioning job that
// triggered this. Nothing is added to SyncCaddyLiveResult -- there is no
// operator action a Dashboard banner could ask for.
async function pruneAcmeChallengesLive(cloudflare: CloudflareClient, inventory: Inventory): Promise<void> {
  if (!cloudflare.isConfigured()) {
    logInfo(PRUNE_ACME_SKIP_MESSAGE);
    return;
  }
  try {
    const result = await runPruneAcmeChallenges({ apply: true }, { cloudflare, inventory });
    for (const name of result.deleted) logInfo(`prune-acme-challenges: deleted stale ${name}`);
    for (const f of result.failed) logWarn(`prune-acme-challenges: could not delete ${f.name} — ${f.error}`);
  } catch (err) {
    logWarn(`prune-acme-challenges: skipped — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// The one place every auto-sync trigger (a subdomains-bearing create-guest
// apply, a Dashboard subdomain/authGroup edit) pushes a change live:
// writes the managed Caddyfile section, regenerates the status page from
// the now-current inventory + the Caddyfile sync-caddy just wrote,
// reconciles Authentik's Providers/Applications/policy bindings against
// the same inventory, then prunes stale _acme-challenge TXT records from
// Cloudflare -- treated as one combined "push live" step so the artifacts
// always move together rather than drifting apart. `cloudflare` is optional
// and defaults to unconfigured, same convention as AppDeps.impersonationStore.
export async function syncCaddyLive(deps: {
  ssh: SSHClient;
  inventory: Inventory;
  authentik: AuthentikClient;
  cloudflare?: CloudflareClient;
  // Passed through to sync-authentik's discovery check; tests inject one.
  fetchImpl?: typeof fetch;
}): Promise<SyncCaddyLiveResult> {
  await runSyncCaddy({ apply: true }, deps);
  // The status page is opt-in: an operator who has not configured a path
  // never gets an index.html written to their Caddy host. Skipping is not
  // a failure, so the Authentik reconcile below still runs.
  if (deps.inventory.statusPagePath !== undefined) {
    const inventorySnapshot = stringify(deps.inventory);
    await runRenderStatusPage({ apply: true }, deps, inventorySnapshot);
  } else {
    logInfo(statusPagePathSkipMessage());
  }
  let result: SyncCaddyLiveResult = {
    authentikConflicts: [],
    authentikAdoptableConflicts: [],
    authentikOffLadder: [],
    authentikMissingRungs: [],
    authentikOidcSkipped: [],
    authentikForwardSkipped: [],
    authentikOidcDiscoveryFailures: [],
  };
  // Skipped rather than attempted when there is no Authentik API to talk to.
  // Before issue #123 this ran unconditionally, and runSyncAuthentik calls
  // listApplications() before checking whether anything actually needs
  // gating -- so an operator running forward-auth without an admin token
  // could not edit a guest's subdomains from the Dashboard at all. Checked
  // on the actual injected client rather than process.env, so this can never
  // disagree with what runSyncAuthentik itself is about to do.
  if (deps.authentik.isConfigured()) {
    const authentikResult = await runSyncAuthentik({ apply: true }, deps);
    // Kept alongside the return value: a provisioning-job-triggered call
    // runs inside withCapturedConsole, so this does reach that job's log.
    for (const name of authentikResult.conflicts) {
      logWarn(`sync-authentik: ${name} — ${conflictExplanation(name, authentikResult)}`);
    }
    for (const entry of authentikResult.offLadder) {
      logWarn(`sync-authentik: ${entry.slug} (${entry.authGroup}) — ${OFF_LADDER_EXPLANATION}`);
    }
    for (const rung of authentikResult.missingRungs) logWarn(`sync-authentik: ${rung} — ${MISSING_RUNG_EXPLANATION}`);
    const oidcSkipped = authentikResult.oidcSkipped ?? [];
    for (const skip of oidcSkipped) logWarn(`sync-authentik: ${skip.slug} — OIDC skipped: ${skip.reason}`);
    const forwardSkipped = authentikResult.forwardSkipped ?? [];
    for (const skip of forwardSkipped) {
      logWarn(`sync-authentik: ${skip.slug} — forward-auth skipped: ${skip.reason}`);
    }
    const discoveryFailures = (authentikResult.discovery ?? [])
      .filter((d) => !d.ok)
      .map((d) => ({ slug: d.slug, issuer: d.issuer, error: d.error ?? 'unknown error' }));
    for (const failure of discoveryFailures) {
      logWarn(`sync-authentik: ${failure.slug} — OIDC discovery failed for ${failure.issuer}: ${failure.error}`);
    }
    result = {
      authentikConflicts: authentikResult.conflicts,
      authentikAdoptableConflicts: authentikResult.adoptableConflicts ?? [],
      authentikOffLadder: authentikResult.offLadder,
      authentikMissingRungs: authentikResult.missingRungs,
      authentikOidcSkipped: oidcSkipped,
      authentikForwardSkipped: forwardSkipped,
      authentikOidcDiscoveryFailures: discoveryFailures,
    };
  }
  await pruneAcmeChallengesLive(deps.cloudflare ?? new UnconfiguredCloudflareClient(), deps.inventory);
  return result;
}
