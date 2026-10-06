// npm run demo:seed -- <path> [--force]: writes the demo inventory
// (example-only data, see demo-inventory.ts) to a SQLite database on disk,
// for CLI work that needs a sample inventory file (issue #86). A real
// install creates its inventory through the first-run setup walkthrough.
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveInventory } from '../../src/lib/inventory.ts';
import { buildDemoInventory } from './demo-inventory.ts';

export function seedDemoDb(dbPath: string, opts: { force?: boolean } = {}): void {
  if (existsSync(dbPath)) {
    if (!opts.force) {
      throw new Error(`${dbPath} already exists -- pass --force to replace it`);
    }
    // Remove the file and its WAL sidecars rather than saving over it:
    // saveInventory replaces only the inventory tables, and a forced seed
    // should not keep another database's settings, secrets or permissions.
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  }
  saveInventory(dbPath, buildDemoInventory());
}

function main(argv: string[]): number {
  const force = argv.includes('--force');
  const paths = argv.filter((a) => a !== '--force');
  if (paths.length !== 1) {
    console.error('Usage: npm run demo:seed -- <path/to/bellhop.db> [--force]');
    return 1;
  }
  const dbPath = path.resolve(paths[0]);
  try {
    seedDemoDb(dbPath, { force });
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  console.log(`Wrote the demo inventory to ${dbPath}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
