import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../api/client';
import type { HostEntry, GuestEntry, GuestStatusResponse, CustomScripts, AppUpdateResult } from '../api/types';
import { ExternalLink } from '../components/ExternalLink';
import { PageDescription } from '../components/PageDescription';
import { AppUpdateBadge } from '../components/AppUpdateBadge';
import { appUpdatesUnavailableText } from '../lib/app-update-display';
import { IconPackage, IconUpdate } from '../components/icons';
import { proxyUrl, communityScriptsUrl, communityScriptsLinkLabel, sortGuestsForDisplay } from '../lib/guest-display';

export function UpdatePage() {
  const navigate = useNavigate();
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [guests, setGuests] = useState<GuestEntry[]>([]);
  const [domain, setDomain] = useState('');
  const [customScripts, setCustomScripts] = useState<CustomScripts | null>(null);
  const [filter, setFilter] = useState('');
  const [statuses, setStatuses] = useState<Record<string, 'running' | 'stopped'>>({});
  const [appUpdates, setAppUpdates] = useState<Record<string, AppUpdateResult>>({});
  const [triggering, setTriggering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from `error`, which the update buttons clear: without this
  // banner, a failed load would look exactly like "no updates available".
  const [appUpdatesError, setAppUpdatesError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ hosts: HostEntry[]; guests: GuestEntry[]; domain: string; customScripts: CustomScripts | null }>(
      '/inventory'
    ).then((data) => {
      setHosts(data.hosts);
      setGuests(data.guests);
      setDomain(data.domain);
      setCustomScripts(data.customScripts);
    });
    apiGet<GuestStatusResponse>('/guests/status').then((data) => {
      setStatuses(data.statuses);
      if (data.failures.length > 0) {
        setError(`Guest status unavailable for: ${data.failures.join(', ')}`);
      }
    });
    apiGet<{ results: AppUpdateResult[] }>('/app-updates')
      .then((data) => {
        setAppUpdates(Object.fromEntries(data.results.map((r) => [r.guest, r])));
      })
      .catch((err) => {
        setAppUpdatesError(appUpdatesUnavailableText(err));
      });
  }, []);

  // update-all never updates a VM (issue #2), so a VM gets no OS-packages
  // button, and a VM with no community-scripts app has nothing to offer here.
  const filtered = sortGuestsForDisplay(
    guests.filter(
      (g) =>
        (g.type !== 'vm' || g.app) &&
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
        reinstalling, so running the OS-packages icon first isn't required. VMs are never
        updated here; update packages inside the VM itself. A guest with an app installed
        is checked once a day for a newer upstream release; the result shows next to its
        app name, and its update button stands out when an update is waiting.
      </PageDescription>
      {error && <div className="warning-banner">{error}</div>}
      {appUpdatesError && <div className="warning-banner">{appUpdatesError}</div>}

      <h3>Hosts</h3>
      <div className="update-card-grid">
        {hosts.map((h) => {
          const service = proxyUrl(h, domain);
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
          const service = proxyUrl(g, domain);
          const app = communityScriptsUrl(g, customScripts);
          const appLinkLabel = communityScriptsLinkLabel(g, customScripts);
          const stopped = statuses[g.name] !== 'running';
          const busy = triggering === g.name;
          const appUpdate = appUpdates[g.name];
          const updateAvailable = appUpdate?.status === 'update-available';
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
                    {app && <ExternalLink href={app} label={appLinkLabel} />}
                    <AppUpdateBadge result={appUpdate} />
                  </span>
                )}
              </div>
              <div className="actions-cell">
                {g.type !== 'vm' && (
                  <button
                    className="button button-icon"
                    onClick={() => runOsUpdate(g.name)}
                    disabled={stopped || busy}
                    aria-label="Update (OS packages)"
                    title={stopped ? 'Guest is stopped' : 'Update (OS packages)'}
                  >
                    <IconPackage />
                  </button>
                )}
                {g.app && (
                  <button
                    className={`button button-icon${updateAvailable ? ' button-attention' : ''}`}
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
