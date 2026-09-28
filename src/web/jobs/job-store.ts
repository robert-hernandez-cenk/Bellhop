import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type JobStatus = 'queued' | 'running' | 'awaiting_input' | 'success' | 'failed' | 'cancelled' | 'interrupted';

export interface JobRow {
  id: number;
  command: string;
  category: 'provisioning' | 'maintenance';
  target: string | null;
  argsJson: string;
  status: JobStatus;
  // Base filename (no extension) of this job's log under the JobLog dir --
  // "YYYY-MM-DD_HH-mm-ss" in local time, set once at creation so it always
  // matches the actual log file on disk regardless of when the job starts
  // running or how long it takes.
  logFile: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
  // Set only while status === 'awaiting_input' -- the detected trailing
  // output that triggered the pause (see issue #57). Cleared back to null
  // by markRunning() once the prompt is answered or dismissed.
  promptText: string | null;
  // Set once at createJob time by install-app's job only -- the static
  // read-p pre-scan of the app's install script, JSON-encoded. Display-only,
  // never gates the runtime detection heuristic. Every other command's job
  // leaves this null.
  expectedPromptsJson: string | null;
  // Which detection tier produced the current pause -- 'expected',
  // 'heuristic', or 'stall' (issue #160). Set alongside promptText and
  // cleared with it by markRunning(). Null for a job that predates this
  // column, and for any job not currently awaiting input.
  promptOrigin: string | null;
  // Index into expectedPromptsJson's array for an 'expected' origin; null for
  // the other two, and for a job that predates this column.
  promptMatchedIndex: number | null;
  // Real, non-overlaid username of whoever triggered this job -- null for
  // any job that predates this column, or one created by a path with no
  // request context (there is none of the latter today, but the column
  // stays nullable rather than requiring every caller to supply it).
  triggeredByUsername: string | null;
  // The group name being impersonated at the time this job was created, or
  // null for a normal (non-impersonated) job.
  triggeredByImpersonating: string | null;
  // Which process created (and therefore controls) this job: 'web' for the
  // web service, 'mcp:<pid>' for an MCP server process (#16). Null for a
  // job that predates this column -- treated as 'web' everywhere.
  owner: string | null;
}

// Cross-process job control request queue (#6): a non-owning process (the
// other of web/MCP) can't call cancel/answerPrompt/dismissPrompt directly
// -- those live only in the owning JobRunner's in-memory state, in a
// different process. Instead it inserts a row here; the owning JobRunner
// polls pendingControlRequests(its own owner) while it has active jobs and
// applies each one through its normal methods. See
// src/web/jobs/job-control.ts and specs/007-cross-process-job-control/
// research.md R2-R4.
export type ControlAction = 'cancel' | 'answer' | 'dismiss';

export interface ControlRequestRow {
  id: number;
  jobId: number;
  action: ControlAction;
  // Answer text for 'answer' only -- cleared to null once handled (see
  // markControlRequestHandled), so a completed answer never lingers
  // readable in this table.
  text: string | null;
  // Requesting process: 'web' or 'mcp:<pid>' -- same shape as JobRow.owner.
  requestedByOwner: string;
  // Real web user, when known; null from MCP (which has no user concept).
  requestedByUsername: string | null;
  createdAt: string;
  // Null while pending.
  handledAt: string | null;
  result: 'applied' | 'not-applicable' | null;
}

interface CreateControlRequestInput {
  jobId: number;
  action: ControlAction;
  text?: string;
  requestedByOwner: string;
  requestedByUsername?: string;
}

interface CreateJobInput {
  command: string;
  category: 'provisioning' | 'maintenance';
  target?: string;
  argsJson: string;
  expectedPromptsJson?: string;
  triggeredByUsername?: string;
  triggeredByImpersonating?: string;
  owner?: string;
}

interface FinishInput {
  status: 'success' | 'failed' | 'cancelled';
  exitCode: number;
  errorMessage?: string;
}

