import type { Settings } from './inventory.ts';
import { isSecretSettingKey, type SecretSettingKey } from './settings-defs.ts';

// The shared fix phrase every "<key> is not set" message ends with (issue
// #20 US2): each caller keeps its own lead-in ("<key> is not set --", plus
// any context like "-- skipping NFS mount discovery" or a trailing ", or
// pass --backup-storage"), but the actual remedy -- run set-config, or use
// the web UI's Settings page -- is spelled out once here so the two front
// ends can never drift out of sync (research.md R3).
//
// A secret (issue #64) takes no value hint: set-config reads it from stdin
// so it never lands in shell history or a process listing.
export function settingFix(key: keyof Settings, valueHint: string): string;
export function settingFix(key: SecretSettingKey): string;
export function settingFix(key: keyof Settings | SecretSettingKey, valueHint?: string): string {
  const args = isSecretSettingKey(key) ? `${key} --stdin` : `${key} ${valueHint}`;
  return `run: bellhop set-config ${args} --apply, or set it on the web UI's Settings page`;
}
