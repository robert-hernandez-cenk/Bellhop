import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { refreshInventory } from '../lib/inventory.ts';
import { getGuestStatuses } from '../lib/guest-status.ts';
import { getScriptCatalog } from '../lib/script-catalog.ts';
import { runAuditNfsMounts, formatAuditNfsMounts } from '../commands/maintenance/audit-nfs-mounts.ts';
import type { JobStore } from '../web/jobs/job-store.ts';
import type { JobLog } from '../web/jobs/job-log.ts';
import type { JobRunner } from '../web/jobs/job-runner.ts';
import type { OperationDeps } from '../operations/types.ts';
import { MCP_OPERATIONS } from '../operations/index.ts';
import { parseOperationInput, previewAndEnqueue, scrubSecretValues } from '../operations/core.ts';
import { runEditGuest, EDIT_GUEST_SHAPE } from '../operations/edit-guest.ts';
import { runOidcClientInfo } from '../commands/networking/oidc-credentials.ts';
import { checkAppUrl } from '../operations/app-check.ts';
import { gatewayStatus, gatewayServers, gatewayCities, gatewayGroups, connectGateway, type GatewayResult } from '../operations/vpn-gateway.ts';
import { MAX_LOG_CHUNK, json, pageLog, summarizeJob, text } from './job-helpers.ts';
import { requestJobControl } from '../web/jobs/job-control.ts';
import { PromptTracker } from './elicitation.ts';
import { WAIT_FOR_JOB_SHAPE, waitForJob, type ToolExtra, type WaitForJobArgs } from './wait-for-job.ts';

export interface McpDeps extends OperationDeps {
  jobStore: JobStore;
  jobLog: JobLog;
  jobRunner: JobRunner;
}

export interface McpServerOptions {
  // Test-only: how often wait_for_job sends progress notifications.
  progressIntervalMs?: number;
  // Test-only: how long a wait_for_job prompt dialog stays open unanswered.
  elicitationTimeoutMs?: number;
  // Who this server acts for, recorded on every job it starts (#65/#66): an
  // HTTP session's signed-in admin or 'api-key', or the stdio server's OS
  // user. Unset keeps the old generic 'mcp'.
  actor?: { username: string };
  // The prompt-dialog de-duplication state. The HTTP host passes one shared
  // by all its sessions, so two sessions never both ask about one prompt
  // (FR-005); unset builds one for this server alone, as stdio needs.
  tracker?: PromptTracker;
  // Which transport serves this server, for the tool descriptions: over
  // HTTP (#65/#66) jobs belong to the web service and outlive the client.
  transport?: 'stdio' | 'http';
}

const PING_TIMEOUT_MS = 5000;

export function toolName(operationId: string): string {
  return operationId.replace(/-/g, '_');
}

