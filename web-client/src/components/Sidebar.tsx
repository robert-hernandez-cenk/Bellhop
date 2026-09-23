import { NavLink } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { apiGet, apiPost, apiDelete } from '../api/client';
import type { AuthentikGroupEntry } from '../api/types';
import { ThemeToggle } from './ThemeToggle';

interface NavItem {
  id: string;
  label: string;
}

// Mirrors GET /api/whoami (src/web/routes/dashboard.ts). isAdmin and
// adminGroups are computed server-side so this build does not have to
// hardcode the admin group names it cannot import.
export interface WhoAmI {
  username: string;
  email?: string;
  groups: string[];
  impersonating?: string;
  localOperator: boolean;
  isAdmin: boolean;
  adminGroups: { app: string; authentikBuiltin: string };
  capabilities: { userDirectory: boolean };
}

export function Sidebar() {
  const [provisioning, setProvisioning] = useState<NavItem[]>([]);
  const [maintenance, setMaintenance] = useState<NavItem[]>([]);
  const [open, setOpen] = useState(false);
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [groups, setGroups] = useState<AuthentikGroupEntry[]>([]);
  const [impersonateTarget, setImpersonateTarget] = useState('');
  const [impersonateBusy, setImpersonateBusy] = useState(false);
  const [impersonateError, setImpersonateError] = useState<string | null>(null);

  const isAdmin = !!whoami?.isAdmin;
  // Everything below needs Authentik's REST API, not just an identity.
  const hasDirectory = !!whoami?.capabilities.userDirectory;

  useEffect(() => {
    apiGet<NavItem[]>('/provisioning').then(setProvisioning);
    apiGet<NavItem[]>('/maintenance').then(setMaintenance);
    apiGet<WhoAmI>('/whoami').then(setWhoami);
  }, []);

  // Only fetched for a real admin who isn't already impersonating -- while
  // impersonating a non-admin group, GET /api/groups would itself 403 under
  // the overlaid groups, and the picker isn't shown in that state anyway
  // (see the "Impersonating" banner below).
  useEffect(() => {
    if (isAdmin && hasDirectory && !whoami?.impersonating) {
      const admin = whoami!.adminGroups;
      apiGet<AuthentikGroupEntry[]>('/groups')
        .then((g) => g.filter((group) => group.name !== admin.app && group.name !== admin.authentikBuiltin))
        .then(setGroups);
    }
  }, [isAdmin, hasDirectory, whoami?.impersonating]);

  const close = () => setOpen(false);

  // Networking/Update/SSH Keys/Jobs render under the Maintenance group
  // label the same as the API-driven actions do, so both sets are merged
  // into one list and sorted by label rather than the static four being
  // appended after the sorted API ones.
  const maintenanceLinks = [
    ...maintenance.map((item) => ({ to: `/maintenance/${item.id}`, label: item.label })),
    { to: '/networking', label: 'Networking' },
    { to: '/update', label: 'Update' },
    { to: '/ssh-keys', label: 'SSH Keys' },
    { to: '/jobs', label: 'Jobs & History' },
  ].sort((a, b) => a.label.localeCompare(b.label));

  const startImpersonating = async () => {
    if (!impersonateTarget) return;
    setImpersonateBusy(true);
    setImpersonateError(null);
    try {
      await apiPost('/impersonate', { group: impersonateTarget });
      window.location.reload();
    } catch (err) {
      setImpersonateError(err instanceof Error ? err.message : String(err));
      setImpersonateBusy(false);
    }
  };

  const stopImpersonating = async () => {
    setImpersonateBusy(true);
    setImpersonateError(null);
    try {
      await apiDelete('/impersonate');
      window.location.reload();
    } catch (err) {
      setImpersonateError(err instanceof Error ? err.message : String(err));
      setImpersonateBusy(false);
    }
  };

  return (
    <>
      <button className="hamburger-btn" onClick={() => setOpen(true)} aria-label="Open navigation">
        ☰
      </button>
      <div className={`sidebar-backdrop${open ? ' open' : ''}`} onClick={close} />
      <nav className={`sidebar${open ? ' open' : ''}`}>
        <div className="brand">Bellhop</div>
        <NavLink to="/" end onClick={close}>
          Dashboard
        </NavLink>
        <div className="nav-group-label">Provisioning</div>
        {provisioning.map((item) => (
          <NavLink key={item.id} to={`/provisioning/${item.id}`} onClick={close}>
            {item.label}
          </NavLink>
        ))}
        <div className="nav-group-label">Maintenance</div>
        {maintenanceLinks.map((item) => (
          <NavLink key={item.to} to={item.to} onClick={close}>
            {item.label}
          </NavLink>
        ))}
        {isAdmin && hasDirectory && (
          <>
            <div className="nav-group-label">Admin</div>
            <NavLink to="/users" onClick={close}>
              Users
            </NavLink>
            <NavLink to="/permissions" onClick={close}>
              Permissions
            </NavLink>
            <NavLink to="/settings" onClick={close}>
              Settings
            </NavLink>
          </>
        )}
        <ThemeToggle />
        {impersonateError && <div className="warning-banner">{impersonateError}</div>}
        {whoami?.localOperator && (
          // One of the two visible guards on the inferred default auth
          // mode -- the other is the server's startup warning. An
          // unauthenticated deployment should never be mistaken for an
          // authenticated one. Rendered outside the impersonating ternary
          // below so it stays visible even while a local operator is
          // impersonating a group -- auth mode 'none' with an Authentik API
          // configured (so there's something to impersonate) is a supported
          // combination, and this banner is the only signal an operator in
          // that state gets that authentication is still unconfigured.
          <div className="warning-banner">
            No authentication configured — everyone who can reach this page has full access. Set
            WEB_UI_AUTH_MODE=authentik once an identity provider is in place.
          </div>
        )}
        {whoami?.impersonating ? (
          // Driven purely by whoami.impersonating being present -- stays
          // reachable regardless of what the impersonated group's own nav
          // gating above hides, so an admin can never get stuck unable to
          // find the control that turns impersonation back off.
          <div className="impersonate-banner">
            Impersonating: {whoami.impersonating}
            <br />
            signed in as {whoami.username}
            <button className="button" onClick={stopImpersonating} disabled={impersonateBusy}>
              Stop impersonating
            </button>
          </div>
        ) : (
          <>
            {isAdmin && hasDirectory && (
              <div className="impersonate-picker">
                <div className="label">Impersonate</div>
                <select
                  className="field-input"
                  value={impersonateTarget}
                  onChange={(e) => setImpersonateTarget(e.target.value)}
                >
                  <option value="">Select a group…</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.name}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <button className="button" onClick={startImpersonating} disabled={impersonateBusy || !impersonateTarget}>
                  Start
                </button>
              </div>
            )}
            {whoami && (
              <div className="signed-in-as">
                Signed in as {whoami.username}
                {/* Authentik's own sign-out endpoint -- meaningless without it. */}
                {!whoami.localOperator && <a href="/outpost.goauthentik.io/sign_out">Sign out</a>}
              </div>
            )}
          </>
        )}
      </nav>
    </>
  );
}
