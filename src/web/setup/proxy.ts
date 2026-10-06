import { z } from 'zod';
import {
  SettingsSchema,
  findProxyEntry,
  loadInventory,
  refreshInventory,
  saveInventory,
  type Inventory,
  type Settings,
} from '../../lib/inventory.ts';
import { configValueAt } from '../../lib/config.ts';
import { writeSecret } from '../../lib/config.ts';
import { SETTING_DEFS, settingSchema, type ConfigKey, type SecretSettingKey } from '../../lib/settings-defs.ts';
import { DEFAULT_PROXY_DRIVER_ID, PROXY_DRIVER_IDS } from '../../lib/proxy/ids.ts';
import { listDrivers } from '../../lib/proxy/index.ts';
import { managesProxy, type ReverseProxyDriver } from '../../lib/proxy/driver.ts';
import { ACME_DNS_PROVIDERS, DEFAULT_ACME_DNS_PROVIDER } from '../../lib/proxy/ids.ts';
import { envPinnedError, proxyDriversInfo } from '../routes/settings.ts';
import { SetupActionError } from './proxmox.ts';
import type { SetupService } from './service.ts';

// Step 3 of the first-run walkthrough (issue #87, contracts/http-setup-proxy.md):
// choose the proxy driver and the inventory entry it runs on, and set the
// driver's settings. Nothing here reaches the proxy; the check lives beside
// it (checkProxy) and is read-only too.

// Body field -> the setting it saves (the names the walkthrough's form uses,
// kept short; the settings keep their own names).
const SETTING_FIELDS = {
  configPath: 'proxyConfigPath',
  certResolver: 'proxyCertResolver',
  apiUrl: 'proxyApiUrl',
  npmApiUrl: 'npmApiUrl',
  npmApiEmail: 'npmApiEmail',
} as const satisfies Record<string, keyof Settings>;
type SettingField = keyof typeof SETTING_FIELDS;

const SECRET_FIELDS = ['npmApiPassword'] as const satisfies readonly SecretSettingKey[];

export const ProxyChoiceSchema = z
  .object({
    driver: z.enum(PROXY_DRIVER_IDS),
    entry: z.string().optional(),
    configPath: z.string().optional(),
    certResolver: z.string().optional(),
    apiUrl: z.string().optional(),
    npmApiUrl: z.string().optional(),
    npmApiEmail: z.string().optional(),
    secrets: z.object({ npmApiPassword: z.string().optional() }).strict().optional(),
  })
  .strict();
export type ProxyChoiceBody = z.infer<typeof ProxyChoiceSchema>;

export interface ProxyChoice {
  driver: string;
  entry?: string;
  configPath: string;
  certResolver: string;
  apiUrl: string;
  npmApiUrl: string;
  npmApiEmail: string;
}

export interface ProxyEntry {
  name: string;
  kind: 'host' | 'guest';
  parent?: string;
  ip?: string;
}

export interface ProxyStepState {
  drivers: ReturnType<typeof proxyDriversInfo>;
  defaultDriver: string;
  acmeDnsProviders: string[];
  defaultAcmeDnsProvider: string;
  entries: ProxyEntry[];
  choice: ProxyChoice;
  secrets: Record<(typeof SECRET_FIELDS)[number], boolean>;
  pinned: { key: string; variable: string }[];
  complete: boolean;
}

function opts(setup: SetupService) {
  if (!setup.opts) throw new Error('Setup is not in progress');
  return setup.opts;
}

function driverFor(id: string): ReverseProxyDriver {
  const driver = listDrivers().find((d) => d.id === id);
  if (!driver) throw new SetupActionError(`driver: unknown proxy driver "${id}"`, 400);
  return driver;
}

// The fields a driver reads; anything else in a request is ignored rather
// than saved, so switching drivers never stores a setting nothing will use.
function usedFields(driver: ReverseProxyDriver): SettingField[] {
  if (!managesProxy(driver)) return [];
  const fields: SettingField[] = [];
  if (driver.defaultConfigPath !== null) fields.push('configPath');
  if (driver.usesCertResolver) fields.push('certResolver');
  if (driver.usesApiUrl) fields.push('apiUrl');
  if (driver.usesNpmApi) fields.push('npmApiUrl', 'npmApiEmail');
  return fields;
}

function usedSecrets(driver: ReverseProxyDriver): (typeof SECRET_FIELDS)[number][] {
  return managesProxy(driver) && driver.usesNpmApi ? ['npmApiPassword'] : [];
}

function entriesOf(inventory: Inventory): ProxyEntry[] {
  return [
    ...inventory.hosts.map((h): ProxyEntry => ({ name: h.name, kind: 'host', ip: h.ssh_target })),
    ...inventory.guests.map((g): ProxyEntry => ({ name: g.name, kind: 'guest', parent: g.host, ...(g.ip ? { ip: g.ip } : {}) })),
  ];
}

export function currentChoice(inventory: Inventory): ProxyChoice {
  const entry = findProxyEntry(inventory)?.name;
  return {
    driver: inventory.proxyDriver ?? DEFAULT_PROXY_DRIVER_ID,
    ...(entry ? { entry } : {}),
    configPath: inventory.proxyConfigPath ?? '',
    certResolver: inventory.proxyCertResolver ?? '',
    apiUrl: inventory.proxyApiUrl ?? '',
    npmApiUrl: inventory.npmApiUrl ?? '',
    npmApiEmail: inventory.npmApiEmail ?? '',
  };
}