// Local time, not UTC -- these filenames are for a human operator glancing at
// the data/job-logs directory, so they should read the same wall-clock time
// the operator sees in the UI. Milliseconds are appended so two jobs created
// within the same second (e.g. queued back-to-back) never collide on one
// log file.
function formatLogFileName(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

// Adds a column to an already-existing jobs table when it's missing --
// covers a real, already-populated data/jobs.sqlite3 where the CREATE TABLE
// IF NOT EXISTS below is a no-op and can't retroactively add a new column.
// Mirrors src/lib/inventory.ts's own ensureColumn helper (not shared/
// exported from there -- this is a separate SQLite database/table).
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// process.kill(pid, 0) sends no signal -- it only checks the pid exists.
// EPERM means it exists but belongs to another user, so it's still alive.
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A row is an orphan for `caller` when caller owns it (a fresh process has
// no in-memory controllers, so nothing it owns can still be running), or
// when it belongs to an MCP process that has since died. Another live
// process's rows are never touched -- without this, starting the MCP server
// would interrupt the web service's in-flight jobs, and vice versa (#16).
function isOrphanFor(rowOwner: string | null, caller: string, isPidAlive: (pid: number) => boolean): boolean {
  const owner = rowOwner ?? 'web';
  if (owner === caller) return true;
  const match = /^mcp:(\d+)$/.exec(owner);
  return match !== null && !isPidAlive(Number(match[1]));
}

export class JobStore {
  private db: Database.Database;
  // Epoch ms of the last logFile handed out -- Date.now() alone can repeat
  // across two createJob() calls in the same synchronous tick (system clock
  // resolution isn't guaranteed to be sub-millisecond), which would make two
  // back-to-back-queued jobs share one log file. Bumping by 1ms whenever
  // that would happen keeps every logFile strictly increasing and unique
  // per JobStore instance, regardless of how fast callers queue jobs.
  private lastLogFileMs = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // Two processes (the web service and the MCP server) now write this
    // database concurrently (#16); WAL lets readers proceed during a write
    // and cuts the rollback journal's SQLITE_BUSY contention between them.
    if (path !== ':memory:') this.db.pragma('journal_mode = WAL');
    // A closed/handled control request's answer text is overwritten with
    // NULL (markControlRequestHandled/closeStaleControlRequests), but a
    // plain UPDATE can leave the old value readable in a freed database
    // page until something else overwrites it -- secure_delete makes SQLite
    // scrub freed pages in the main database file once those changes are
    // checkpointed. The row-level guarantee SC-005 actually relies on is
    // narrower: the answer text column reads back NULL once handled. In WAL
    // mode (see above), the original write can still live on in an
    // as-yet-unreused frame of jobs.sqlite3-wal until the WAL is
    // checkpointed and that frame is overwritten -- accepted here, since
    // this is a single-operator local disk, not a shared or untrusted one.
    this.db.pragma('secure_delete = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL,
        category TEXT NOT NULL,
        target TEXT,
        args_json TEXT NOT NULL,
        status TEXT NOT NULL,
        log_file TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        exit_code INTEGER,
        error_message TEXT,
        prompt_text TEXT,
        expected_prompts_json TEXT,
        prompt_origin TEXT,
        prompt_matched_index INTEGER,
        triggered_by_username TEXT,
        triggered_by_impersonating TEXT,
        owner TEXT
      )
    `);
    ensureColumn(this.db, 'jobs', 'prompt_text', 'prompt_text TEXT');
    ensureColumn(this.db, 'jobs', 'expected_prompts_json', 'expected_prompts_json TEXT');
    ensureColumn(this.db, 'jobs', 'prompt_origin', 'prompt_origin TEXT');
    ensureColumn(this.db, 'jobs', 'prompt_matched_index', 'prompt_matched_index INTEGER');
    ensureColumn(this.db, 'jobs', 'triggered_by_username', 'triggered_by_username TEXT');
    ensureColumn(this.db, 'jobs', 'triggered_by_impersonating', 'triggered_by_impersonating TEXT');
    ensureColumn(this.db, 'jobs', 'owner', 'owner TEXT');
    // Brand new table (#6) -- unlike `jobs`, it never predates any of its
    // own columns, so there's no ensureColumn migration to run here.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_control_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('cancel', 'answer', 'dismiss')),
        text TEXT,
        requested_by_owner TEXT NOT NULL,
        requested_by_username TEXT,
        created_at TEXT NOT NULL,
        handled_at TEXT,
        result TEXT
      )
    `);
  }

  createJob(input: CreateJobInput): number {
    const nowMs = Math.max(Date.now(), this.lastLogFileMs + 1);
    this.lastLogFileMs = nowMs;
    const logFile = formatLogFileName(new Date(nowMs));
    const stmt = this.db.prepare(
      `INSERT INTO jobs (command, category, target, args_json, status, log_file, expected_prompts_json, triggered_by_username, triggered_by_impersonating, owner) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      input.command,
      input.category,
      input.target ?? null,
      input.argsJson,
      logFile,
      input.expectedPromptsJson ?? null,
      input.triggeredByUsername ?? null,
      input.triggeredByImpersonating ?? null,
      input.owner ?? null
    );
    return Number(result.lastInsertRowid);
  }

  // Also doubles as the "prompt cleared" transition (see markAwaitingInput)
  // -- COALESCE keeps the original startedAt intact on that second call
  // rather than overwriting it with the resume time.
  markRunning(id: number): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?), prompt_text = NULL, prompt_origin = NULL, prompt_matched_index = NULL WHERE id = ?`
      )
      .run(new Date().toISOString(), id);
  }

  markAwaitingInput(id: number, promptText: string, promptOrigin: string, promptMatchedIndex: number | null): void {
    this.db
      .prepare(`UPDATE jobs SET status = 'awaiting_input', prompt_text = ?, prompt_origin = ?, prompt_matched_index = ? WHERE id = ?`)
      .run(promptText, promptOrigin, promptMatchedIndex, id);
  }

  markFinished(id: number, result: FinishInput): void {
    this.db
      .prepare(`UPDATE jobs SET status = ?, finished_at = ?, exit_code = ?, error_message = ? WHERE id = ?`)
      .run(result.status, new Date().toISOString(), result.exitCode, result.errorMessage ?? null, id);
  }

  // Called once at process startup (see JobRunner.reconcileOrphanedJobs) --
  // any row still in one of these three statuses cannot belong to the
  // current process, since a freshly started process's controllers/
  // pendingPrompts maps are always empty. Returns the affected rows as they
  // were *before* the update (their original status, still-correct
  // logFile) so the caller can write a matching note into each job's log.
  // Scoped to `owner` -- see isOrphanFor.
  interruptOrphaned(owner = 'web', isPidAlive: (pid: number) => boolean = defaultIsPidAlive): JobRow[] {
    const candidates = (
      this.db.prepare(`SELECT * FROM jobs WHERE status IN ('queued', 'running', 'awaiting_input')`).all() as any[]
    ).map((row) => this.toJobRow(row));
    const orphaned = candidates.filter((row) => isOrphanFor(row.owner, owner, isPidAlive));
    const update = this.db.prepare(
      `UPDATE jobs
       SET status = 'interrupted',
           finished_at = ?,
           error_message = 'Interrupted by service restart while ' || status,
           prompt_text = NULL,
           prompt_origin = NULL,
           prompt_matched_index = NULL
       WHERE id = ?`
    );
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const row of orphaned) update.run(now, row.id);
    })();
    return orphaned;
  }

  get(id: number): JobRow | undefined {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as any;
    return row ? this.toJobRow(row) : undefined;
  }

  list(limit = 100): JobRow[] {
    const rows = this.db.prepare(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`).all(limit) as any[];
    return rows.map((row) => this.toJobRow(row));
  }

  createControlRequest(input: CreateControlRequestInput): number {
    const stmt = this.db.prepare(
      `INSERT INTO job_control_requests (job_id, action, text, requested_by_owner, requested_by_username, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      input.jobId,
      input.action,
      input.text ?? null,
      input.requestedByOwner,
      input.requestedByUsername ?? null,
      new Date().toISOString()
    );
    return Number(result.lastInsertRowid);
  }

  // Scoped to the owner that would actually apply these -- COALESCE(owner,
  // 'web') mirrors isOrphanFor's own null-owner-means-'web' treatment, so a
  // pre-#16 job's control requests still reach the web service's poller.
  // Ordered by id (application order), never by created_at, since two rows
  // can share a timestamp at this scale.
  pendingControlRequests(owner: string): ControlRequestRow[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM job_control_requests r
         JOIN jobs j ON j.id = r.job_id
         WHERE r.handled_at IS NULL AND COALESCE(j.owner, 'web') = ?
         ORDER BY r.id`
      )
      .all(owner) as any[];
    return rows.map((row) => this.toControlRequestRow(row));
  }

  // Clears `text` unconditionally -- simpler than branching on action, and
  // it's already null for cancel/dismiss rows. A handled row is kept (a
  // small audit record with the answer text gone), never deleted.
  markControlRequestHandled(id: number, result: 'applied' | 'not-applicable'): void {
    this.db
      .prepare(`UPDATE job_control_requests SET handled_at = ?, result = ?, text = NULL WHERE id = ?`)
      .run(new Date().toISOString(), result, id);
  }

  // SC-005 retention gap (fix round 1): a pending request whose owner never
  // gets a chance to poll it again -- its process exits after the
  // requester's own liveness check, or the job finishes in the gap between
  // that check and the row being written -- would otherwise keep its
  // answer text forever, since nothing else ever marks it handled. Closes
  // every pending row, regardless of which owner would normally apply it,
  // whose job is terminal (success/failed/cancelled/interrupted) or no
  // longer exists at all, or whose job's owner is a dead mcp:<pid> even
  // while the job row itself is still non-terminal (the process died, not
  // the job -- nothing will ever interrupt that row until some process's
  // reconcileOrphanedJobs happens to run again). Called from
  // JobRunner.reconcileOrphanedJobs (after interruptOrphaned, so a job it
  // just interrupted already counts as terminal here) and at the start of
  // every processControlRequests() pass.
  closeStaleControlRequests(isPidAlive: (pid: number) => boolean = defaultIsPidAlive): void {
    const TERMINAL: JobStatus[] = ['success', 'failed', 'cancelled', 'interrupted'];
    const rows = this.db
      .prepare(
        `SELECT r.id AS request_id, j.status AS job_status, j.owner AS job_owner
         FROM job_control_requests r
         LEFT JOIN jobs j ON j.id = r.job_id
         WHERE r.handled_at IS NULL`
      )
      .all() as { request_id: number; job_status: JobStatus | null; job_owner: string | null }[];

    const staleIds: number[] = [];
    for (const row of rows) {
      if (row.job_status === null || TERMINAL.includes(row.job_status)) {
        staleIds.push(row.request_id);
        continue;
      }
      const match = /^mcp:(\d+)$/.exec(row.job_owner ?? 'web');
      if (match && !isPidAlive(Number(match[1]))) {
        staleIds.push(row.request_id);
      }
    }
    if (staleIds.length === 0) return;

    const update = this.db.prepare(`UPDATE job_control_requests SET handled_at = ?, result = 'not-applicable', text = NULL WHERE id = ?`);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const id of staleIds) update.run(now, id);
    })();
  }

  close(): void {
    this.db.close();
  }

  private toControlRequestRow(row: any): ControlRequestRow {
    return {
      id: row.id,
      jobId: row.job_id,
      action: row.action,
      text: row.text,
      requestedByOwner: row.requested_by_owner,
      requestedByUsername: row.requested_by_username,
      createdAt: row.created_at,
      handledAt: row.handled_at,
      result: row.result,
    };
  }

  private toJobRow(row: any): JobRow {
    return {
      id: row.id,
      command: row.command,
      category: row.category,
      target: row.target,
      argsJson: row.args_json,
      status: row.status,
      logFile: row.log_file,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      exitCode: row.exit_code,
      errorMessage: row.error_message,
      promptText: row.prompt_text,
      expectedPromptsJson: row.expected_prompts_json,
      promptOrigin: row.prompt_origin,
      promptMatchedIndex: row.prompt_matched_index,
      triggeredByUsername: row.triggered_by_username,
      triggeredByImpersonating: row.triggered_by_impersonating,
      owner: row.owner,
    };
  }
}
