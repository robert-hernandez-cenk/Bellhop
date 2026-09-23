import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { InventorySchema, validateInventory, saveInventory, type Inventory } from '../../lib/inventory.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';

export interface ImportYamlInventoryOptions {
  yamlPath: string;
  dbPath: string;
  apply?: boolean;
}

// Standalone, one-time-use YAML parsing -- deliberately not exported from
// src/lib/inventory.ts (which no longer knows how to read YAML at all after
// the SQLite migration). This is the only place in the codebase that still
// parses inventory YAML, existing solely to migrate a pre-existing
// hosts.yaml into a fresh bellhop.db, once, manually.
function parseYamlInventoryFile(path: string): Inventory {
  const raw = readFileSync(path, 'utf8');
  const doc = parseDocument(raw);
  const result = InventorySchema.safeParse(doc.toJS());
  if (!result.success) {
    const messages = result.error.issues.map(
      (issue) => `Inventory validation: ${issue.path.join('.')}: ${issue.message}`
    );
    throw new Error(messages.join('\n'));
  }
  const errors = validateInventory(result.data);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  return result.data;
}

export async function runImportYamlInventory(
  opts: ImportYamlInventoryOptions
): Promise<{ inventory: Inventory; applied: boolean }> {
  const inventory = parseYamlInventoryFile(opts.yamlPath);
  const applied = confirmOrDryRun(
    `Would import ${inventory.hosts.length} host(s) and ${inventory.guests.length} guest(s) from ${opts.yamlPath} into ${opts.dbPath}`,
    opts.apply ?? false
  );
  if (applied) {
    saveInventory(opts.dbPath, inventory);
  }
  return { inventory, applied };
}
