import { useState } from 'react';
import type { HostEntry, GuestEntry } from '../api/types';

interface Props {
  value: string;
  onChange: (value: string) => void;
  hosts: HostEntry[];
  guests: GuestEntry[];
  // Editing an *existing* entry's own subdomains (the Dashboard case) means
  // its current subdomains shouldn't flag as conflicts against itself.
  excludeName?: string;
  // Fires on blur only when there are no conflicts, with the parsed list --
  // lets a caller (EditableSubdomains) persist the change without
  // duplicating the parse/conflict logic.
  onBlurValid?: (parsed: string[]) => void;
  className?: string;
}

export function parseSubdomains(raw: string): string[] {
  return Array.from(new Set(raw.split(';').map((s) => s.trim()).filter(Boolean)));
}

// Mirrors the inventory's own source-of-truth for Caddy routing (its
// subdomains assignments, which is exactly what sync-caddy turns into the
// Caddyfile) -- checked entirely client-side against the already-loaded
// hosts/guests, no round trip, same as MidInput's collision check.
export function findConflicts(
  subdomains: string[],
  hosts: HostEntry[],
  guests: GuestEntry[],
  excludeName?: string
): string[] {
  const owners = new Map<string, string>();
  for (const entry of [...hosts, ...guests]) {
    if (entry.name === excludeName) continue;
    for (const s of entry.subdomains ?? []) {
      owners.set(s.toLowerCase(), entry.name);
    }
  }
  const conflicts: string[] = [];
  for (const s of subdomains) {
    const owner = owners.get(s.toLowerCase());
    if (owner) conflicts.push(`'${s}' is already used by ${owner}`);
  }
  return conflicts;
}

export function SubdomainsInput({ value, onChange, hosts, guests, excludeName, onBlurValid, className }: Props) {
  const [warnings, setWarnings] = useState<string[]>([]);

  const checkConflicts = () => {
    const parsed = parseSubdomains(value);
    const conflicts = findConflicts(parsed, hosts, guests, excludeName);
    setWarnings(conflicts);
    if (conflicts.length === 0) onBlurValid?.(parsed);
  };

  return (
    <>
      <input
        className={className ?? 'field-input'}
        value={value}
        placeholder="e.g. tv;downloads"
        onChange={(e) => {
          onChange(e.target.value);
          setWarnings([]);
        }}
        onBlur={checkConflicts}
      />
      {warnings.length > 0 && (
        <div className="warning-banner">
          {warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}
    </>
  );
}
