import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { JobStore, defaultIsPidAlive } from '../../../src/web/jobs/job-store.ts';

test('createJob starts a job as queued and list/get return it', () => {
  const store = new JobStore(':memory:');
  const id = store.createJob({ command: 'create-lxc', category: 'provisioning', target: 'pve1', argsJson: '{"host":"pve1"}' });
  const row = store.get(id);
  assert.equal(row?.status, 'queued');
  assert.equal(row?.command, 'create-lxc');
  assert.equal(row?.startedAt, null);
  assert.equal(store.list().length, 1);
  store.close();
});

test('createJob records triggeredByUsername/triggeredByImpersonating when given, null otherwise', () => {
  const store = new JobStore(':memory:');
  const plain = store.createJob({ command: 'create-lxc', category: 'provisioning', argsJson: '{}' });
  const attributed = store.createJob({
    command: 'create-lxc',
    category: 'provisioning',
    argsJson: '{}',
    triggeredByUsername: 'admin',
    triggeredByImpersonating: 'bellhop-viewers',
  });
  assert.equal(store.get(plain)?.triggeredByUsername, null);
  assert.equal(store.get(plain)?.triggeredByImpersonating, null);
  assert.equal(store.get(attributed)?.triggeredByUsername, 'admin');
  assert.equal(store.get(attributed)?.triggeredByImpersonating, 'bellhop-viewers');
  store.close();
});

test('createJob sets a logFile timestamped "YYYY-MM-DD_HH-mm-ss-SSS" in local time', () => {
  const store = new JobStore(':memory:');
  const before = new Date();
  const id = store.createJob({ command: 'create-lxc', category: 'provisioning', argsJson: '{}' });
  const after = new Date();
  const row = store.get(id)!;
  assert.match(row.logFile, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}$/);
  assert.ok(
    row.logFile >= formatLocal(before) && row.logFile <= formatLocal(after),
    `expected logFile between ${formatLocal(before)} and ${formatLocal(after)}, got ${row.logFile}`
  );
  store.close();
});

test('createJob never collides on the same millisecond: two jobs created back-to-back get distinct logFiles', () => {
  const store = new JobStore(':memory:');
  const idA = store.createJob({ command: 'a', category: 'maintenance', argsJson: '{}' });
  const idB = store.createJob({ command: 'b', category: 'maintenance', argsJson: '{}' });
  assert.notEqual(store.get(idA)!.logFile, store.get(idB)!.logFile);
  store.close();
});

test('interruptOrphaned flips queued/running/awaiting_input rows to interrupted, leaves terminal rows untouched', () => {
  const store = new JobStore(':memory:');
  const queuedId = store.createJob({ command: 'a', category: 'maintenance', argsJson: '{}' });
  const runningId = store.createJob({ command: 'b', category: 'maintenance', argsJson: '{}' });
  store.markRunning(runningId);
  const awaitingId = store.createJob({ command: 'c', category: 'provisioning', argsJson: '{}' });
  store.markRunning(awaitingId);
  store.markAwaitingInput(awaitingId, 'Add Adminer? (y/N) ', 'heuristic', null);
  const successId = store.createJob({ command: 'd', category: 'maintenance', argsJson: '{}' });
  store.markRunning(successId);
  store.markFinished(successId, { status: 'success', exitCode: 0 });

  const orphaned = store.interruptOrphaned();

  assert.equal(orphaned.length, 3);
  assert.deepEqual(
    orphaned.map((r) => r.id).sort((a, b) => a - b),
    [queuedId, runningId, awaitingId].sort((a, b) => a - b)
  );
  assert.equal(orphaned.find((r) => r.id === queuedId)?.status, 'queued');
  assert.equal(orphaned.find((r) => r.id === runningId)?.status, 'running');
  assert.equal(orphaned.find((r) => r.id === awaitingId)?.status, 'awaiting_input');
  assert.equal(orphaned.find((r) => r.id === queuedId)?.logFile, store.get(queuedId)!.logFile);
  assert.equal(orphaned.find((r) => r.id === runningId)?.logFile, store.get(runningId)!.logFile);
  assert.equal(orphaned.find((r) => r.id === awaitingId)?.logFile, store.get(awaitingId)!.logFile);

  const queuedRow = store.get(queuedId)!;
  assert.equal(queuedRow.status, 'interrupted');
  assert.equal(queuedRow.errorMessage, 'Interrupted by service restart while queued');
  assert.ok(queuedRow.finishedAt);
  assert.equal(queuedRow.startedAt, null);

  const runningRow = store.get(runningId)!;
  assert.equal(runningRow.status, 'interrupted');
  assert.equal(runningRow.errorMessage, 'Interrupted by service restart while running');
  assert.ok(runningRow.startedAt);
  assert.ok(runningRow.finishedAt);

  const awaitingRow = store.get(awaitingId)!;
  assert.equal(awaitingRow.status, 'interrupted');
  assert.equal(awaitingRow.errorMessage, 'Interrupted by service restart while awaiting_input');
  assert.equal(awaitingRow.promptText, null);

  const successRow = store.get(successId)!;
  assert.equal(successRow.status, 'success');
  assert.equal(successRow.errorMessage, null);

  store.close();
});

