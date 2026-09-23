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
