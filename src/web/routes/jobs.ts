import { Router, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { JobStore, JobRow, JobStatus } from '../jobs/job-store.ts';
import type { JobLog } from '../jobs/job-log.ts';
import type { JobRunner } from '../jobs/job-runner.ts';
import { createForeignJobTail } from '../jobs/job-tail.ts';
import { requestJobControl } from '../jobs/job-control.ts';
import { resolveAuthUser } from '../auth.ts';
import { isAdmin } from '../access.ts';
import { loadPermissionRules, type GroupPermission } from '../../lib/permissions.ts';
import type { ImpersonationStore } from '../impersonation.ts';

const TERMINAL_JOB_STATUSES: JobStatus[] = ['success', 'failed', 'cancelled', 'interrupted'];

// A log file another process is actively appending to can be read mid-write
// (issue #6): readBytes(name, 0) may return a trailing UTF-8 sequence that's
// only partially written. Returns how many leading bytes of `buffer` form
// complete UTF-8 characters, so the backlog sent to the client never
// contains a torn character -- the foreign-job tailer's own persistent
// StringDecoder (job-tail.ts) picks up the remaining bytes, whole, on a
// later tick once the rest of the sequence has been written.
function completeUtf8Length(buffer: Buffer): number {
  let i = buffer.length - 1;
  let continuationBytes = 0;
  while (i >= 0 && (buffer[i] & 0xc0) === 0x80) {
    continuationBytes++;
    i--;
  }
  if (i < 0) return 0;
  const leadByte = buffer[i];
  let seqLen = 1;
  if ((leadByte & 0x80) === 0) seqLen = 1;
  else if ((leadByte & 0xe0) === 0xc0) seqLen = 2;
  else if ((leadByte & 0xf0) === 0xe0) seqLen = 3;
  else if ((leadByte & 0xf8) === 0xf0) seqLen = 4;
  return continuationBytes + 1 < seqLen ? i : buffer.length;
}

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

  // Issue #6 (US2): a job may be owned by another process (an MCP server)
  // whose JobRunner holds its live exec channel -- this process can't
  // cancel/answer/dismiss it directly. requestJobControl (shared with the
  // MCP tools, src/web/jobs/job-control.ts) decides what happens: applied
  // locally when this route's own jobRunner owns the job, queued as a
  // control request for the owning process to poll and apply otherwise, or
  // refused up front when nothing could ever come of asking (a dead-pid
  // owner, or a job whose status already rules the action out). The
  // requesting user recorded is the real identity (research.md R6), same as
  // triggeredByUsername elsewhere.
  const applyControl = (req: Request, res: Response, job: JobRow, action: 'cancel' | 'answer' | 'dismiss', text?: string) => {
    const result = requestJobControl(
      { jobStore, jobRunner },
      { job, action, text, requestedByUsername: (req.realUser ?? req.user)?.username }
    );
    if (result.kind === 'done') {
      res.json(action === 'cancel' ? { cancelled: true } : action === 'answer' ? { answered: true } : { dismissed: true });
      return;
    }
    if (result.kind === 'requested') {
      res.status(202).json({ requested: true, owner: result.owner });
      return;
    }
    res.status(409).json({ error: result.message });
  };

  router.post('/:id/cancel', (req, res) => {
    const id = Number(req.params.id);
    const job = jobStore.get(id);
    const groups = req.user?.groups ?? [];
    const rules = loadPermissionRules(inventoryPath);
    if (!job || !isJobVisible(rules, groups, job.target)) {
      res.status(404).json({ error: `Unknown job id: ${req.params.id}` });
      return;
    }
    applyControl(req, res, job, 'cancel');
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
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    applyControl(req, res, job, 'answer', text);
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
    applyControl(req, res, job, 'dismiss');
  });

  return router;
}

export function attachJobsWebSocket(
  server: Server,
  jobRunner: JobRunner,
  jobStore: JobStore,
  jobLog: JobLog,
  inventoryPath: string,
  impersonationStore: ImpersonationStore,
  options: { tailIntervalMs?: number } = {}
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const tailIntervalMs = options.tailIntervalMs ?? 1000;

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
    // Issue #6: a job owned by another process (an MCP server) has no
    // in-memory state in *this* process's jobRunner -- its 'chunk'/'status'/
    // 'prompt'/'prompt-cleared' events never fire for it. Such a job still
    // streams live, just via the polling foreign-job tailer below instead of
    // jobRunner.events.
    const foreign = job !== undefined && (job.owner ?? 'web') !== jobRunner.owner;
    // Only meaningful when `foreign` -- the offset into the log file the
    // backlog below ended at, and where the tail's first tick starts reading
    // from.
    let foreignTailOffset = 0;

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (job && foreign) {
        const backlogBytes = jobLog.readBytes(job.logFile, 0);
        foreignTailOffset = completeUtf8Length(backlogBytes);
        ws.send(JSON.stringify({ type: 'backlog', text: backlogBytes.subarray(0, foreignTailOffset).toString('utf8') }));
      } else {
        ws.send(JSON.stringify({ type: 'backlog', text: job ? jobLog.read(job.logFile) : '' }));
      }
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

      if (job && foreign) {
        // No jobRunner.events registration for a foreign job -- those never
        // fire for it (see the `foreign` comment above). Skip the tail
        // entirely for a job that's already terminal by connect time, same
        // as the local path needs no event listeners for one either.
        if (!TERMINAL_JOB_STATUSES.includes(job.status)) {
          const tail = createForeignJobTail({
            jobStore,
            jobLog,
            jobId,
            initial: { offset: foreignTailOffset, row: job },
            send: (msg) => ws.send(JSON.stringify(msg)),
          });
          const interval = setInterval(() => {
            tail.tick();
            if (tail.stopped) clearInterval(interval);
          }, tailIntervalMs);
          ws.on('close', () => clearInterval(interval));
        }
        return;
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
