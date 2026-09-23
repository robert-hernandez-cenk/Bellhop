import { Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../api/client';
import type { HostEntry, GuestEntry, GuestStatusResponse } from '../api/types';
import { DeleteGuestModal } from '../components/DeleteGuestModal';
import { AdvancedGuestModal } from '../components/AdvancedGuestModal';
import { PageDescription } from '../components/PageDescription';
import { TableViewToggle } from '../components/TableViewToggle';
import { ExternalLink } from '../components/ExternalLink';
import { IconStart, IconShutdown, IconDelete } from '../components/icons';
import { formatStorageSize } from '../lib/storage-size';
import { useTableView } from '../lib/table-view';
import { sortGuestsForDisplay, caddyUrl, ipUrl } from '../lib/guest-display';

export function Dashboard() {
  const navigate = useNavigate();
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [guests, setGuests] = useState<GuestEntry[]>([]);
  const [domain, setDomain] = useState('');
  const [filter, setFilter] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingGuest, setDeletingGuest] = useState<GuestEntry | null>(null);
  const [advancedGuestName, setAdvancedGuestName] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, 'running' | 'stopped'>>({});
  const [powering, setPowering] = useState<string | null>(null);
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(new Set());
  const [view, setView] = useTableView();

  const toggleHost = (name: string) => {
    setExpandedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const load = () => {
    apiGet<{ hosts: HostEntry[]; guests: GuestEntry[]; domain: string }>('/inventory').then((data) => {
      setHosts(data.hosts);
      setGuests(data.guests);
      setDomain(data.domain);
    });
  };

  const loadStatuses = () => {
    apiGet<GuestStatusResponse>('/guests/status').then((data) => {
      setStatuses(data.statuses);
      if (data.failures.length > 0) {
        setError(`Guest status unavailable for: ${data.failures.join(', ')}`);
      }
    });
  };

  useEffect(() => {
    load();
    loadStatuses();
  }, []);

  const filtered = sortGuestsForDisplay(
    guests.filter((g) => [g.name, g.host, ...(g.subdomains ?? [])].some((v) => v.toLowerCase().includes(filter.toLowerCase())))
  );

  const advancedGuest = advancedGuestName ? guests.find((g) => g.name === advancedGuestName) ?? null : null;

  const runSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      // sync-inventory can take tens of seconds (it queries every host's
      // guests and network bridges live) -- apply only returns a jobId
      // once the job is queued, not once it's done, so we navigate to the
      // live Job view rather than just flashing "Syncing..." for a second.
      const res = await apiPost<{ jobId: number }>('/maintenance/sync-inventory/apply', {});
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSyncing(false);
    }
  };

  const triggerGuestPower = async (guest: GuestEntry, state: 'start' | 'shutdown') => {
    setPowering(guest.name);
    setError(null);
    try {
      const res = await apiPost<{ jobId: number }>('/maintenance/guest-power', { guest: guest.name, state });
      navigate(`/jobs/${res.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPowering(null);
    }
  };

  return (
    <div>
      <h2>Dashboard</h2>
      <PageDescription>
        View of your Proxmox inventory — hosts, their network bridges, and guests as recorded in{' '}
        <code>bellhop.db</code>. Run sync-inventory to reconcile it against live Proxmox state; hand-editing or a
        command's own apply step is the only other way most of this changes. Click a host row to expand its bridges
        and storage. A bridge's alias mirrors its "Comment" field in Proxmox itself — set it there, not here. A
        guest's subdomains are shown read-only here; click its "advanced" link to edit them, along with its
        host, vmid, port, app, VPN routing, and Caddy settings — each saved independently on blur/change
        (subdomains checked against every other entry's first). A guest's name links to its live service (if it has a
        subdomain) — omitted when not applicable. Set a port before adding a subdomain to a guest that doesn't
        have one yet, otherwise Caddy defaults it to 80; checking "Read-only Caddy" keeps a guest's subdomains
        out of sync-caddy's generated Caddyfile section (for a service whose real Caddy config is
        hand-authored elsewhere) while still driving its service link above; checking "Insecure Backend TLS"
        wraps that guest's reverse_proxy in a transport that skips TLS verification, for a backend serving its
        own self-signed cert (e.g. an app bundling its own nginx with a generated cert, or the
        Proxmox/NAS pattern already used for hosts).
      </PageDescription>
      <div className="stats-row">
        <div className="stat-tile">{hosts.length} hosts</div>
        <div className="stat-tile">{guests.length} guests</div>
        <button className="button" onClick={runSync} disabled={syncing}>
          {syncing ? 'Starting…' : 'Run sync-inventory'}
        </button>
        <TableViewToggle view={view} onChange={setView} />
      </div>
      {error && <div className="warning-banner">{error}</div>}

      <div className={view === 'card' ? 'card-view' : undefined}>
      <h3>Hosts</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th className="col-expand"></th>
            <th>name</th>
            <th>mid scheme</th>
            <th>ssh target</th>
          </tr>
        </thead>
        <tbody>
          {hosts.map((h) => {
            const expanded = expandedHosts.has(h.name);
            return (
              <Fragment key={h.name}>
                <tr className="expandable-row" onClick={() => toggleHost(h.name)}>
                  <td className="col-expand" data-label="expand">{expanded ? '▾' : '▸'}</td>
                  <td data-label="name">{h.name}</td>
                  <td data-label="mid scheme">{h.midScheme ? `${h.midScheme.ipPrefix}x` : '—'}</td>
                  <td data-label="ssh target">{h.ssh_port ? `${h.ssh_target}:${h.ssh_port}` : h.ssh_target}</td>
                </tr>
                {expanded && (
                  <tr className="host-detail-row">
                    <td colSpan={4} className="host-detail-cell">
                      <div className="host-detail">
                        <div className="host-detail-section">
                          <div className="label">Bridges</div>
                          {h.bridges && h.bridges.length > 0 ? (
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>name</th>
                                  <th>alias</th>
                                  <th>active</th>
                                </tr>
                              </thead>
                              <tbody>
                                {h.bridges.map((b) => (
                                  <tr key={b.name}>
                                    <td data-label="name">{b.name}</td>
                                    <td data-label="alias">{b.alias}</td>
                                    <td data-label="active">{b.active ? 'yes' : 'no'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <p className="page-description">No bridge data yet — run sync-inventory to pull it from Proxmox.</p>
                          )}
                        </div>
                        <div className="host-detail-section">
                          <div className="label">Storage</div>
                          {h.storages && h.storages.length > 0 ? (
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>name</th>
                                  <th>type</th>
                                  <th>content</th>
                                  <th>size</th>
                                  <th>active</th>
                                </tr>
                              </thead>
                              <tbody>
                                {h.storages.map((s) => (
                                  <tr key={s.name}>
                                    <td data-label="name">{s.name}</td>
                                    <td data-label="type">{s.type}</td>
                                    <td data-label="content">{s.content.join(', ')}</td>
                                    <td data-label="size">{formatStorageSize(s) ?? '—'}</td>
                                    <td data-label="active">{s.active ? 'yes' : 'no'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <p className="page-description">No storage data yet — run sync-inventory to pull it from Proxmox.</p>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      <h3>Guests</h3>
      <input
        className="field-input"
        placeholder="Filter by name, host, subdomain…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <table className="data-table">
        <thead>
          <tr>
            <th>name</th>
            <th>type</th>
            <th>ip</th>
            <th>subdomains</th>
            <th></th>
            <th>actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((g) => {
            const service = caddyUrl(g, domain);
            const ipLink = ipUrl(g);
            return (
            <tr key={g.name}>
              <td data-label="name">
                <span className="name-cell">
                  {g.name}
                  {service && <ExternalLink href={service} label={`Open ${g.name}'s service`} />}
                </span>
              </td>
              <td data-label="type">{g.type}</td>
              <td data-label="ip">
                <span className="name-cell">
                  {g.ip}
                  {ipLink && <ExternalLink href={ipLink} label={`Open ${g.name}'s ip:port`} />}
                </span>
              </td>
              <td data-label="subdomains">{(g.subdomains ?? []).join('; ') || '—'}</td>
              <td>
                <button className="advanced-link" onClick={() => setAdvancedGuestName(g.name)}>
                  advanced
                </button>
              </td>
              <td data-label="actions">
                <div className="actions-cell">
                  <button
                    className="button button-icon"
                    onClick={() => triggerGuestPower(g, 'start')}
                    disabled={statuses[g.name] !== 'stopped' || powering === g.name}
                    aria-label="Start"
                    title="Start"
                  >
                    <IconStart />
                  </button>
                  <button
                    className="button button-icon button-danger"
                    onClick={() => {
                      if (confirm(`Shut down "${g.name}"?`)) triggerGuestPower(g, 'shutdown');
                    }}
                    disabled={statuses[g.name] !== 'running' || powering === g.name}
                    aria-label="Shutdown"
                    title="Shutdown"
                  >
                    <IconShutdown />
                  </button>
                  <button
                    className="button button-icon button-danger"
                    onClick={() => setDeletingGuest(g)}
                    aria-label="Delete"
                    title="Delete"
                  >
                    <IconDelete />
                  </button>
                </div>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {deletingGuest && (
        <DeleteGuestModal
          guest={deletingGuest}
          hosts={hosts}
          onClose={() => {
            setDeletingGuest(null);
            load();
          }}
        />
      )}

      {advancedGuest && (
        <AdvancedGuestModal
          guest={advancedGuest}
          hosts={hosts}
          guests={guests}
          onClose={() => setAdvancedGuestName(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
