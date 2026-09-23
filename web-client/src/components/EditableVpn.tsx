import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiPost } from '../api/client';
import type { GuestEntry } from '../api/types';

interface Props {
  guest: GuestEntry;
  guests: GuestEntry[];
}

// set-guest-vpn is a job (routing/DNS change + guest reboot), not a plain
// inventory PATCH like the other Editable* fields -- picking a value here
// navigates away to the job's live view rather than saving in place.
export function EditableVpn({ guest, guests }: Props) {
  const navigate = useNavigate();
  const [setting, setSetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every guest flagged vpnGateway is a candidate gateway to route through --
  // by name, not provider, so multiple gateways for the same provider (e.g.
  // 'nordvpn-us-gw-lxc' and 'nordvpn-eu-gw-lxc') both show up as distinct
  // options. A gateway can't route through itself or another gateway (see
  // set-guest-vpn.ts's own guard), so it's excluded here too.
  const gateways = guests.filter((g) => g.vpnGateway && g.name !== guest.name);

  const trigger = async (vpn: string) => {
    setSetting(true);
    setError(null);
    try {
      const res = await apiPost<{ jobId: number }>('/maintenance/set-guest-vpn', { guest: guest.name, vpn });
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSetting(false);
    }
  };

  return (
    <div>
      <select
        className="field-input"
        value={guest.vpn ?? ''}
        disabled={setting || guest.type !== 'lxc' || !!guest.vpnGateway}
        onChange={(e) => {
          const value = e.target.value;
          const vpn = value === '' ? 'none' : value;
          if (!confirm(`Change ${guest.name}'s VPN routing to ${value || 'none'}? This restarts the guest.`)) return;
          trigger(vpn);
        }}
      >
        <option value="">—</option>
        {/* guest.vpn can name a gateway that's since been deleted/renamed --
            gateways are now regular, deletable, renameable guests, unlike
            the old two-value enum this field used to be. Without this extra
            option, the controlled <select>'s value wouldn't match any
            <option> here and the browser would silently fall back to "—",
            misrepresenting a guest that's actually still routed through a
            (now-nonexistent) gateway per inventory data. */}
        {guest.vpn && !gateways.some((g) => g.name === guest.vpn) && (
          <option value={guest.vpn}>{guest.vpn} (missing)</option>
        )}
        {gateways.map((g) => (
          <option key={g.name} value={g.name}>
            {g.name}
          </option>
        ))}
      </select>
      {error && <div className="warning-banner">{error}</div>}
    </div>
  );
}