// A secret counts as set when any source has it (stored or environment);
// only the fact is ever reported.
function secretIsSet(inventoryPath: string, key: SecretSettingKey): boolean {
  try {
    return configValueAt(inventoryPath, key).source !== 'none';
  } catch {
    return true; // a stored value that no longer validates is still stored
  }
}

function isPinned(inventoryPath: string, key: ConfigKey): boolean {
  try {
    return configValueAt(inventoryPath, key).source === 'environment';
  } catch {
    return false;
  }
}

const PIN_CHECKED_KEYS: ConfigKey[] = [...Object.values(SETTING_FIELDS).filter((k) => Object.hasOwn(SETTING_DEFS, k)) as ConfigKey[], ...SECRET_FIELDS];

export function proxyStepState(setup: SetupService): ProxyStepState {
  const { inventory, inventoryPath } = opts(setup);
  return {
    drivers: proxyDriversInfo(),
    defaultDriver: DEFAULT_PROXY_DRIVER_ID,
    acmeDnsProviders: [...ACME_DNS_PROVIDERS],
    defaultAcmeDnsProvider: DEFAULT_ACME_DNS_PROVIDER,
    entries: entriesOf(inventory),
    choice: currentChoice(inventory),
    secrets: Object.fromEntries(SECRET_FIELDS.map((k) => [k, secretIsSet(inventoryPath, k)])) as ProxyStepState['secrets'],
    pinned: PIN_CHECKED_KEYS.filter((k) => isPinned(inventoryPath, k)).map((key) => ({
      key,
      variable: SETTING_DEFS[key].envVar,
    })),
    complete: setup.state().completedSteps.includes('proxy'),
  };
}

function issueText(prefix: string, error: z.ZodError): string {
  return error.issues.map((i) => `${prefix}: ${i.message}`).join('\n');
}

// Saves the choice. Everything is validated before anything is written, so
// a refused request changes nothing; a change drops the step's completion
// (it must be proven again), and "No proxy" completes it at once.
export function saveProxyChoice(setup: SetupService, body: ProxyChoiceBody): ProxyStepState {
  const { inventory, inventoryPath } = opts(setup);
  const driver = driverFor(body.driver);
  const manages = managesProxy(driver);
  const onDisk = loadInventory(inventoryPath);

  if (manages) {
    if (body.entry === undefined || body.entry === '') throw new SetupActionError('entry: is required', 400);
    const known = entriesOf(onDisk).some((e) => e.name === body.entry);
    if (!known) throw new SetupActionError(`entry: no host or guest named "${body.entry}" in the inventory`, 400);
  }

  const updates: Partial<Settings> = { proxyDriver: driver.id };
  for (const field of usedFields(driver)) {
    const raw = body[field];
    if (raw === undefined) continue;
    const key = SETTING_FIELDS[field];
    if (raw.trim() === '') {
      updates[key] = undefined;
      continue;
    }
    const parsed = SettingsSchema.safeParse({ [key]: raw.trim() });
    if (!parsed.success) throw new SetupActionError(issueText(field, parsed.error), 400);
    (updates as Record<string, string>)[key] = raw.trim();
  }

  const secretValues = new Map<SecretSettingKey, string>();
  for (const key of usedSecrets(driver)) {
    const raw = body.secrets?.[key];
    if (raw === undefined || raw === '') continue;
    const parsed = settingSchema(key).safeParse(raw);
    if (!parsed.success) throw new SetupActionError(issueText(key, parsed.error), 400);
    secretValues.set(key, raw);
  }

  for (const key of [...Object.values(SETTING_FIELDS), ...secretValues.keys()]) {
    const touched = key in updates || secretValues.has(key as SecretSettingKey);
    if (touched && Object.hasOwn(SETTING_DEFS, key) && isPinned(inventoryPath, key as ConfigKey)) {
      throw new SetupActionError(envPinnedError(key as ConfigKey), 400);
    }
  }

  const proxyName = manages ? body.entry! : undefined; // safe: required above when the driver manages a proxy
  const updated: Inventory = {
    ...onDisk,
    ...updates,
    hosts: onDisk.hosts.map((h) => withProxyFlag(h, proxyName)),
    guests: onDisk.guests.map((g) => withProxyFlag(g, proxyName)),
  };
  // Under "No proxy" an existing flag is left alone (nothing manages it).
  if (!manages) {
    updated.hosts = onDisk.hosts;
    updated.guests = onDisk.guests;
  }

  const before = JSON.stringify(currentChoice(onDisk));
  const after = JSON.stringify(currentChoice(updated));
  const changed = before !== after || secretValues.size > 0;

  try {
    if (before !== after) saveInventory(inventoryPath, updated);
    for (const [key, value] of secretValues) writeSecret(inventoryPath, key, value);
  } catch (err) {
    throw new SetupActionError((err as Error).message, 400);
  }
  refreshInventory(inventory, inventoryPath);

  if (!manages) setup.completeStep('proxy');
  else if (changed) setup.uncompleteStep('proxy');
  return proxyStepState(setup);
}

function withProxyFlag<T extends { name: string; proxy?: boolean }>(entry: T, chosen: string | undefined): T {
  if (entry.name === chosen) return { ...entry, proxy: true };
  if (!entry.proxy) return entry;
  const { proxy: _dropped, ...rest } = entry;
  return rest as T;
}
