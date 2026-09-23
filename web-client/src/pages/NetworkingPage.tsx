import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../api/client';
import type { GuestEntry } from '../api/types';
import { PageDescription } from '../components/PageDescription';
import { GatewayCard } from '../components/GatewayCard';

export function NetworkingPage() {
  const [gateways, setGateways] = useState<GuestEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ guests: GuestEntry[] }>('/inventory')
      .then((data) => {
        setGateways(data.guests.filter((g) => g.vpnGateway));
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h2>Networking</h2>
      <PageDescription>
        Live status for each VPN gateway (NordVPN/PIA) in inventory — switch its exit country here, or route a
        guest through it from the Dashboard's Guests table.
      </PageDescription>
      {error && <div className="warning-banner">{error}</div>}
      {!error && !loading && gateways.length === 0 && (
        <p className="page-description">
          No VPN gateways in inventory yet — <Link to="/provisioning/deploy-vpn-gateway">deploy one from Provisioning</Link>.
        </p>
      )}
      {gateways.length > 0 && (
        <div className="gateway-cards">
          {gateways.map((g) => (
            <GatewayCard key={g.name} gateway={g} />
          ))}
        </div>
      )}
    </div>
  );
}
