import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { invalidateConfigSnapshot, SECRET_SETTINGS_TABLE_SQL, useConfigStore } from './config.ts';
import { logInfo, logWarn } from './log.ts';
import { openDb } from './sqlite.ts';
import { isSecretSettingKey, SETTING_DEFS, settingSchema, type ConfigKey, type EnvFile } from './settings-defs.ts';

// The one-time import of the data/*.env files into the settings store
// (issue #64, research R7). Each entry point runs it at startup, after its
// dotenv loads and before registering the store, so an existing deployment's
// file values become stored settings the first time the new code starts --
// after which the files are only an override, the same as any other
// environment variable, and can be deleted.
//
// The files are read with dotenv.parse, never through process.env: a real
// environment variable is an override, not something to persist. Nothing
// stored is ever overwritten (a later run therefore imports nothing), the
// files themselves are never touched, and no log line or skip reason ever
// carries a value -- several of these are secrets.

export interface ImportedSetting {
  key: ConfigKey;
  variable: string;
  file: EnvFile;
}

export interface SkippedSetting extends ImportedSetting {
  reason: string;
}

export interface ImportResult {
  imported: ImportedSetting[];
  skipped: SkippedSetting[];
}

// Only the tables this writes to: an existing inventory database already has
// both (openInventoryDb creates them), and opening it through
// openInventoryDb would run its migrations, which read settings this import
// may not have stored yet.
const IMPORT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  ${SECRET_SETTINGS_TABLE_SQL}
`;

export function importEnvFiles(inventoryPath: string, dataDir: string): ImportResult {
  const result: ImportResult = { imported: [], skipped: [] };
  // Before the database exists (a fresh clone, or import-yaml-inventory
  // about to create it) there is nowhere to import to, and creating the
  // file here would be a surprising side effect.
  if (!existsSync(inventoryPath)) return result;

  // Every candidate first, so a run with nothing to import never opens the
  // database for writing.
  const candidates: Array<ImportedSetting & { value: string }> = [];
  const parsed = new Map<EnvFile, Record<string, string>>();
  for (const [key, def] of Object.entries(SETTING_DEFS) as [ConfigKey, (typeof SETTING_DEFS)[ConfigKey]][]) {
    if (!def.envFile) continue;
    let vars = parsed.get(def.envFile);
    if (!vars) {
      const file = path.join(dataDir, def.envFile);
      vars = existsSync(file) ? dotenv.parse(readFileSync(file)) : {};
      parsed.set(def.envFile, vars);
    }
    const value = vars[def.envVar];
    if (value === undefined || value === '') continue;
    candidates.push({ key, variable: def.envVar, file: def.envFile, value });
  }
  if (candidates.length === 0) return result;

  const db = openDb(inventoryPath, IMPORT_SCHEMA);
  try {
    // The stored value itself, not configValueAt: the accessor would report
    // the environment override (which the dotenv loads just set from these
    // same files) and hide that nothing is stored yet.
    const storedMeta = db.prepare('SELECT 1 FROM meta WHERE key = ?');
    const storedSecret = db.prepare('SELECT 1 FROM secret_settings WHERE key = ?');
    // DO NOTHING rather than an upsert, so even a value written by another
    // process between the check above and this insert is never overwritten.
    const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
    const insertSecret = db.prepare('INSERT INTO secret_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');

    for (const { key, variable, file, value } of candidates) {
      const secret = isSecretSettingKey(key);
      if ((secret ? storedSecret : storedMeta).get(key)) continue;
      // Validated first: a stored invalid value would make loadInventory
      // (or the accessor) fail on every later read. The reason is the
      // schema's own fixed message text, which never echoes the input.
      const check = settingSchema(key).safeParse(value);
      if (!check.success) {
        const issues = check.error.issues.map((issue) => issue.message).join('; ');
        const reason = `setting '${key}' not imported: ${variable} in data/${file} is invalid (${issues})`;
        logWarn(`Skipped ${variable} from data/${file}: ${reason}`);
        result.skipped.push({ key, variable, file, reason });
        continue;
      }
      (secret ? insertSecret : insertMeta).run(key, value);
      logInfo(`Imported ${variable} from data/${file} as setting ${key}`);
      result.imported.push({ key, variable, file });
    }
  } finally {
    db.close();
    invalidateConfigSnapshot();
  }
  return result;
}

// What each entry point (CLI, web service, MCP server, Windows service
// script) runs at startup: the import, then registering the store. A failed
// import only warns -- the files were just loaded into the environment, so
// every value they hold is still in effect as an override, and a command
// like import-yaml-inventory (creating a fresh database) must still run. The
// message comes from SQLite or the filesystem, never from a file's values.
export function importEnvFilesAndUseStore(inventoryPath: string, dataDir: string): void {
  try {
    importEnvFiles(inventoryPath, dataDir);
  } catch (error) {
    logWarn(`Could not import data/*.env settings: ${error instanceof Error ? error.message : String(error)}`);
  }
  useConfigStore(inventoryPath);
}
