import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import { MAX_LOG_CHUNK, json, pageLog, requireOwned as requireOwnedJob, summarizeJob, text } from './job-helpers.ts';
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
}

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
  server.server.oninitialized = () => {
    server.server.ping().catch(() => {});
  };
  // Mirrors the web UI's per-request reload (issue #98): pick up CLI and
  // web-UI writes made since the last tool call.
  const refresh = () => refreshInventory(deps.inventory, deps.inventoryPath);
  // One per server, subscribed before any job can run (#58).
  const tracker = new PromptTracker(deps.jobRunner.events);

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
          'Jobs still running when this MCP server exits are interrupted. ' +
          'Previews wait for any job currently running in this server (including one paused at an unanswered prompt) before returning.',
        inputSchema: { ...publicShape, apply: z.boolean().default(false).describe('Execute for real (default: preview only)') },
      },
      async (args: Record<string, unknown>) => {
        refresh();
        const { apply, ...raw } = args;
        const input = parseOperationInput(op, raw);
        if (!apply) return text(scrubSecretValues(op, input, await op.preview(input, deps)));
        const { jobId, preview } = await previewAndEnqueue(op, raw, deps, deps.jobRunner, { triggeredByUsername: 'mcp' });
        return json({ jobId, preview: scrubSecretValues(op, input, preview) });
      }
    );
  }

  server.registerTool(
    'edit_guest',
    {
      description:
        "Edit a guest's inventory routing fields (subdomains, port, caddyManual, insecureBackendTls, authGroup, unauthenticatedPaths, authMode, oidcRedirectUris), then push Caddy, the status page, and Authentik live. Applies immediately. Only the fields you pass are changed. This server runs as the local admin operator, so authMode/oidcRedirectUris changes are always permitted here. An edit that takes an OIDC-gated entry out of OIDC (authMode to 'forward', or clearing authGroup) deletes its OpenID client on sync, so it is rejected unless you pass confirmOidcClientDeletion: true -- ask the user first.",
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
        'The cached community-scripts app catalog usable with install_app. When a custom script repository is configured (see set_config customScriptsRepo/customScriptsBranch), the response also carries a custom group listing that fork branch\'s own ct/ scripts -- already removed from stable/dev -- plus which upstream repo(s) each overrides.',
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
        "Resolve an install_app slug or URL: whether it exists, dev-repo status, the script's recommended sizing and port, and any interactive prompts it contains. When a custom script repository is configured (see set_config customScriptsRepo/customScriptsBranch), also resolves against that fork branch first -- the response then carries custom (label, pinned commit sha) and, if the slug also exists upstream, shadows (which upstream repo(s) it overrides). A resolution failure (bad settings, GitHub unreachable) comes back as exists: false plus error, rather than throwing.",
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
        'Block until a job this server started finishes, pauses on an interactive prompt, or maxWaitSeconds passes. ' +
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

  const requireOwned = (id: number) => requireOwnedJob(deps, id);

  server.registerTool(
    'answer_job_prompt',
    { description: "Send an answer (a newline is appended) to a job's pending interactive prompt.", inputSchema: { id: z.number().int(), text: z.string() } },
    async (args: { id: number; text: string }) => {
      requireOwned(args.id);
      if (!deps.jobRunner.answerPrompt(args.id, args.text)) throw new Error(`Job ${args.id} is not awaiting input — nothing to answer`);
      return json({ answered: true });
    }
  );

  server.registerTool(
    'dismiss_job_prompt',
    { description: 'Resume a job whose detected prompt was a false positive, without sending input.', inputSchema: { id: z.number().int() } },
    async (args: { id: number }) => {
      requireOwned(args.id);
      if (!deps.jobRunner.dismissPrompt(args.id)) throw new Error(`Job ${args.id} is not awaiting input — nothing to dismiss`);
      return json({ dismissed: true });
    }
  );

  server.registerTool(
    'cancel_job',
    { description: 'Cancel a queued or running job. Remote work already done is not rolled back.', inputSchema: { id: z.number().int() } },
    async (args: { id: number }) => {
      const job = requireOwned(args.id);
      if (!deps.jobRunner.cancel(args.id)) throw new Error(`Job ${args.id} is already ${job.status} — nothing to cancel`);
      return json({ cancelled: true });
    }
  );

  return server;
}