test('interruptOrphaned returns an empty array when there are no non-terminal jobs', () => {
  const store = new JobStore(':memory:');
  const id = store.createJob({ command: 'a', category: 'maintenance', argsJson: '{}' });
  store.markFinished(id, { status: 'success', exitCode: 0 });
  assert.deepEqual(store.interruptOrphaned(), []);
  store.close();
});

function formatLocal(d: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

test('markRunning then markFinished(success) updates status/timestamps/exitCode', () => {
  const store = new JobStore(':memory:');
  const id = store.createJob({ command: 'update-all', category: 'maintenance', argsJson: '{}' });
  store.markRunning(id);
  assert.equal(store.get(id)?.status, 'running');
  assert.ok(store.get(id)?.startedAt);
  store.markFinished(id, { status: 'success', exitCode: 0 });
  const row = store.get(id)!;
  assert.equal(row.status, 'success');
  assert.equal(row.exitCode, 0);
  assert.ok(row.finishedAt);
  store.close();
});

test('markFinished(failed) records the error message', () => {
  const store = new JobStore(':memory:');
  const id = store.createJob({ command: 'migrate-nfs-mount', category: 'provisioning', argsJson: '{}' });
  store.markRunning(id);
  store.markFinished(id, { status: 'failed', exitCode: 1, errorMessage: 'boom' });
  assert.equal(store.get(id)?.errorMessage, 'boom');
  store.close();
});

test('markAwaitingInput sets status to awaiting_input and records promptText', () => {
  const store = new JobStore(':memory:');
  const id = store.createJob({ command: 'install-app', category: 'provisioning', argsJson: '{}' });
  store.markRunning(id);
  store.markAwaitingInput(id, 'Add Adminer? (y/N) ', 'heuristic', null);
  const row = store.get(id)!;
  assert.equal(row.status, 'awaiting_input');
  assert.equal(row.promptText, 'Add Adminer? (y/N) ');
  store.close();
});

test('markRunning clears promptText and preserves the original startedAt when resuming from awaiting_input', async () => {
  const store = new JobStore(':memory:');
  const id = store.createJob({ command: 'install-app', category: 'provisioning', argsJson: '{}' });
  store.markRunning(id);
  const firstStartedAt = store.get(id)!.startedAt;
  store.markAwaitingInput(id, 'Add Adminer? (y/N) ', 'heuristic', null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.markRunning(id);
  const row = store.get(id)!;
  assert.equal(row.status, 'running');
  assert.equal(row.promptText, null);
  assert.equal(row.startedAt, firstStartedAt);
  store.close();
});

test('createJob stores expectedPromptsJson when given, and null when omitted', () => {
  const store = new JobStore(':memory:');
  const withPrompts = store.createJob({
    command: 'install-app',
    category: 'provisioning',
    argsJson: '{}',
    expectedPromptsJson: JSON.stringify(['Add Adminer? (y/N) ']),
  });
  const withoutPrompts = store.createJob({ command: 'create-lxc', category: 'provisioning', argsJson: '{}' });
  assert.equal(store.get(withPrompts)?.expectedPromptsJson, JSON.stringify(['Add Adminer? (y/N) ']));
  assert.equal(store.get(withoutPrompts)?.expectedPromptsJson, null);
  store.close();
});

test('opening a pre-existing jobs database without prompt_text/expected_prompts_json migrates it in place', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jobstore-'));
  const dest = path.join(dir, 'jobs.sqlite3');
  const legacyDb = new Database(dest);
  legacyDb.exec(`
    CREATE TABLE jobs (
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
      error_message TEXT
    )
  `);
  legacyDb
    .prepare(
      `INSERT INTO jobs (command, category, args_json, status, log_file) VALUES ('create-lxc', 'provisioning', '{}', 'success', '2026-01-01_00-00-00-000')`
    )
    .run();
  legacyDb.close();

  const store = new JobStore(dest);
  const row = store.get(1)!;
  assert.equal(row.promptText, null, 'a pre-migration row has no prompt_text value');
  assert.equal(row.expectedPromptsJson, null, 'a pre-migration row has no expected_prompts_json value');
  store.markAwaitingInput(1, 'Add Adminer? (y/N) ', 'heuristic', null);
  assert.equal(store.get(1)?.promptText, 'Add Adminer? (y/N) ', 'the migrated column must actually be writable/readable');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('constructor creates the parent directory when it does not already exist', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'jobstore-'));
  const dbPath = path.join(parent, 'nested', 'jobs.sqlite3');
  assert.equal(existsSync(path.dirname(dbPath)), false);
  const store = new JobStore(dbPath);
  assert.equal(existsSync(dbPath), true);
  store.close();
  rmSync(parent, { recursive: true, force: true });
});

