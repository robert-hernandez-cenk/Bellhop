import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../api/client';
import type { GuestEntry, GatewayStatus, GatewayCountry, GatewayCity, GatewayGroup } from '../api/types';

const POLL_INTERVAL_MS = 10000;

export function formatCityStatus(status: GatewayStatus): { text: string; warning: boolean } | null {
  const requested = status.city || '';
  const resolved = status.resolvedCity || '';
  if (!requested && !resolved) return null;
  if (!resolved) return { text: `${requested} (unconfirmed)`, warning: false };
  if (!requested) return { text: `${resolved} (auto)`, warning: false };
  if (requested.trim().toLowerCase() === resolved.trim().toLowerCase()) return { text: requested, warning: false };
  return { text: `${resolved} (${requested} requested)`, warning: true };
}

export function formatCountryStatus(status: GatewayStatus): { text: string; warning: boolean } | null {
  const requested = status.country || '';
  const resolved = status.resolvedCountry || '';
  if (!requested && !resolved) return null;
  if (!resolved) return { text: `${requested} (unconfirmed)`, warning: false };
  if (!requested) return { text: `${resolved} (auto)`, warning: false };
  if (requested.trim().toLowerCase() === resolved.trim().toLowerCase()) return { text: requested, warning: false };
  return { text: `${resolved} (${requested} requested)`, warning: true };
}

export function GatewayCard({ gateway }: { gateway: GuestEntry }) {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const cityStatus = status ? formatCityStatus(status) : null;
  const countryStatus = status ? formatCountryStatus(status) : null;
  const [statusError, setStatusError] = useState<string | null>(null);
  const [countries, setCountries] = useState<GatewayCountry[]>([]);
  const [countriesError, setCountriesError] = useState<string | null>(null);
  const [selectedCountry, setSelectedCountry] = useState('');
  const [cities, setCities] = useState<GatewayCity[]>([]);
  const [citiesError, setCitiesError] = useState<string | null>(null);
  const [selectedCity, setSelectedCity] = useState('');
  const [groups, setGroups] = useState<GatewayGroup[]>([]);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState('');
  const isNordVpn = gateway.vpnGateway === 'nordvpn';
  const [connecting, setConnecting] = useState(false);
  const loadingRef = useRef(false);

  const loadStatus = () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    apiGet<GatewayStatus>(`/networking/gateways/${gateway.name}/status`)
      .then((data) => {
        setStatus(data);
        setStatusError(null);
      })
      .catch((err) => setStatusError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        loadingRef.current = false;
      });
  };

  const loadCountries = () => {
    setCountriesError(null);
    apiGet<GatewayCountry[]>(`/networking/gateways/${gateway.name}/servers`)
      .then((data) => setCountries(Array.isArray(data) ? data : []))
      .catch((err) => setCountriesError(err instanceof Error ? err.message : String(err)));
  };

  const loadGroups = () => {
    if (!isNordVpn) return;
    setGroupsError(null);
    apiGet<GatewayGroup[]>(`/networking/gateways/${gateway.name}/groups`)
      .then((data) => setGroups(Array.isArray(data) ? data : []))
      .catch((err) => setGroupsError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    loadStatus();
    loadCountries();
    loadGroups();
    const interval = setInterval(loadStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // loadStatus/loadCountries/loadGroups are intentionally omitted from deps
    // -- each closes over gateway.name/isNordVpn, which are already the
    // effect's own dependencies, and redefining them every render would
    // otherwise restart the interval on every poll tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway.name, isNordVpn]);

  const loadCities = () => {
    if (!isNordVpn || !selectedCountry) {
      setCities([]);
      setCitiesError(null);
      return;
    }
    setCitiesError(null);
    apiGet<GatewayCity[]>(`/networking/gateways/${gateway.name}/cities?country=${encodeURIComponent(selectedCountry)}`)
      .then((data) => setCities(Array.isArray(data) ? data : []))
      .catch((err) => setCitiesError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    setSelectedCity('');
    loadCities();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway.name, isNordVpn, selectedCountry]);

  const connect = async () => {
    setConnecting(true);
    setStatusError(null);
    try {
      await apiPost(`/networking/gateways/${gateway.name}/connect`, {
        country: selectedCountry,
        city: selectedCity,
        group: selectedGroup,
      });
      loadStatus();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="gateway-card">
      <h3>{gateway.name}</h3>
      <div className="page-description">
        {gateway.vpnGateway === 'nordvpn' ? 'NordVPN' : 'PIA'} gateway
        {status?.publicIp ? ` — ${status.publicIp}` : ''}
      </div>
      {statusError && <div className="warning-banner">{statusError}</div>}
      {status && (
        <div className="gateway-status">
          <div>
            <span className="label">Connected</span> {status.connected ? 'yes' : 'no'}
          </div>
          <div>
            <span className="label">Country</span>{' '}
            {countryStatus ? (
              <span className={countryStatus.warning ? 'city-mismatch' : undefined}>{countryStatus.text}</span>
            ) : (
              '—'
            )}
          </div>
          <div>
            <span className="label">Server</span> {status.server || '—'}
          </div>
          {isNordVpn && cityStatus && (
            <div>
              <span className="label">City</span>{' '}
              <span className={cityStatus.warning ? 'city-mismatch' : undefined}>{cityStatus.text}</span>
            </div>
          )}
          {isNordVpn && status.group && (
            <div>
              <span className="label">Server Group</span> {status.group}
            </div>
          )}
          <div>
            <span className="label">Since</span> {status.since ? new Date(status.since).toLocaleString() : '—'}
          </div>
          <div>
            <span className="label">Last check</span>{' '}
            {status.lastHealthCheck ? new Date(status.lastHealthCheck).toLocaleString() : '—'}
            {status.lastHealthCheck ? (status.lastHealthCheckOk ? ' (ok)' : ' (failed — reconnecting)') : ''}
          </div>
        </div>
      )}
      {countriesError && (
        <div className="warning-banner">
          Couldn't load countries: {countriesError}{' '}
          <button className="button" onClick={loadCountries}>
            Retry
          </button>
        </div>
      )}
      {isNordVpn && citiesError && (
        <div className="warning-banner">
          Couldn't load cities: {citiesError}{' '}
          <button className="button" onClick={loadCities}>
            Retry
          </button>
        </div>
      )}
      {isNordVpn && groupsError && (
        <div className="warning-banner">
          Couldn't load server groups: {groupsError}{' '}
          <button className="button" onClick={loadGroups}>
            Retry
          </button>
        </div>
      )}
      <div className="stats-row">
        <select className="field-input" value={selectedCountry} onChange={(e) => setSelectedCountry(e.target.value)}>
          <option value="">Best (auto)</option>
          {countries.map((c) => (
            <option key={c.code} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        {isNordVpn && (
          <select
            className="field-input"
            value={selectedCity}
            onChange={(e) => setSelectedCity(e.target.value)}
            disabled={!selectedCountry}
          >
            <option value="">{selectedCountry ? `Best in ${selectedCountry} (auto)` : 'Select a country first'}</option>
            {cities.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {isNordVpn && (
          <select className="field-input" value={selectedGroup} onChange={(e) => setSelectedGroup(e.target.value)}>
            <option value="">Standard (any)</option>
            {groups.map((g) => (
              <option key={g.identifier} value={g.identifier}>
                {g.name}
              </option>
            ))}
          </select>
        )}
        <button className="button" onClick={connect} disabled={connecting}>
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </div>
  );
}
