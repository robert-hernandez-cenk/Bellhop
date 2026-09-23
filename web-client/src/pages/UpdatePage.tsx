import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../api/client';
import type { HostEntry, GuestEntry, GuestStatusResponse } from '../api/types';
import { ExternalLink } from '../components/ExternalLink';
import { PageDescription } from '../components/PageDescription';
import { IconPackage, IconUpdate } from '../components/icons';
import { caddyUrl, communityScriptsUrl, sortGuestsForDisplay } from '../lib/guest-display';

export function UpdatePage() {
  const navigate = useNavigate();
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [guests, setGuests] = useState<GuestEntry[]>([]);
  const [domain, setDomain] = useState('');
  const [filter, setFilter] = useState('');
  const [statuses, setStatuses] = useState<Record<string, 'running' | 'stopped'>>({});
  const [triggering, setTriggering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ hosts: HostEntry[]; guests: GuestEntry[]; domain: string }>('/inventory').then((data) => {
      setHosts(data.hosts);
      setGuests(data.guests);
      setDomain(data.domain);
    });
    apiGet<GuestStatusResponse>('/guests/status').then((data) => {
      setStatuses(data.statuses);
      if (data.failures.length > 0) {
        setError(`Guest status unavailable for: ${data.failures.join(', ')}`);
      }
    });
  }, []);

  const filtered = sortGuestsForDisplay(
    guests.filter((g) =>
      [g.name, g.host, ...(g.subdomains ?? [])].some((v) => v.toLowerCase().includes(filter.toLowerCase()))
    )
  );

  const runOsUpdate = async (name: string) => {
    setTriggering(name);
    setError(null);
    try {
      const res = await apiPost<{ jobId: number }>('/maintenance/update-all/run', {
        selector: { host: name },
      });
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTriggering(null);
    }
  };

  const runAppUpdate = async (guest: GuestEntry) => {
    setTriggering(guest.name);
    setError(null);
    try {
      const res = await apiPost<{ jobId: number }>('/maintenance/update-app/apply', {
        guest: guest.name,
        app: guest.app,
      });
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTriggering(null);
    }
  };

  return (
    <div>
      <h2>Update</h2>
      <PageDescription>
        Update a host or guest's OS packages using whichever package manager it actually
        has (apt, dnf, apk, pacman, or zypper, detected per target), or re-run a guest's
        community-scripts install script to trigger its own update path. A guest with an
        app installed gets both icons; they run independently of each other -- the
        community-script update already runs its own package update as part of
        reinstalling, so running the OS-packages icon first isn't required.
      </PageDescription>
      {error && <div className="warning-banner">{error}</div>}

      <h3>Hosts</h3>
      <div className="update-card-grid">
        {hosts.map((h) => {
          const service = caddyUrl(h, domain);
          const busy = triggering === h.name;
          return (
            <div className="update-card" key={h.name}>
              <div className="update-card-info">
                <span className="name-cell">
                  {h.name}
                  {service && <ExternalLink href={service} label={`Open ${h.name}'s service`} />}
                </span>
              </div>
              <div className="actions-cell">
                <button
                  className="button button-icon"
                  onClick={() => runOsUpdate(h.name)}
                  disabled={busy}
                  aria-label="Update (OS packages)"
                  title="Update (OS packages)"
                >
                  <IconPackage />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <h3>Guests</h3>
      <input
        className="field-input"
        placeholder="Filter by name, host, subdomain…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="update-card-grid">
        {filtered.map((g) => {
          const service = caddyUrl(g, domain);
          const app = communityScriptsUrl(g);
          const stopped = statuses[g.name] !== 'running';
          const busy = triggering === g.name;
          return (
            <div className="update-card" key={g.name}>
              <div className="update-card-info">
                <span className="name-cell">
                  {g.name}
                  {service && <ExternalLink href={service} label={`Open ${g.name}'s service`} />}
                </span>
                {g.app && (
                  <span className="app-cell">
                    {g.app}
                    {app && <ExternalLink href={app} label={`Open ${g.app} on community-scripts`} />}
                  </span>
                )}
              </div>
              <div className="actions-cell">
                <button
                  className="button button-icon"
                  onClick={() => runOsUpdate(g.name)}
                  disabled={stopped || busy}
                  aria-label="Update (OS packages)"
                  title={stopped ? 'Guest is stopped' : 'Update (OS packages)'}
                >
                  <IconPackage />
                </button>
                {g.app && (
                  <button
                    className="button button-icon"
                    onClick={() => runAppUpdate(g)}
                    disabled={stopped || busy}
                    aria-label="Update via community-script"
                    title={stopped ? 'Guest is stopped' : 'Update via community-script'}
                  >
                    <IconUpdate />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
