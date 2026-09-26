import { SETTINGS_KEYS } from './inventory.ts';

export type SettingKey = (typeof SETTINGS_KEYS)[number];

// The shared fix phrase every "<key> is not set" message ends with (issue
// #20 US2): each caller keeps its own lead-in ("<key> is not set --", plus
// any context like "-- skipping NFS mount discovery" or a trailing ", or
// pass --backup-storage"), but the actual remedy -- run set-config, or use
// the web UI's Settings page -- is spelled out once here so the two front
// ends can never drift out of sync (research.md R3).
export function settingFix(key: SettingKey, valueHint: string): string {
  return `run: bellhop set-config ${key} ${valueHint} --apply, or set it on the web UI's Settings page`;
}
