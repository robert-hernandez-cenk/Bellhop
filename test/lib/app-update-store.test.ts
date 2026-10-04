import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  loadAppUpdateResults,
  replaceAppUpdateResults,
  upsertAppUpdateResult,
  type AppUpdateResult,
} from '../../src/lib/app-update-store.ts';
import { saveInventory, type Inventory } from '../../src/lib/inventory.ts';

function tempDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'app-update-store-')), 'bellhop.db');
}

// Example values only (constitution Principle I): guest names like `media`,
// an app slug like `jellyfin`, and a demo owner/repo pair.
// Every field is listed explicitly, including the ones this result leaves
// unset as `undefined` -- node:assert/strict's deepEqual treats a key
// present with value `undefined` as different from an absent key, and
// loadAppUpdateResults always returns every field of AppUpdateResult.
const MEDIA: AppUpdateResult = {
  guest: 'media',
  app: 'jellyfin',
  status: 'update-available',
  installedVersion: '1.2.3',
  latestVersion: '1.3.0',
  repo: 'example-org/jellyfin',
  message: undefined,
  checkedAt: '2026-10-01T04:00:00.000Z',
};

const WEB: AppUpdateResult = {
  guest: 'web-lxc',
  app: 'plex',
  status: 'up-to-date',
  installedVersion: '2.0.0',
  latestVersion: '2.0.0',
  repo: 'example-org/plex',
  message: undefined,
  checkedAt: '2026-10-01T04:00:01.000Z',
};

const STOPPED: AppUpdateResult = {
  guest: 'archive-lxc',
  app: 'paperless',
  status: 'not-checked',
  installedVersion: undefined,
  latestVersion: undefined,
  repo: undefined,
  message: 'Guest is stopped',
  checkedAt: '2026-10-01T04:00:02.000Z',
};

test('loadAppUpdateResults returns an empty array when nothing has been stored', () => {
  assert.deepEqual(loadAppUpdateResults(tempDbPath()), []);
});

test('loadAppUpdateResults round-trips every field and orders by guest', () => {
  const dbPath = tempDbPath();
  replaceAppUpdateResults(dbPath, [WEB, MEDIA, STOPPED]);

  const loaded = loadAppUpdateResults(dbPath);

  assert.deepEqual(loaded.map((r) => r.guest), ['archive-lxc', 'media', 'web-lxc']);
  assert.deepEqual(loaded.find((r) => r.guest === 'media'), MEDIA);
  assert.deepEqual(loaded.find((r) => r.guest === 'web-lxc'), WEB);
  assert.deepEqual(loaded.find((r) => r.guest === 'archive-lxc'), STOPPED);
});

test('loadAppUpdateResults leaves optional fields undefined, not null, when absent', () => {
  const dbPath = tempDbPath();
  replaceAppUpdateResults(dbPath, [STOPPED]);

  const [loaded] = loadAppUpdateResults(dbPath);

  assert.equal(loaded.installedVersion, undefined);
  assert.equal(loaded.latestVersion, undefined);
  assert.equal(loaded.repo, undefined);
  assert.equal(loaded.message, 'Guest is stopped');
  assert.ok(!('installedVersion' in loaded) === false || loaded.installedVersion === undefined);
});

test('replaceAppUpdateResults deletes rows absent from the new set', () => {
  const dbPath = tempDbPath();
  replaceAppUpdateResults(dbPath, [MEDIA, WEB, STOPPED]);

  replaceAppUpdateResults(dbPath, [MEDIA]);

  assert.deepEqual(loadAppUpdateResults(dbPath).map((r) => r.guest), ['media']);
});

test('replaceAppUpdateResults runs as one transaction: an invalid row rolls back every row', () => {
  const dbPath = tempDbPath();
  replaceAppUpdateResults(dbPath, [MEDIA]);

  const bad = { ...WEB, status: 'bogus' } as unknown as AppUpdateResult;
  assert.throws(() => replaceAppUpdateResults(dbPath, [bad]));

  // The failed replace must not have deleted MEDIA's row either.
  assert.deepEqual(loadAppUpdateResults(dbPath).map((r) => r.guest), ['media']);
});

test('upsertAppUpdateResult inserts a new row', () => {
  const dbPath = tempDbPath();
  upsertAppUpdateResult(dbPath, MEDIA);

  assert.deepEqual(loadAppUpdateResults(dbPath), [MEDIA]);
});

test('upsertAppUpdateResult replaces one row, leaving every other guest alone', () => {
  const dbPath = tempDbPath();
  replaceAppUpdateResults(dbPath, [MEDIA, WEB]);

  const updatedMedia: AppUpdateResult = {
    ...MEDIA,
    status: 'up-to-date',
    installedVersion: '1.3.0',
    checkedAt: '2026-10-02T04:00:00.000Z',
  };
  upsertAppUpdateResult(dbPath, updatedMedia);

  const loaded = loadAppUpdateResults(dbPath);
  assert.deepEqual(loaded.find((r) => r.guest === 'media'), updatedMedia);
  assert.deepEqual(loaded.find((r) => r.guest === 'web-lxc'), WEB);
  assert.equal(loaded.length, 2);
});

test('upsertAppUpdateResult clears a previously-set optional field back to undefined', () => {
  const dbPath = tempDbPath();
  upsertAppUpdateResult(dbPath, MEDIA);

  const cleared: AppUpdateResult = {
    guest: 'media',
    app: 'jellyfin',
    status: 'error',
    installedVersion: undefined,
    latestVersion: undefined,
    repo: undefined,
    message: 'boom',
    checkedAt: MEDIA.checkedAt,
  };
  upsertAppUpdateResult(dbPath, cleared);

  const [loaded] = loadAppUpdateResults(dbPath);
  assert.deepEqual(loaded, cleared);
});

test('the status CHECK constraint rejects a value outside the five allowed outcomes', () => {
  const dbPath = tempDbPath();
  const bad = { ...MEDIA, status: 'bogus' } as unknown as AppUpdateResult;

  assert.throws(() => upsertAppUpdateResult(dbPath, bad), /CHECK constraint failed/);
});

test('saveInventory on the same file leaves the app_update_status table intact', () => {
  const dbPath = tempDbPath();
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
    guests: [{ name: 'media', type: 'lxc', vmid: 105, host: 'pve1' }],
  };
  replaceAppUpdateResults(dbPath, [MEDIA]);

  saveInventory(dbPath, inventory);

  assert.deepEqual(loadAppUpdateResults(dbPath), [MEDIA]);
});

test('each write opens and closes its own connection, like script-catalog.ts', () => {
  const dbPath = tempDbPath();
  upsertAppUpdateResult(dbPath, MEDIA);

  // A plain better-sqlite3 open on the same file must not be blocked by a
  // lingering handle left open from the call above.
  const db = new Database(dbPath);
  try {
    const row = db.prepare('SELECT guest FROM app_update_status').get() as { guest: string };
    assert.equal(row.guest, 'media');
  } finally {
    db.close();
  }
});
