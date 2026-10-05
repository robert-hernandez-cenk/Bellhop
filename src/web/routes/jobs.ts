import { Router, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import type { JobStore, JobRow, JobStatus } from '../jobs/job-store.ts';
import type { JobLog } from '../jobs/job-log.ts';
import type { JobRunner } from '../jobs/job-runner.ts';
import { createForeignJobTail } from '../jobs/job-tail.ts';
import { requestJobControl } from '../jobs/job-control.ts';
import { resolveRequestUser } from '../auth.ts';
import type { SessionService } from '../login/sessions.ts';
import { ANONYMOUS_CALLER, guestCreators, isAdmin, type AccessCaller } from '../access.ts';
import { isGuestCreator, loadPermissionRules, type GroupPermission } from '../../lib/permissions.ts';
import type { GuestCreator, Inventory } from '../../lib/inventory.ts';
import type { ImpersonationStore } from '../impersonation.ts';

const TERMINAL_JOB_STATUSES: JobStatus[] = ['success', 'failed', 'cancelled', 'interrupted'];

// A log file another process is actively appending to can be read mid-write
// (issue #6): readBytes(name, 0) may return a trailing UTF-8 sequence that's
// only partially written. Returns how many leading bytes of `buffer` form
// complete UTF-8 characters, so the backlog sent to the client never
// contains a torn character -- the foreign-job tailer's own persistent
// StringDecoder (job-tail.ts) picks up the remaining bytes, whole, on a
// later tick once the rest of the sequence has been written.
export function completeUtf8Length(buffer: Buffer): number {
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

// Whether a job that started at `startedAt` falls inside a creator record
// written at `since` (both ISO-8601). Compared as instants, not strings, so
// differently-formatted timestamps still order correctly; anything missing
// or unparseable is false.
function startedSince(startedAt: string | null, since: string | undefined): boolean {
  if (!startedAt || !since) return false;
  const started = Date.parse(startedAt);
  const recorded = Date.parse(since);
  if (Number.isNaN(started) || Number.isNaN(recorded)) return false;
  return started >= recorded;
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
// as the untagged type's check trivially passed. Matching purely by name
// (ignoring resource_type) against every rule row is the correct way to
// evaluate visibility here. (If a guest shares a host's name, a rule naming
// either one applies to every job on that name -- an admin-authored rule
// ambiguity, left as is; the creator lift below deliberately does not
// extend it to jobs on the host.)
//
// Takes a pre-loaded rules map (from loadPermissionRules) rather than an
// inventoryPath so callers that check many jobs in one request (GET /,
// the WS upgrade handler) load the rules once and reuse it, instead of
// opening/closing a fresh SQLite connection per job.
//
// Creator lift (issue #58): `creators` (guestCreators(inventory)) maps guest
// names to their recorded creator. When `job.target` names a guest the
// caller created (isGuestCreator -- never while impersonating), an
// allow-list group treats it as listed, mirroring isAllowed in
// src/lib/permissions.ts; a block-list group listing it still hides the job
// (explicit block wins). Two limits keep the lift from reaching jobs that
// were never about the caller's guest (#58 final review):
// - guestCreators omits any guest whose name is also a host name, so a
//   host-targeted job (the guest-creating commands target the host) is
//   never lifted, even when a guest happens to share that host's name;
// - the job must have started at or after the creator was recorded
//   (`creator.since`), so a guest re-created under a reused name never
//   exposes the old guest's history. A creator with no `since`, or a job
//   that never started (no startedAt), gets no lift at all -- fail closed.
export function isJobVisible(
  rules: Map<string, GroupPermission>,
  caller: AccessCaller,
  job: Pick<JobRow, 'target' | 'startedAt'> | null,
  creators: Map<string, GuestCreator>
): boolean {
  if (isAdmin(caller.groups)) return true;
  if (!job || job.target === null) return false;
  const target = job.target;
  const creator = creators.get(target);
  const isCreator = isGuestCreator(creator, caller) && startedSince(job.startedAt, creator?.since);
  for (const groupName of caller.groups) {
    const perm = rules.get(groupName);
    if (!perm) continue;
    const listed = perm.resources.some((r) => r.name === target);
    const allowedByThisGroup = perm.mode === 'allow-list' ? listed || isCreator : !listed;
    if (!allowedByThisGroup) return false;
  }
  return true;
}

export function jobsRoutes(
  jobStore: JobStore,
  jobLog: JobLog,
  jobRunner: JobRunner,
  inventoryPath: string,
  inventory: Inventory
): Router {
  const router = Router();

  // Rules and creators are read fresh per request; req.user is the overlaid
  // identity, so an active impersonation switches the creator lift off.
  const visible = (req: Request, job: JobRow): boolean =>
    isJobVisible(loadPermissionRules(inventoryPath), req.user ?? ANONYMOUS_CALLER, job, guestCreators(inventory));

  router.get('/', (req, res) => {
    const caller = req.user ?? ANONYMOUS_CALLER;
    const rules = loadPermissionRules(inventoryPath);
    const creators = guestCreators(inventory);
    res.json(jobStore.list().filter((j) => isJobVisible(rules, caller, j, creators)));
  });

  router.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    const job = jobStore.get(id);
    if (!job || !visible(req, job)) {
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
    if (!job || !visible(req, job)) {
      res.status(404).json({ error: `Unknown job id: ${req.params.id}` });
      return;
    }
    applyControl(req, res, job, 'cancel');
  });

  router.post('/:id/answer', (req, res) => {
    const id = Number(req.params.id);
    const job = jobStore.get(id);
    if (!job || !visible(req, job)) {
      res.status(404).json({ error: `Unknown job id: ${req.params.id}` });
      return;
    }
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    applyControl(req, res, job, 'answer', text);
  });

  router.post('/:id/dismiss-prompt', (req, res) => {
    const id = Number(req.params.id);
    const job = jobStore.get(id);
    if (!job || !visible(req, job)) {
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
  inventory: Inventory,
  impersonationStore: ImpersonationStore,
  // The same SessionService buildApp's requireAuth uses (#69), so a
  // bellhop_session cookie authenticates this socket exactly as it does an
  // /api request.
  sessions: SessionService,
  // isPidAlive: overridable for tests (see job-tail.ts) so a route-level
  // test can deterministically exercise the dead-owner path without
  // depending on a real pid ever being dead. Left unset in production, so
  // createForeignJobTail's own defaultIsPidAlive is used.
  options: { tailIntervalMs?: number; isPidAlive?: (pid: number) => boolean } = {}
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const tailIntervalMs = options.tailIntervalMs ?? 1000;

  server.on('upgrade', async (req, socket, head) => {
    // Async since #69: resolving the session may re-check it with the
    // provider. A socket error while that is pending must not go unhandled,
    // and any failure at all -- in the re-check or the visibility check
    // below -- destroys the socket rather than leaving it hanging or taking
    // the process down (this listener sits outside Express's error handling).
    const destroy = () => socket.destroy();
    socket.on('error', destroy);
    try {
      // The same resolution requireAuth uses (session cookie, re-checked when
      // due; then WEB_UI_DEV_USER; then the local operator in none mode).
      const user = await resolveRequestUser(req.headers, sessions);
      if (!user) {
        socket.destroy();
        return;
      }
      socket.off('error', destroy);
      // This handler is wired directly onto the raw http.Server and runs
      // before/independent of Express's middleware chain, so it needs its own
      // impersonation-overlay lookup -- applyImpersonation (src/web/
      // impersonation.ts) never sees this request. Mirrors that middleware's
      // overlay logic exactly: an active entry replaces the real groups with
      // just the impersonated group and sets `impersonating` (which switches
      // the issue #58 creator lift off) for the purposes of this connection's
      // job-visibility check.
      const impersonatedGroup = impersonationStore.get(user.username);
      const caller: AccessCaller = impersonatedGroup
        ? { ...user, groups: [impersonatedGroup], impersonating: impersonatedGroup }
        : user;
      const match = req.url?.match(/^\/ws\/jobs\/(\d+)$/);
      if (!match) {
        socket.destroy();
        return;
      }
      const jobId = Number(match[1]);
      const job = jobStore.get(jobId);
      const rules = loadPermissionRules(inventoryPath);
      if (!isJobVisible(rules, caller, job ?? null, guestCreators(inventory))) {
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
              isPidAlive: options.isPidAlive,
            });
            const interval = setInterval(() => {
              tail.tick();
              // A stopped tail always means no more messages are coming --
              // whether the job reached a terminal status (the client already
              // has the final 'status' message) or the tail gave up early (a
              // throwing tick, a row that vanished). Either way, closing the
              // socket here is what lets the client's own reconnect/HTTP-
              // polling fallback (it only triggers on 'close'/'error') take
              // over instead of the connection sitting open with nothing left
              // to feed it forever.
              if (tail.stopped) {
                clearInterval(interval);
                ws.close();
              }
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
    } catch {
      socket.destroy();
    }
  });

  return wss;
}