// Every tool here runs as the local operator (#16): there is no caller
// identity and no permission filtering, the same trust the CLI has. Thrown
// errors become isError results via the SDK, which is how a failed preview
// or invalid input reaches the client.
export function buildMcpServer(deps: McpDeps, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'bellhop', version: '0.1.0' });
  // Works around a bug in the *client's* Protocol#_oncancel (confirmed
  // against @modelcontextprotocol/sdk 1.30.0, 2026-09): it does `if
  // (!notification.params.requestId) return`, which treats a requestId of 0
  // as absent and silently drops the cancellation. elicitInput (wait_for_job,
  // below) is always this server's *first* outgoing request in a session --
  // nothing else here sends a server->client request before it -- so without
  // this, a request id of 0 would be handed out every time, and a cancelled
  // elicitInput (the prompt got answered elsewhere, or the tool call itself
  // was cancelled) would never actually withdraw the dialog on the client
  // side. Sending one throwaway ping first (every client auto-answers
  // 'ping') burns id 0 on something we never cancel, so every real elicit
  // request gets a nonzero id instead. This is a client-side bug, so
  // upgrading this repo's own SDK dependency wouldn't fix it for real MCP
  // clients (Claude Code and others, each bundling their own SDK) -- only
  // removable once those clients' own SDKs fix _oncancel.
  //
  // Sent as a plain request with a short timeout: over HTTP (#65/#66) the
  // client may have no stream open yet for a server->client request, and
  // the id is burned the moment it is sent whether or not it is answered,
  // so there is no reason to keep it pending for the SDK's 60s default.
  server.server.oninitialized = () => {
    server.server.request({ method: 'ping' }, EmptyResultSchema, { timeout: PING_TIMEOUT_MS }).catch(() => {});
  };
  // Mirrors the web UI's per-request reload (issue #98): pick up CLI and
  // web-UI writes made since the last tool call.
  const refresh = () => refreshInventory(deps.inventory, deps.inventoryPath);
  // One per server (or one shared by every HTTP session), subscribed before
  // any job can run (#58).
  const tracker = options.tracker ?? new PromptTracker(deps.jobRunner.events);
  // Read per call: the HTTP host updates its actor on every request.
  const actorName = () => options.actor?.username ?? 'mcp';
  const overHttp = options.transport === 'http';
  const jobLifetime = overHttp
    ? 'Jobs run in the Bellhop web service and keep running if this client disconnects. '
    : 'Jobs still running when this MCP server exits are interrupted. ';

  for (const op of MCP_OPERATIONS) {
    // internalFields (e.g. deploy-vpn-gateway's connectPollAttempts/
    // connectPollDelayMs test-speed knobs, #16 task 7) are accepted by
    // parseOperationInput/op.preview/op.apply but never published in the
    // tool's own input schema -- an MCP client has no legitimate use for
    // them and shouldn't be able to discover them by reading the schema.
    const internal = new Set(op.internalFields ?? []);
    const publicShape = Object.fromEntries(Object.entries(op.shape).filter(([key]) => !internal.has(key)));
    server.registerTool(
      toolName(op.id),
      {
        description:
          `${op.description} Dry run by default: returns a preview of exactly what would run. ` +
          'Pass apply: true to execute it as a background job, then call wait_for_job with the returned jobId. ' +
          (op.watchForPrompts
            ? 'The job may pause on an interactive installer question; wait_for_job shows it to the user when the client supports elicitation, and otherwise returns it for answer_job_prompt. '
            : '') +
          jobLifetime +
          'Previews wait for any job currently running in this server (including one paused at an unanswered prompt) before returning.',
        inputSchema: { ...publicShape, apply: z.boolean().default(false).describe('Execute for real (default: preview only)') },
      },
      async (args: Record<string, unknown>) => {
        refresh();
        const { apply, ...raw } = args;
        const input = parseOperationInput(op, raw);
        if (!apply) return text(scrubSecretValues(op, input, await op.preview(input, deps)));
        const { jobId, preview } = await previewAndEnqueue(op, raw, deps, deps.jobRunner, { triggeredByUsername: actorName(), triggeredVia: 'mcp' });
        return json({ jobId, preview: scrubSecretValues(op, input, preview) });
      }
    );
  }

  server.registerTool(
    'edit_guest',
    {
      description:
        "Edit a guest's inventory routing fields (subdomains, port, proxyManual, insecureBackendTls, authGroup, unauthenticatedPaths, authMode, oidcRedirectUris, oidcMobileRedirectUris), then push the reverse proxy, the status page, and Authentik live. Applies immediately. Only the fields you pass are changed. This server runs as the local admin operator, so authMode/oidcRedirectUris/oidcMobileRedirectUris changes are always permitted here. An edit that takes an OIDC-gated entry out of OIDC (authMode to 'forward', or clearing authGroup) deletes its OpenID client on sync, so it is rejected unless you pass confirmOidcClientDeletion: true -- ask the user first.",
      inputSchema: EDIT_GUEST_SHAPE,
    },
    async (args: Record<string, unknown>) => {
      refresh();
      return json(await runEditGuest(args as { name: string } & Record<string, unknown>, deps));
    }
  );

  server.registerTool(
    'get_oidc_client',
    {
      description:
        "An OIDC-gated entry's issuer address and client ID, read live from Authentik (FR-019a). " +
        'Never returns the client secret -- see secretAvailableFrom for where to get it (FR-019b).',
      inputSchema: { entry: z.string().describe('Host, guest, or external-site name') },
    },
    async (args: { entry: string }) => {
      refresh();
      const { issuer, clientId } = await runOidcClientInfo(args.entry, deps);
      return json({
        issuer,
        clientId,
        secretAvailableFrom: `the Dashboard (admin) or \`bellhop oidc-credentials ${args.entry}\``,
      });
    }
  );

  // --- VPN gateway tools (issue #7): get_vpn_gateway_status,
  // list_vpn_gateway_servers, list_vpn_gateway_cities, list_vpn_gateway_groups,
  // connect_vpn_gateway. All five call the exact same
  // src/operations/vpn-gateway.ts functions the web UI's
  // /api/networking/gateways/* routes call, so a tool's result always matches
  // what the Dashboard's gateway panel shows for the same request (FR-003).
  // connect_vpn_gateway acts immediately -- no dry run, no job -- matching
  // the Dashboard's own Connect button (research R1).
  function gatewayResult(r: GatewayResult) {
    if (r.ok) return json(r.body);
    throw new Error(r.error);
  }

  server.registerTool(
    'get_vpn_gateway_status',
    {
      description:
        "A VPN gateway guest's live status: connected, requested/resolved country and city, group, public IP, server, and last health check -- the same data the Dashboard's gateway card shows.",
      inputSchema: { name: z.string().describe('VPN gateway guest name (a guest with vpnGateway set)') },
    },
    async (args: { name: string }) => {
      refresh();
      return gatewayResult(await gatewayStatus(deps.inventory, args.name, deps.fetchImpl ?? fetch));
    }
  );

  server.registerTool(
    'list_vpn_gateway_servers',
    {
      description:
        "The VPN provider's available countries/servers for this gateway, live from the provider's own API. Country names here are what list_vpn_gateway_cities and connect_vpn_gateway expect.",
      inputSchema: { name: z.string().describe('VPN gateway guest name (a guest with vpnGateway set)') },
    },
    async (args: { name: string }) => {
      refresh();
      return gatewayResult(await gatewayServers(deps.inventory, args.name, deps.fetchImpl ?? fetch));
    }
  );

  server.registerTool(
    'list_vpn_gateway_cities',
    {
      description:
        "The VPN provider's available cities for a country, live from the provider's own API. Country names come from list_vpn_gateway_servers.",
      inputSchema: {
        name: z.string().describe('VPN gateway guest name (a guest with vpnGateway set)'),
        country: z.string().default('').describe('Country name, as reported by list_vpn_gateway_servers'),
      },
    },
    async (args: { name: string; country: string }) => {
      refresh();
      return gatewayResult(await gatewayCities(deps.inventory, args.name, args.country, deps.fetchImpl ?? fetch));
    }
  );

  server.registerTool(
    'list_vpn_gateway_groups',
    {
      description:
        "The VPN provider's available server groups (e.g. Double VPN, P2P), live from the provider's own API. NordVPN-only -- a PIA gateway reports server-group selection as not supported.",
      inputSchema: { name: z.string().describe('VPN gateway guest name (a guest with vpnGateway set)') },
    },
    async (args: { name: string }) => {
      refresh();
      return gatewayResult(await gatewayGroups(deps.inventory, args.name, deps.fetchImpl ?? fetch));
    }
  );

  server.registerTool(
    'connect_vpn_gateway',
    {
      description:
        "Switch a VPN gateway to a different server right now -- no dry run, no job, this is not a preview/apply operation like the tools above. Briefly interrupts traffic for every guest currently routed through this gateway while it reconnects. Valid country/city/group values come from list_vpn_gateway_servers, list_vpn_gateway_cities, and list_vpn_gateway_groups. Returns the gateway's new status.",
      inputSchema: {
        name: z.string().describe('VPN gateway guest name (a guest with vpnGateway set)'),
        country: z.string().default('').describe('Country to connect to, as reported by list_vpn_gateway_servers'),
        city: z.string().default('').describe('City to connect to, as reported by list_vpn_gateway_cities (optional)'),
        group: z.string().default('').describe('Server group to connect to, as reported by list_vpn_gateway_groups (optional, NordVPN-only)'),
      },
    },
    async (args: { name: string; country: string; city: string; group: string }) => {
      refresh();
      return gatewayResult(
        await connectGateway(deps.inventory, args.name, { country: args.country, city: args.city, group: args.group }, deps.fetchImpl ?? fetch)
      );
    }
  );

  server.registerTool('get_inventory', { description: 'The current inventory: hosts, guests, external sites, settings.', inputSchema: {} }, async () => {
    refresh();
    return json(deps.inventory);
  });

  server.registerTool('get_guest_status', { description: 'Live running/stopped status of every guest.', inputSchema: {} }, async () => {
    refresh();
    return json(await getGuestStatuses(deps.ssh, deps.inventory));
  });

  server.registerTool(
    'audit_nfs_mounts',
    { description: 'Read-only report of NFS shares bind-mounted into lxc guests.', inputSchema: { host: z.string().optional().describe('Limit to one lxc guest') } },
    async (args: { host?: string }) => {
      refresh();
      return text(formatAuditNfsMounts(await runAuditNfsMounts({ host: args.host }, deps)));
    }
  );

  server.registerTool(
    'list_install_apps',
    {
      description:
        'The cached community-scripts app catalog usable with install_app. When a custom script repository is configured (see set_config customScriptsRepo/customScriptsBranch), the response also carries a custom group listing only the apps that fork branch changes relative to upstream ProxmoxVED -- already removed from stable/dev -- plus which upstream repo(s) each overrides and, in conflicts, which ones upstream also changed since the branch point.',
      inputSchema: {},
    },
    async () => {
      refresh();
      return json(await getScriptCatalog(deps.inventoryPath, deps.fetchImpl ?? fetch, new Date(), deps.inventory));
    }
  );

  server.registerTool(
    'check_install_app',
    {
      description:
        "Resolve an install_app slug or URL: whether it exists, dev-repo status, the script's recommended sizing and port, and any interactive prompts it contains. When a custom script repository is configured (see set_config customScriptsRepo/customScriptsBranch), an app the fork branch changes resolves to that branch (as does an app only the fork has); every other app resolves upstream as usual. A fork resolution carries custom (label, pinned commit sha), shadows when the slug also exists upstream (which upstream repo(s) it overrides), and conflict: true when upstream also changed the app since the branch point (the install still uses the fork; tell the user to rebase the branch). A resolution failure (bad settings, GitHub unreachable) comes back as exists: false plus error, rather than throwing.",
      inputSchema: { app: z.string().describe('App slug or full script URL') },
    },
    async (args: { app: string }) => {
      refresh();
      return json(await checkAppUrl(args.app, deps.fetchImpl, deps.inventory));
    }
  );

  server.registerTool(
    'list_jobs',
    { description: 'Recent jobs from any front end (web UI or MCP), newest first.', inputSchema: { limit: z.number().int().positive().max(500).optional() } },
    async (args: { limit?: number }) => json(deps.jobStore.list(args.limit ?? 20).map(summarizeJob))
  );

  server.registerTool(
    'get_job',
    {
      description:
        `Status of one job, any pending interactive prompt, and up to ${MAX_LOG_CHUNK} characters of its log from logOffset. ` +
        'Pass the returned nextOffset on the next call, and keep calling with nextOffset while hasMore is true to read the rest of the log.',
      inputSchema: { id: z.number().int(), logOffset: z.number().int().min(0).optional() },
    },
    async (args: { id: number; logOffset?: number }) => {
      const job = deps.jobStore.get(args.id);
      if (!job) throw new Error(`Unknown job id: ${args.id}`);
      return json({
        job: summarizeJob(job),
        prompt: job.status === 'awaiting_input' ? { text: job.promptText, origin: job.promptOrigin } : null,
        ...pageLog(deps.jobLog.read(job.logFile), args.logOffset),
      });
    }
  );

  server.registerTool(
    'wait_for_job',
    {
      description:
        (overHttp
          ? 'Block until a job run by the Bellhop web service finishes, pauses on an interactive prompt, or maxWaitSeconds passes. '
          : 'Block until a job this server started finishes, pauses on an interactive prompt, or maxWaitSeconds passes. ') +
        "When the client supports elicitation, a prompt is shown to the user as a form (answer, resume, or cancel the job) and the wait continues in the same call. " +
        'If the client cannot elicit, or the user declines the form, returns outcome prompt_pending: use answer_job_prompt, dismiss_job_prompt, or cancel_job. ' +
        'A still_running result with a non-null prompt can mean a concurrent wait_for_job call on the same job is already showing the user that prompt in its own dialog -- ' +
        'do not answer it yourself in that case, just call wait_for_job again. ' +
        `On still_running, call again. Without logOffset the log is the last ${MAX_LOG_CHUNK} characters. ` +
        'Cancelling this call does not cancel the job.',
      inputSchema: WAIT_FOR_JOB_SHAPE,
    },
    async (args: WaitForJobArgs, extra: ToolExtra) =>
      json(await waitForJob(deps, server, tracker, args, extra, {
          progressIntervalMs: options.progressIntervalMs,
          elicitationTimeoutMs: options.elicitationTimeoutMs,
        }))
  );

  // Issue #6 (US3): a job owned by another process (the web service, or a
  // different MCP server instance) used to be an outright refusal here
  // (job-helpers.ts's requireOwned: "job N is owned by X; control it from
  // there"). These three tools now go through the same requestJobControl
  // the web routes use
  // (src/web/jobs/job-control.ts, research.md R5): applied directly when
  // this server's own jobRunner owns the job, queued as a control request
  // the owning process polls for and applies otherwise, or refused up front
  // when nothing could ever come of asking (a dead-pid owner, or a status
  // that already rules the action out). wait_for_job is the one job tool
  // that keeps requireOwned (job-helpers.ts) unchanged -- it needs the job's
  // own in-memory controller/events to block on, which only the owning
  // process ever holds.
  const applyControl = (id: number, action: 'cancel' | 'answer' | 'dismiss', requestText?: string) => {
    const job = deps.jobStore.get(id);
    if (!job) throw new Error(`Unknown job id: ${id}`);
    // A server with an actor is an HTTP session inside the web service
    // (or stdio, whose runner owner already says MCP): name the caller, and
    // never let a web-hosted session be labelled as the web UI.
    const requester =
      options.actor !== undefined
        ? {
            requestedByUsername: actorName(),
            ...(deps.jobRunner.owner === 'web' ? { requestedByOwner: 'mcp:http' } : {}),
          }
        : {};
    const result = requestJobControl(
      { jobStore: deps.jobStore, jobRunner: deps.jobRunner },
      { job, action, text: requestText, ...requester }
    );
    if (result.kind === 'done') {
      return action === 'cancel' ? { cancelled: true } : action === 'answer' ? { answered: true } : { dismissed: true };
    }
    if (result.kind === 'requested') {
      return {
        requested: true,
        owner: result.owner,
        note: 'The owning process applies this within about a second if it is running; check get_job for the result.',
      };
    }
    throw new Error(result.message);
  };

  server.registerTool(
    'answer_job_prompt',
    {
      description: "Send an answer (a newline is appended) to a job's pending interactive prompt, whichever process owns it.",
      inputSchema: { id: z.number().int(), text: z.string() },
    },
    async (args: { id: number; text: string }) => json(applyControl(args.id, 'answer', args.text))
  );

  server.registerTool(
    'dismiss_job_prompt',
    {
      description: 'Resume a job whose detected prompt was a false positive, without sending input, whichever process owns it.',
      inputSchema: { id: z.number().int() },
    },
    async (args: { id: number }) => json(applyControl(args.id, 'dismiss'))
  );

  server.registerTool(
    'cancel_job',
    {
      description: 'Cancel a queued or running job, whichever process owns it. Remote work already done is not rolled back.',
      inputSchema: { id: z.number().int() },
    },
    async (args: { id: number }) => json(applyControl(args.id, 'cancel'))
  );

  return server;
}
