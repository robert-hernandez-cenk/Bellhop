import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Shared open-a-better-sqlite3-connection helper -- inventory.ts,
// permissions.ts, and script-catalog.ts each opened `bellhop.db`
// (or, for permissions/script-catalog, that same file's own separate
// table set) the exact same way: mkdirSync the parent dir (skipped for
// ':memory:', which has no parent dir), open the connection, turn on WAL
// journaling and foreign keys, then run the caller's own CREATE TABLE IF
// NOT EXISTS schema. Pulled out once here rather than left as three
// verbatim copies. Ordering and pragmas are unchanged from the original
// three copies -- callers needing post-open migrations (inventory.ts's
// ensureColumn calls) still run those themselves, after this returns.
export function openDb(path: string, schema: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  return db;
}

// Adds a column an older database file lacks: CREATE TABLE IF NOT EXISTS is a
// no-op on an existing table, so a new column needs an ALTER TABLE. Cheap and
// idempotent (a PRAGMA read, then a skipped ALTER once the column exists), so
// callers run it on every open. Shared by inventory.ts, the job store and the
// web-login session store (#65 made that the third copy, so it moved here).
export function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
