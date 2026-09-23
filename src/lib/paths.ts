import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared by src/cli.ts, src/web/server.ts, and scripts/windows-service.ts.
// None of those can import each other -- src/cli.ts calls
// program.parseAsync at module scope, so importing it runs the CLI -- and
// the first two had already drifted into duplicating these definitions.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function inventoryPath(): string {
  return process.env.INVENTORY_FILE ?? path.join(REPO_ROOT, 'inventory', 'bellhop.db');
}

// Where the web UI keeps its job history DB, job logs, and the gitignored
// authentik.env file. Lives here rather than in its own module so all three
// path resolvers share one REPO_ROOT -- issue #123 removed five hand-copied
// constants and must not reintroduce the duplication issue #124 extracted
// this file to kill.
export function dataDir(): string {
  return process.env.WEB_DATA_DIR ?? path.join(REPO_ROOT, 'data');
}
