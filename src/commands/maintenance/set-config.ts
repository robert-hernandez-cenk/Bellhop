import {
  loadInventory,
  saveInventory,
  SettingsSchema,
  SETTINGS_KEYS,
  assignSetting,
  type Settings,
} from '../../lib/inventory.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';
import { effectiveValue } from '../../lib/config.ts';
import { logWarn } from '../../lib/log.ts';
import { SETTING_DEFS, type ConfigKey } from '../../lib/settings-defs.ts';

export interface SetConfigOptions {
  key: string;
  value?: string;
  unset?: boolean;
  apply?: boolean;
}

// The only writer of a single settings scalar. Validates against the same
// SettingsSchema the web UI's PATCH /api/settings route uses, so a real
// (non-empty) value rejected by one path is rejected identically by the
// other. The one deliberate divergence: an empty string here still goes
// through SettingsSchema and is rejected by its `.min(1)` (`--unset` is the
// only way to clear a value from the CLI), while the web route treats an
// empty string as "clear this field" -- the right behavior for a form
// text input, where leaving it blank should mean the same as never having
// set it.
export function runSetConfig(
  opts: SetConfigOptions,
  deps: { inventoryPath: string }
): { key: keyof Settings; value: string | undefined; applied: boolean } {
  if (!(SETTINGS_KEYS as string[]).includes(opts.key)) {
    throw new Error(`Unknown setting '${opts.key}' -- known settings: ${SETTINGS_KEYS.join(', ')}`);
  }
  const key = opts.key as keyof Settings;
  if (!opts.unset && opts.value === undefined) {
    throw new Error(`set-config ${key} requires a value (or --unset to clear it)`);
  }

  const value = opts.unset ? undefined : opts.value;
  if (value !== undefined) {
    const parsed = SettingsSchema.safeParse({ [key]: value });
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
    }
  }

  // Unlike the web Settings page, which refuses a key its environment
  // variable pins, the CLI stores it anyway (issue #64, research R9): this
  // shell's environment is not necessarily the web service's. It warns,
  // though, since in this process the stored value won't take effect.
  if (Object.hasOwn(SETTING_DEFS, key)) {
    const configKey = key as ConfigKey; // safe: the hasOwn check proves key is a SETTING_DEFS key
    if (effectiveValue(configKey, undefined, process.env).source === 'environment') {
      const { envVar } = SETTING_DEFS[configKey];
      logWarn(`${envVar} is set in this environment and overrides the stored ${key}`);
    }
  }

  const description = value === undefined ? `Would clear ${key}` : `Would set ${key} to ${value}`;
  const applied = confirmOrDryRun(description, opts.apply ?? false);
  if (applied) {
    // Assigned through a typed copy rather than a computed-key object
    // literal: a `{ ...inv, [key]: value }` spread with a union-typed key
    // widens to an index signature that no longer satisfies Inventory.
    const updated = { ...loadInventory(deps.inventoryPath) };
    assignSetting(updated, key, value);
    saveInventory(deps.inventoryPath, updated);
  }
  return { key, value, applied };
}
