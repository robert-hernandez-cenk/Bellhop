import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { InventorySchema, validateInventory, saveInventory, type Inventory } from '../../lib/inventory.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';
import type { ProxyDriverId, TlsSource } from '../../lib/proxy/ids.ts';
import { convertLegacyTlsSettings, LEGACY_CADDY_TLS_VALUES } from '../../lib/proxy/legacy-tls.ts';

export interface ImportYamlInventoryOptions {
  yamlPath: string;
  dbPath: string;
  apply?: boolean;
}

// Issue #10 renamed these two entry keys with no alias. The schema strips
// unknown keys, so without this check an old hosts.yaml would import
// silently with its proxy host and hand-authored entries unmarked.
const RENAMED_ENTRY_KEYS = ['caddy', 'caddyManual'];

function rejectRenamedKeys(data: unknown): void {
  const inv = (data ?? {}) as { hosts?: unknown; guests?: unknown };
  const entries = [inv.hosts, inv.guests].flatMap((list) => (Array.isArray(list) ? list : []));
  const usesOldKey = entries.some(
    (entry) => entry !== null && typeof entry === 'object' && RENAMED_ENTRY_KEYS.some((key) => key in entry)
  );
  if (usesOldKey) {
    throw new Error(
      "hosts.yaml uses 'caddy'/'caddyManual', renamed to 'proxy'/'proxyManual' in #10 -- rename them in the file and re-run"
    );
  }
}

// Issue #72 replaced the Caddy-only proxyCaddyTls (and Traefik's reserved
// proxyCertResolver 'none') with tlsSource. The schema strips unknown keys,
// so an old hosts.yaml would lose its TLS choice silently; apply the same
// conversion the database open path applies, in place, before parsing.
//
// Unlike that path (which can't fail a load, so it just drops a value it
// doesn't know), a proxyCaddyTls that the old schema enum would have
// rejected -- a typo like 'letsencrpyt' -- fails the import here, so it is
// not silently deleted with the operator's TLS choice.
function convertLegacyTlsKeys(data: unknown): void {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return;
  const doc = data as Record<string, unknown>;
  if ('proxyCaddyTls' in doc && !LEGACY_CADDY_TLS_VALUES.includes(doc.proxyCaddyTls as string)) {
    throw new Error(
      `hosts.yaml has proxyCaddyTls '${String(doc.proxyCaddyTls)}', which is not one of: ${LEGACY_CADDY_TLS_VALUES.join(', ')} -- proxyCaddyTls was replaced by tlsSource in #72; fix the value (or set tlsSource instead) and re-run`
    );
  }
  const str = (key: string): string | undefined => (typeof doc[key] === 'string' ? (doc[key] as string) : undefined);
  const conversion = convertLegacyTlsSettings({
    proxyDriver: str('proxyDriver') as ProxyDriverId | undefined,
    proxyCaddyTls: str('proxyCaddyTls'),
    proxyCertResolver: str('proxyCertResolver'),
    tlsSource: str('tlsSource') as TlsSource | undefined,
  });
  if (conversion.tlsSource !== undefined) doc.tlsSource = conversion.tlsSource;
  for (const key of conversion.remove) delete doc[key];
}

// Standalone, one-time-use YAML parsing -- deliberately not exported from
// src/lib/inventory.ts (which no longer knows how to read YAML at all after
// the SQLite migration). This is the only place in the codebase that still
// parses inventory YAML, existing solely to migrate a pre-existing
// hosts.yaml into a fresh bellhop.db, once, manually.
function parseYamlInventoryFile(path: string): Inventory {
  const raw = readFileSync(path, 'utf8');
  const data: unknown = parseDocument(raw).toJS();
  rejectRenamedKeys(data);
  convertLegacyTlsKeys(data);
  const result = InventorySchema.safeParse(data);
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