test('list returns most recent jobs first', () => {
  const store = new JobStore(':memory:');
  const first = store.createJob({ command: 'a', category: 'maintenance', argsJson: '{}' });
  const second = store.createJob({ command: 'b', category: 'maintenance', argsJson: '{}' });
  const ids = store.list().map((r) => r.id);
  assert.deepEqual(ids, [second, first]);
  store.close();
});

test('markAwaitingInput records the prompt origin and matched index, and markRunning clears them', () => {
  const store = new JobStore(':memory:');
  const id = store.createJob({ command: 'install-app', category: 'provisioning', argsJson: '{}' });

  store.markAwaitingInput(id, '   Enter the Cloudflare API token: ', 'expected', 0);
  const awaiting = store.get(id);
  assert.equal(awaiting?.status, 'awaiting_input');
  assert.equal(awaiting?.promptText, '   Enter the Cloudflare API token: ');
  assert.equal(awaiting?.promptOrigin, 'expected');
  assert.equal(awaiting?.promptMatchedIndex, 0);

  store.markRunning(id);
  const running = store.get(id);
  assert.equal(running?.promptText, null);
  assert.equal(running?.promptOrigin, null);
  assert.equal(running?.promptMatchedIndex, null);
  store.close();
});

test('a stall-origin pause records a null matched index', () => {
  const store = new JobStore(':memory:');
  const id = store.createJob({ command: 'install-app', category: 'provisioning', argsJson: '{}' });
  store.markAwaitingInput(id, 'Waiting for the service to come up', 'stall', null);
  const job = store.get(id);
  assert.equal(job?.promptOrigin, 'stall');
  assert.equal(job?.promptMatchedIndex, null);
  store.close();
});

