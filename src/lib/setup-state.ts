import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDb } from './sqlite.ts';
import type { Inventory } from './inventory.ts';

// The first-run setup walkthrough's own record (issue #86, data-model.md):
// whether setup is pending or finished, the one-time setup token while it
// is pending, and which steps are done. One row per install.
//
// Lives in bellhop.db beside the inventory, outside saveInventory's
// delete-and-reinsert list -- same precedent as task_schedules and
// app_update_status -- so no inventory save can ever reset setup.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS setup_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL CHECK (status IN ('pending', 'finished')),
    token TEXT,
    completed_steps_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export type SetupStatus = 'pending' | 'finished';
// 'not-applicable' is derived, never stored: an install that already had
// hosts before setup existed (an existing deployment upgrading).
export type SetupPhase = SetupStatus | 'not-applicable';

export interface SetupState {
  status: SetupStatus;
  token: string | null;
  completedSteps: string[];
  updatedAt: string;
}

interface SetupStateRow {
  status: SetupStatus;
  token: string | null;
  completed_steps_json: string;
  updated_at: string;
}

function openSetupDb(dbPath: string): Database.Database {
  return openDb(dbPath, SCHEMA);
}

function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = openSetupDb(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readRow(db: Database.Database): SetupState | undefined {
  const row = db.prepare('SELECT status, token, completed_steps_json, updated_at FROM setup_state WHERE id = 1').get() as
    | SetupStateRow
    | undefined;
  if (!row) return undefined;
  return {
    status: row.status,
    token: row.token,
    completedSteps: JSON.parse(row.completed_steps_json) as string[],
    updatedAt: row.updated_at,
  };
}

export function loadSetupState(dbPath: string): SetupState | undefined {
  return withDb(dbPath, readRow);
}

// research R2: a stored record decides; without one, an install with no
// hosts is a fresh one (pending) and one with hosts predates setup.
export function setupPhase(dbPath: string, inventory: Pick<Inventory, 'hosts'>): SetupPhase {
  const state = loadSetupState(dbPath);
  if (state) return state.status;
  return inventory.hosts.length === 0 ? 'pending' : 'not-applicable';
}

// Creates the pending record and its token on the first call, and returns
// the same record on every later one, so a token the installer printed
// stays valid across restarts (research R3). 32 random bytes, base64url.
export function ensurePendingSetup(dbPath: string): SetupState {
  return withDb(dbPath, (db) =>
    db.transaction(() => {
      const existing = readRow(db);
      if (existing?.status === 'finished') throw new Error('Setup has already finished');
      if (existing) return existing;
      const created: SetupState = {
        status: 'pending',
        token: randomBytes(32).toString('base64url'),
        completedSteps: [],
        updatedAt: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO setup_state (id, status, token, completed_steps_json, updated_at) VALUES (1, 'pending', ?, '[]', ?)"
      ).run(created.token, created.updatedAt);
      return created;
    }).immediate()
  );
}

export function completeSetupStep(dbPath: string, step: string): SetupState {
  return withDb(dbPath, (db) =>
    db.transaction(() => {
      const state = readRow(db);
      if (state?.status !== 'pending') throw new Error('Setup is not in progress');
      if (state.completedSteps.includes(step)) return state;
      const updated: SetupState = {
        ...state,
        completedSteps: [...state.completedSteps, step],
        updatedAt: new Date().toISOString(),
      };
      db.prepare('UPDATE setup_state SET completed_steps_json = ?, updated_at = ? WHERE id = 1').run(
        JSON.stringify(updated.completedSteps),
        updated.updatedAt
      );
      return updated;
    }).immediate()
  );
}

// Terminal: the token is deleted, and nothing ever sets the status back.
export function finishSetup(dbPath: string): void {
  withDb(dbPath, (db) => {
    db.prepare("UPDATE setup_state SET status = 'finished', token = NULL, updated_at = ? WHERE id = 1").run(
      new Date().toISOString()
    );
  });
}

// A step whose saved choice changed is no longer proven (#87): drops it from
// the completed list so Finish refuses until it passes again. A step that is
// not completed is left alone, row and timestamp included.
export function uncompleteSetupStep(dbPath: string, step: string): SetupState {
  return withDb(dbPath, (db) =>
    db.transaction(() => {
      const state = readRow(db);
      if (state?.status !== 'pending') throw new Error('Setup is not in progress');
      if (!state.completedSteps.includes(step)) return state;
      const updated: SetupState = {
        ...state,
        completedSteps: state.completedSteps.filter((s) => s !== step),
        updatedAt: new Date().toISOString(),
      };
      db.prepare('UPDATE setup_state SET completed_steps_json = ?, updated_at = ? WHERE id = 1').run(
        JSON.stringify(updated.completedSteps),
        updated.updatedAt
      );
      return updated;
    }).immediate()
  );
}
