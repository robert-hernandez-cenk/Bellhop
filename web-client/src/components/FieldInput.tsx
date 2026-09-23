import type { FieldDef, HostEntry, GuestEntry } from '../api/types';
import { DropdownWithCustom } from './DropdownWithCustom';
import { MidInput } from './MidInput';
import { SubdomainsInput } from './SubdomainsInput';
import { formatStorageSize } from '../lib/storage-size';

interface Props {
  field: FieldDef;
  value: string;
  onChange: (value: string) => void;
  hosts: HostEntry[];
  guests: GuestEntry[];
  values: Record<string, string>;
  hasGuestField: boolean;
}

export function FieldInput({ field, value, onChange, hosts, guests, values, hasGuestField }: Props) {
  switch (field.kind) {
    case 'select-host':
      // migrate-guest's Target Host deliberately still offers the guest's
      // own current host -- migrating a guest to a new mid/IP on the same
      // host (a renumber via the same backup/restore-under-a-new-vmid
      // mechanism) is a legitimate use of this command, not just a
      // cross-host move. runMigrateGuest only refuses when *both* the host
      // and the resolved vmid are unchanged (a genuine no-op), which the
      // mid field's own collision-avoiding default (see the mid-recompute
      // loop below) already steers clear of in the common case.
      return (
        <select className="field-input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>
            Select a host…
          </option>
          {hosts.map((h) => (
            <option key={h.name} value={h.name}>
              {h.name}
            </option>
          ))}
        </select>
      );
    case 'select-guest':
    case 'select-guest-lxc': {
      const filtered = field.kind === 'select-guest-lxc' ? guests.filter((g) => g.type === 'lxc') : guests;
      const sorted = [...filtered].sort((a, b) =>
        a.host !== b.host ? (a.host < b.host ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      );
      return (
        <select className="field-input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select a guest…</option>
          {sorted.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name} ({g.host})
            </option>
          ))}
        </select>
      );
    }
    case 'select-common':
      return <DropdownWithCustom options={field.options ?? []} value={value} onChange={onChange} />;
    case 'select-strict':
      return (
        <select className="field-input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>
            Select…
          </option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    case 'select-bridge': {
      const selectedHost = hosts.find((h) => h.name === values.host);
      const activeBridges = (selectedHost?.bridges ?? []).filter((b) => b.active !== false);
      return (
        <select className="field-input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>
            {selectedHost ? 'Select a bridge…' : 'Select a host first…'}
          </option>
          {activeBridges.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name} ({b.alias ?? 'LAN'})
            </option>
          ))}
        </select>
      );
    }
    case 'select-storage': {
      const selectedHost = hosts.find((h) => h.name === values[field.hostField ?? 'host']);
      const contentTypes = field.storageContentTypes ?? [];
      const candidates = (selectedHost?.storages ?? []).filter(
        (s) => s.active && contentTypes.some((ct) => s.content.includes(ct))
      );
      return (
        <select className="field-input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>
            {selectedHost ? 'Select a storage…' : 'Select a host first…'}
          </option>
          {candidates.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} ({formatStorageSize(s) ?? s.type})
            </option>
          ))}
        </select>
      );
    }
    case 'select-nfs-mount': {
      const selectedGuest = guests.find((g) => g.name === values.guest);
      const selectedHost = hosts.find((h) => h.name === (selectedGuest?.host ?? values.host));
      const candidates = Array.from(
        new Set([
          ...(selectedHost?.nfsMounts ?? []).filter((m) => m.active).map((m) => m.name),
          ...(selectedHost?.storages ?? []).filter((s) => s.active && s.type === 'nfs').map((s) => s.name),
        ])
      );
      return (
        <select className="field-input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>
            {!selectedHost
              ? hasGuestField
                ? 'Select a guest first…'
                : 'Select a host first…'
              : candidates.length === 0
                ? 'No NFS mounts found on this host'
                : 'Select a mount…'}
          </option>
          {candidates.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      );
    }
    case 'number':
      return (
        <input
          className="field-input"
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'mid':
      return (
        <MidInput
          value={value}
          onChange={onChange}
          host={hosts.find((h) => h.name === values[field.hostField ?? 'host'])}
          guests={guests}
        />
      );
    case 'subdomains':
      return <SubdomainsInput value={value} onChange={onChange} hosts={hosts} guests={guests} />;
    case 'checkbox':
      return (
        <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(String(e.target.checked))} />
      );
    case 'text':
      return <input className="field-input" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'secret':
      return (
        <input
          className="field-input"
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return null;
  }
}
