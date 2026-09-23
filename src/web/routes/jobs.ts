import { Router, type Response } from 'express';
import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { JobStore, JobRow } from '../jobs/job-store.ts';
import type { JobLog } from '../jobs/job-log.ts';
import type { JobRunner } from '../jobs/job-runner.ts';
import { resolveAuthUser } from '../auth.ts';
import { isAdmin } from '../access.ts';
import { loadPermissionRules, type GroupPermission } from '../../lib/permissions.ts';
import type { ImpersonationStore } from '../impersonation.ts';

// A job's `target` is either a host name (provisioning's guest-creating
// commands) or a guest name (everything else that has one) -- JobRow
// itself doesn't record which. This deliberately does NOT go through
// access.ts's isResourceAllowed (which requires a resource *type*) twice,
// once per type, OR-ing the results: permission_rules rows are keyed on
// (resource_type, resource_name), so a rule tagged 'guest' leaves no row
// at all for the same name under 'host' -- under a block-list group, that
// missing row defaults to "allowed," so an OR of the two typed checks
// would leak a job whose target is blocked under its real type, as soon
// as the untagged type's check trivially passed. A job's target name is
// never simultaneously a real host and a real guest, so matching purely
// by name (ignoring resource_type) against every rule row is the correct
// -- and only correct -- way to evaluate visibility here.
//
// Takes a pre-loaded rules map (from loadPermissionRules) rather than an
// inventoryPath so callers that check many jobs in one request (GET /,
// the WS upgrade handler) load the rules once and reuse it, instead of
// opening/closing a fresh SQLite connection per job.
export function isJobVisible(rules: Map<string, GroupPermission>, groups: string[], target: string | null): boolean {
  if (isAdmin(groups)) return true;
  if (target === null) return false;
  for (const groupName of groups) {
    const perm = rules.get(groupName);
    if (!perm) continue;
    const listed = perm.resources.some((r) => r.name === target);
    const allowedByThisGroup = perm.mode === 'allow-list' ? listed : !listed;
    if (!allowedByThisGroup) return false;
  }
  return true;
}

export function jobsRoutes(jobStore: JobStore, jobLog: JobLog, jobRunner: JobRunner, inventoryPath: string): Router {
  const router = Router();

  // Issue #16: a job may be owned by another process (an MCP server) whose
  // JobRunner holds its live exec channel -- this process can't cancel,
  // answer, or dismiss it. Returns true (after sending a 409 naming the
  // owner, same wording as src/mcp/build-server.ts's requireOwned) when the
  // job isn't ours, rather than letting the runner's "nothing to cancel"
  // failure produce a misleading error.
  const rejectForeignOwner = (job: JobRow, res: Response): boolean => {
    const owner = job.owner ?? 'web';
    if (owner === jobRunner.owner) return false;
    res.status(409).json({ error: `job ${job.id} is owned by ${owner}; control it from there` });
    return true;
  };

  router.get('/', (req, res) => {
    const groups = req.user?.groups ?? [];
    const rules = loadPermissionRules(inventoryPath);
    res.json(jobStore.list().filter((j) => isJobVisible(rules, groups, j.target)));
  });

  router.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    const job = jobStore.get(id);
    const groups = req.user?.groups ?? [];
    const rules = loadPermissionRules(inventoryPath);
    if (!job || !isJobVisible(rules, groups, job.target)) {
      res.status(404).json({ error: `Unknown job id: ${req.params.id}` });
      return;
    }
    res.json({ job, log: jobLog.read(job.logFile) });
  });

  router.post('/:id/cancel', (req, res) => {
    const id = Number(req.params.id);
    const job = jobStore.get(id);
    const groups = req.user?.groups ?? [];
    const rules = loadPermissionRules(inventoryPath);
    if (!job || !isJobVisible(rules, groups, job.target)) {
      res.status(404).json({ error: `Unknown job id: ${req.params.id}` });
      return;
    }
    if (rejectForeignOwner(job, res)) return;
    if (!jobRunner.cancel(id)) {
      res.status(409).json({ error: `Job ${id} is already ${job.status} — nothing to cancel` });
      return;
    }
    res.json({ cancelled: true });
  });

  router.post('/:id/answer', (req, res) => {
    const id = Number(req.params.id);
    const job = jobStore.get(id);
    const groups = req.user?.groups ?? [];
    const rules = loadPermissionRules(inventoryPath);
    if (!job || !isJobVisible(rules, groups, job.target)) {
      res.status(404).json({ error: `Unknown job id: ${req.params.id}` });
      return;
    }
    if (rejectForeignOwner(job, res)) return;
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!jobRunner.answerPrompt(id, text)) {
      res.status(409).json({ error: `Job ${id} is not awaiting input — nothing to answer` });
      return;
    }
    res.json({ answered: true });
  });

  router.post('/:id/dismiss-prompt', (req, res) => {
    const id = Number(req.params.id);
    const job = jobStore.get(id);
    const groups = req.user?.groups ?? [];
    const rules = loadPermissionRules(inventoryPath);
    if (!job || !isJobVisible(rules, groups, job.target)) {
      res.status(404).json({ error: `Unknown job id: ${req.params.id}` });
      return;
    }
    if (rejectForeignOwner(job, res)) return;
    if (!jobRunner.dismissPrompt(id)) {
      res.status(409).json({ error: `Job ${id} is not awaiting input — nothing to dismiss` });
      return;
    }
    res.json({ dismissed: true });
  });

  return router;
}

