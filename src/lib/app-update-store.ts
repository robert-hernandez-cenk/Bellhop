import Database from 'better-sqlite3';
import { openDb } from './sqlite.ts';

// The five outcomes check-app-updates can record for one guest (research
// R7/data-model.md) -- also the SQLite CHECK constraint's own value list
// below, so a hand-written row that doesn't match one of these is rejected
// at the database layer rather than merely at the TypeScript boundary.
export type AppUpdateStatus = 'update-available' | 'up-to-date' | 'unsupported' | 'not-checked' | 'error';

// data-model.md's app_update_status row, as TypeScript/API shape. Optional
// fields are `undefined` here and NULL in the database -- never an empty
// string, so a caller can tell "not set" apart from "set to ''".
export interface AppUpdateResult {
  guest: string;
  app: string;
  status: AppUpdateStatus;
  installedVersion?: string;
  latestVersion?: string;
  repo?: string;
  message?: string;
  checkedAt: string;
}

// Lives in the same bellhop.db file as the inventory, as its own table
// outside saveInventory's DELETE FROM .../re-insert list -- same precedent
// as script_catalog/permission_groups (src/lib/script-catalog.ts,
// src/lib/permissions.ts), so a sync-inventory --apply run never disturbs
// it and loadInventory/saveInventory never need to know it exists.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_update_status (
    guest TEXT PRIMARY KEY,
    app TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('update-available', 'up-to-date', 'unsupported', 'not-checked', 'error')),
    installed_version TEXT,
    latest_version TEXT,
    repo TEXT,
    message TEXT,
    checked_at TEXT NOT NULL
  );
`;

function openAppUpdateDb(dbPath: string): Database.Database {
  return openDb(dbPath, SCHEMA);
}

interface AppUpdateRow {
  guest: string;
  app: string;
  status: AppUpdateStatus;
  installed_version: string | null;
  latest_version: string | null;
  repo: string | null;
  message: string | null;
  checked_at: string;
}

function rowToResult(row: AppUpdateRow): AppUpdateResult {
  return {
    guest: row.guest,
    app: row.app,
    status: row.status,
    installedVersion: row.installed_version ?? undefined,
    latestVersion: row.latest_version ?? undefined,
    repo: row.repo ?? undefined,
    message: row.message ?? undefined,
    checkedAt: row.checked_at,
  };
}

// better-sqlite3's named-parameter binding rejects `undefined` outright, so
// every optional field is coerced to `null` here -- the one place that
// conversion happens, rather than at each call site.
function resultToRow(result: AppUpdateResult): AppUpdateRow {
  return {
    guest: result.guest,
    app: result.app,
    status: result.status,
    installed_version: result.installedVersion ?? null,
    latest_version: result.latestVersion ?? null,
    repo: result.repo ?? null,
    message: result.message ?? null,
    checked_at: result.checkedAt,
  };
}

const UPSERT_SQL = `
  INSERT INTO app_update_status (guest, app, status, installed_version, latest_version, repo, message, checked_at)
  VALUES (@guest, @app, @status, @installed_version, @latest_version, @repo, @message, @checked_at)
  ON CONFLICT(guest) DO UPDATE SET
    app = excluded.app,
    status = excluded.status,
    installed_version = excluded.installed_version,
    latest_version = excluded.latest_version,
    repo = excluded.repo,
    message = excluded.message,
    checked_at = excluded.checked_at
`;

// Every row, ordered by guest (data-model.md) -- the API layer is what
// narrows this to eligible/visible guests, not this function.
export function loadAppUpdateResults(dbPath: string): AppUpdateResult[] {
  const db = openAppUpdateDb(dbPath);
  try {
    const rows = db.prepare('SELECT * FROM app_update_status ORDER BY guest').all() as AppUpdateRow[];
    return rows.map(rowToResult);
  } finally {
    db.close();
  }
}

// Used by the post-update re-check and a `--guest`-scoped run (data-model.md)
// -- replaces exactly one row, leaving every other guest's result untouched.
export function upsertAppUpdateResult(dbPath: string, result: AppUpdateResult): void {
  const db = openAppUpdateDb(dbPath);
  try {
    db.prepare(UPSERT_SQL).run(resultToRow(result));
  } finally {
    db.close();
  }
}

// Used by a full run (FR-021): one transaction, delete everything then
// insert the new set, so a guest dropped from this run's results (removed
// from inventory, or no longer an eligible app guest) doesn't leave a stale
// row behind. The whole transaction rolls back together if any row fails
// the status CHECK constraint.
export function replaceAppUpdateResults(dbPath: string, results: AppUpdateResult[]): void {
  const db = openAppUpdateDb(dbPath);
  try {
    const insert = db.prepare(UPSERT_SQL);
    const tx = db.transaction((rows: AppUpdateResult[]) => {
      db.prepare('DELETE FROM app_update_status').run();
      for (const row of rows) insert.run(resultToRow(row));
    });
    tx(results);
  } finally {
    db.close();
  }
}
