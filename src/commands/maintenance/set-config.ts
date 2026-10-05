import {
  loadInventory,
  saveInventory,
  SettingsSchema,
  SETTINGS_KEYS,
  assignSetting,
  type Settings,
} from '../../lib/inventory.ts';
import { confirmOrDryRun } from '../../lib/dry-run.ts';
import { clearSecret, effectiveValue, writeSecret } from '../../lib/config.ts';
import { logWarn } from '../../lib/log.ts';
import {
  SECRET_SETTINGS_KEYS,
  SETTING_DEFS,
  isSecretSettingKey,
  settingSchema,
  type ConfigKey,
  type SecretSettingKey,
} from '../../lib/settings-defs.ts';

// The warning for a key this shell's environment pins (see the comment at
// the call site in runSetConfig). Shared with configure-web-login so both
// commands say exactly the same thing.
export function warnIfEnvPinned(key: string): void {
  if (!Object.hasOwn(SETTING_DEFS, key)) return;
  const configKey = key as ConfigKey; // safe: the hasOwn check proves key is a SETTING_DEFS key
  if (effectiveValue(configKey, undefined, process.env).source === 'environment') {
    const { envVar } = SETTING_DEFS[configKey];
    logWarn(`${envVar} is set in this environment and overrides the stored ${key}`);
  }
}

export interface SetConfigOptions {
  key: string;
  value?: string;
  unset?: boolean;
  apply?: boolean;
}

// What a caller may print. A secret's value is deliberately absent (issue
// #64): `value` is only ever a non-secret's, so no caller can log a secret
// by printing the result.
export interface SetConfigResult {
  key: keyof Settings | SecretSettingKey;
  value: string | undefined;
  secret: boolean;
  cleared: boolean;
  applied: boolean;
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
//
// A secret key (issue #64) is written to the secret_settings table instead,
// and no line this function logs, and nothing it returns or throws, ever
// contains the value. How the value got here -- standard input or a no-echo
// prompt, never an argument -- is the CLI layer's job (resolveSetConfigValue).
export function runSetConfig(opts: SetConfigOptions, deps: { inventoryPath: string }): SetConfigResult {
  const secret = isSecretSettingKey(opts.key);
  if (!secret && !(SETTINGS_KEYS as string[]).includes(opts.key)) {
    throw new Error(
      `Unknown setting '${opts.key}' -- known settings: ${[...SETTINGS_KEYS, ...SECRET_SETTINGS_KEYS].join(', ')}`
    );
  }
  const key = opts.key as keyof Settings | SecretSettingKey; // safe: checked against both key lists above
  if (!opts.unset && opts.value === undefined) {
    throw new Error(`set-config ${key} requires a value (or --unset to clear it)`);
  }

  const value = opts.unset ? undefined : opts.value;
  if (value !== undefined) {
    // Either schema's issue messages are fixed text, so the error names the
    // key and never echoes the value.
    const parsed = secret
      ? settingSchema(key as SecretSettingKey).safeParse(value)
      : SettingsSchema.safeParse({ [key]: value });
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${secret ? key : i.path.join('.')}: ${i.message}`).join('\n'));
    }
  }

  // Unlike the web Settings page, which refuses a key its environment
  // variable pins, the CLI stores it anyway (issue #64, research R9): this
  // shell's environment is not necessarily the web service's. It warns,
  // though, since in this process the stored value won't take effect.
  warnIfEnvPinned(key);

  const description =
    value === undefined ? `Would clear ${key}` : secret ? `Would set ${key} (value hidden)` : `Would set ${key} to ${value}`;
  const applied = confirmOrDryRun(description, opts.apply ?? false);
  if (applied) {
    if (secret) {
      const secretKey = key as SecretSettingKey; // safe: `secret` is isSecretSettingKey(key)
      if (value === undefined) clearSecret(deps.inventoryPath, secretKey);
      else writeSecret(deps.inventoryPath, secretKey, value);
    } else {
      // Assigned through a typed copy rather than a computed-key object
      // literal: a `{ ...inv, [key]: value }` spread with a union-typed key
      // widens to an index signature that no longer satisfies Inventory.
      const updated = { ...loadInventory(deps.inventoryPath) };
      assignSetting(updated, key as keyof Settings, value); // safe: not a secret, so a SETTINGS_KEYS key
      saveInventory(deps.inventoryPath, updated);
    }
  }
  return { key, value: secret ? undefined : value, secret, cleared: value === undefined, applied };
}

// Where the CLI reads a value from when it isn't an argument -- injected so
// tests never touch the real standard input.
export interface SetConfigInput {
  isTTY: boolean;
  readStdin: () => Promise<string>;
  // Must not echo what is typed (see promptHidden in src/lib/secret-input.ts).
  prompt: (question: string) => Promise<string>;
}

// The CLI's input step (contracts/cli.md): a secret never comes from an
// argument, which would leave it in shell history and the process list, so
// it is read from standard input (--stdin) or a no-echo prompt on a
// terminal. --stdin works for a non-secret too. Returns undefined when
// there is nothing to read (--unset, or a non-secret given no value, which
// runSetConfig then refuses with its own message).
export async function resolveSetConfigValue(
  opts: { key: string; value?: string; stdin?: boolean; unset?: boolean },
  input: SetConfigInput
): Promise<string | undefined> {
  const secret = isSecretSettingKey(opts.key);
  // Checked before --unset returns: a secret typed as an argument is
  // already in shell history and the process list, --unset or not, so it
  // is refused rather than silently ignored.
  if (secret && opts.value !== undefined) {
    throw new Error(
      `${opts.key} is a secret -- pass it on standard input with --stdin (or omit the value to be prompted), never as an argument`
    );
  }
  if (opts.unset) return undefined;
  if (opts.stdin) {
    if (opts.value !== undefined) throw new Error(`set-config ${opts.key}: pass either a value or --stdin, not both`);
    // Exactly one trailing newline -- what `echo` or a here-string adds --
    // is stripped; anything else is part of the value.
    const value = (await input.readStdin()).replace(/\r?\n$/, '');
    if (value === '') throw new Error(`${opts.key}: no value on standard input -- use --unset to clear it`);
    return value;
  }
  if (!secret) return opts.value;
  if (!input.isTTY) {
    throw new Error(`${opts.key} is a secret and standard input is not a terminal -- pass the value with --stdin`);
  }
  const value = await input.prompt(`Value for ${opts.key}: `);
  if (value === '') throw new Error(`${opts.key}: no value entered -- use --unset to clear it`);
  return value;
}