export function attachJobsWebSocket(
  server: Server,
  jobRunner: JobRunner,
  jobStore: JobStore,
  jobLog: JobLog,
  inventoryPath: string,
  impersonationStore: ImpersonationStore
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const user = resolveAuthUser(req.headers);
    if (!user) {
      socket.destroy();
      return;
    }
    // This handler is wired directly onto the raw http.Server and runs
    // before/independent of Express's middleware chain, so it needs its own
    // impersonation-overlay lookup -- applyImpersonation (src/web/
    // impersonation.ts) never sees this request. Mirrors that middleware's
    // overlay logic exactly: an active entry replaces the real groups with
    // just the impersonated group for the purposes of this connection's
    // job-visibility check.
    const impersonatedGroup = impersonationStore.get(user.username);
    const effectiveGroups = impersonatedGroup ? [impersonatedGroup] : user.groups;
    const match = req.url?.match(/^\/ws\/jobs\/(\d+)$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const jobId = Number(match[1]);
    const job = jobStore.get(jobId);
    const rules = loadPermissionRules(inventoryPath);
    if (!isJobVisible(rules, effectiveGroups, job?.target ?? null)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'backlog', text: job ? jobLog.read(job.logFile) : '' }));
      // The job may already have finished before this socket connected (a
      // fast job can complete before the WS handshake does) -- without this,
      // a late-connecting client would wait forever for a 'status' event
      // that already fired with no listener attached yet.
      if (job) ws.send(JSON.stringify({ type: 'status', status: job.status }));
      // A late-connecting client (operator reloads mid-prompt) needs the
      // current prompt replayed the same way a late-finished job's status
      // already is above -- otherwise it would wait forever for a 'prompt'
      // event that already fired with no listener attached yet.
      if (job && job.status === 'awaiting_input' && job.promptText) {
        ws.send(
          JSON.stringify({
            type: 'prompt',
            text: job.promptText,
            expectedPrompts: job.expectedPromptsJson ? JSON.parse(job.expectedPromptsJson) : [],
            // Replayed so a client connecting mid-prompt renders the same
            // banner a client that was already connected does (issue #160).
            // The `?? 'heuristic'` default is only ever reached by a row
            // written before these columns existed -- and in practice not
            // even then: src/web/server.ts runs reconcileOrphanedJobs()
            // before serving any request, which flips every non-terminal
            // row (including one left in 'awaiting_input' by a prior
            // process) to 'interrupted', and this branch only runs for
            // status === 'awaiting_input'. Kept anyway as a harmless
            // fallback in case that ordering ever changes.
            origin: job.promptOrigin ?? 'heuristic',
            matchedIndex: job.promptMatchedIndex,
          })
        );
      }

      const onChunk = (payload: { jobId: number; stream: string; text: string }) => {
        if (payload.jobId === jobId) ws.send(JSON.stringify({ type: 'chunk', stream: payload.stream, text: payload.text }));
      };
      const onStatus = (payload: { jobId: number; status: string }) => {
        if (payload.jobId === jobId) ws.send(JSON.stringify({ type: 'status', status: payload.status }));
      };
      const onPrompt = (payload: {
        jobId: number;
        text: string;
        expectedPrompts: string[];
        origin: string;
        matchedIndex: number | null;
      }) => {
        if (payload.jobId === jobId)
          ws.send(
            JSON.stringify({
              type: 'prompt',
              text: payload.text,
              expectedPrompts: payload.expectedPrompts,
              origin: payload.origin,
              matchedIndex: payload.matchedIndex,
            })
          );
      };
      const onPromptCleared = (payload: { jobId: number }) => {
        if (payload.jobId === jobId) ws.send(JSON.stringify({ type: 'prompt-cleared' }));
      };

      jobRunner.events.on('chunk', onChunk);
      jobRunner.events.on('status', onStatus);
      jobRunner.events.on('prompt', onPrompt);
      jobRunner.events.on('prompt-cleared', onPromptCleared);
      ws.on('close', () => {
        jobRunner.events.off('chunk', onChunk);
        jobRunner.events.off('status', onStatus);
        jobRunner.events.off('prompt', onPrompt);
        jobRunner.events.off('prompt-cleared', onPromptCleared);
      });
    });
  });

  return wss;
}