test('a jobs table created before the prompt-origin columns existed gains them on open', () => {
  // ensureColumn's whole purpose -- this operator's real bellhop.db
  // already has a jobs table, and opening it must not fail or lose rows.
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'jobstore-legacy-')), 'bellhop.db');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command TEXT NOT NULL,
      category TEXT NOT NULL,
      target TEXT,
      args_json TEXT NOT NULL,
      status TEXT NOT NULL,
      log_file TEXT NOT NULL
    )
  `);
  legacy.prepare(`INSERT INTO jobs (command, category, args_json, status, log_file) VALUES (?, ?, ?, ?, ?)`).run(
    'install-app',
    'provisioning',
    '{}',
    'success',
    'old.log'
  );
  legacy.close();

  const store = new JobStore(dbPath);
  const existing = store.list();
  assert.equal(existing.length, 1);
  assert.equal(existing[0].promptOrigin, null);
  assert.equal(existing[0].promptMatchedIndex, null);

  // And the columns are writable, not merely present.
  const id = store.createJob({ command: 'install-app', category: 'provisioning', argsJson: '{}' });
  store.markAwaitingInput(id, 'Proxied? (y/n): ', 'expected', 2);
  assert.equal(store.get(id)?.promptOrigin, 'expected');
  assert.equal(store.get(id)?.promptMatchedIndex, 2);
  store.close();
});

test('createJob records owner when given, null otherwise', () => {
  const store = new JobStore(':memory:');
  const plain = store.createJob({ command: 'sync-caddy', category: 'maintenance', argsJson: '{}' });
  const owned = store.createJob({ command: 'sync-caddy', category: 'maintenance', argsJson: '{}', owner: 'mcp:123' });
  assert.equal(store.get(plain)?.owner, null);
  assert.equal(store.get(owned)?.owner, 'mcp:123');
  store.close();
});

test('interruptOrphaned only touches the caller\'s own rows plus rows of dead mcp processes (#16)', () => {
  const store = new JobStore(':memory:');
  const legacy = store.createJob({ command: 'a', category: 'maintenance', argsJson: '{}' });
  const web = store.createJob({ command: 'b', category: 'maintenance', argsJson: '{}', owner: 'web' });
  const liveMcp = store.createJob({ command: 'c', category: 'maintenance', argsJson: '{}', owner: 'mcp:111' });
  const deadMcp = store.createJob({ command: 'd', category: 'maintenance', argsJson: '{}', owner: 'mcp:222' });
  for (const id of [legacy, web, liveMcp, deadMcp]) store.markRunning(id);
  const isPidAlive = (pid: number) => pid === 111;

  const fromWeb = store.interruptOrphaned('web', isPidAlive).map((r) => r.id).sort();
  assert.deepEqual(fromWeb, [legacy, web, deadMcp].sort());
  assert.equal(store.get(liveMcp)?.status, 'running');
  store.close();
});

test('interruptOrphaned called by an mcp process leaves web-owned and legacy rows alone (#16)', () => {
  const store = new JobStore(':memory:');
  const legacy = store.createJob({ command: 'a', category: 'maintenance', argsJson: '{}' });
  const web = store.createJob({ command: 'b', category: 'maintenance', argsJson: '{}', owner: 'web' });
  const mine = store.createJob({ command: 'c', category: 'maintenance', argsJson: '{}', owner: 'mcp:333' });
  for (const id of [legacy, web, mine]) store.markRunning(id);

  const fromMcp = store.interruptOrphaned('mcp:333', () => true).map((r) => r.id);
  assert.deepEqual(fromMcp, [mine]);
  assert.equal(store.get(legacy)?.status, 'running');
  assert.equal(store.get(web)?.status, 'running');
  assert.equal(store.get(mine)?.status, 'interrupted');
  store.close();
});

test('defaultIsPidAlive reports the current process alive', () => {
  assert.equal(defaultIsPidAlive(process.pid), true);
});
