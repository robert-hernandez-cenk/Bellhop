import { EditableAuthGroup } from './EditableAuthGroup';
import { EditableAuthMode, EditableOidcRedirectUris } from './EditableAuthMode';
import { EditableCaddyManual } from './EditableCaddyManual';
import { EditableInsecureBackendTls } from './EditableInsecureBackendTls';
import { EditablePort } from './EditablePort';
import { EditableSubdomains } from './EditableSubdomains';
import { EditableUnauthenticatedPaths } from './EditableUnauthenticatedPaths';
import { EditableVpn } from './EditableVpn';
import { ExternalLink } from './ExternalLink';
import { OidcCredentials } from './OidcCredentials';
import type { GuestEntry, HostEntry, CustomScripts } from '../api/types';
import { communityScriptsUrl, communityScriptsLinkLabel } from '../lib/guest-display';
import { isOidcEffective } from '../lib/oidc';

interface Props {
  guest: GuestEntry;
  hosts: HostEntry[];
  guests: GuestEntry[];
  customScripts: CustomScripts | null;
  onClose: () => void;
  onSaved: () => void;
}

export function AdvancedGuestModal({ guest, hosts, guests, customScripts, onClose, onSaved }: Props) {
  const appUrl = communityScriptsUrl(guest, customScripts);
  const appLinkLabel = communityScriptsLinkLabel(guest, customScripts);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h3>Advanced — {guest.name}</h3>
        <div className="advanced-modal-fields">
          <div className="form-row">
            <div className="form-row-label">type</div>
            <div className="form-row-value">{guest.type}</div>
          </div>
          <div className="form-row">
            <div className="form-row-label">ip</div>
            <div className="form-row-value">{guest.ip}</div>
          </div>
          <div className="form-row">
            <div className="form-row-label">subdomains</div>
            <div className="form-row-value">
              <EditableSubdomains guest={guest} hosts={hosts} guests={guests} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">host</div>
            <div className="form-row-value">{guest.host}</div>
          </div>
          <div className="form-row">
            <div className="form-row-label">vmid</div>
            <div className="form-row-value">{guest.vmid}</div>
          </div>
          <div className="form-row">
            <div className="form-row-label">port</div>
            <div className="form-row-value">
              <EditablePort guest={guest} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">read-only caddy</div>
            <div className="form-row-value">
              <EditableCaddyManual guest={guest} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">insecure backend tls</div>
            <div className="form-row-value">
              <EditableInsecureBackendTls guest={guest} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">auth group</div>
            <div className="form-row-value">
              <EditableAuthGroup guest={guest} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">auth mode</div>
            <div className="form-row-value">
              <EditableAuthMode guest={guest} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">callback urls</div>
            <div className="form-row-value">
              <EditableOidcRedirectUris guest={guest} onSaved={onSaved} />
            </div>
          </div>
          {isOidcEffective(guest) && (
            <div className="form-row">
              <div className="form-row-label">oidc client</div>
              <div className="form-row-value">
                <OidcCredentials guest={guest} />
              </div>
            </div>
          )}
          <div className="form-row">
            <div className="form-row-label">unauthenticated paths</div>
            <div className="form-row-value">
              <EditableUnauthenticatedPaths guest={guest} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">vpn</div>
            <div className="form-row-value">
              <EditableVpn guest={guest} guests={guests} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">app</div>
            <div className="form-row-value">
              {guest.app ? (
                <span className="app-cell">
                  {guest.app}
                  {appUrl && <ExternalLink href={appUrl} label={appLinkLabel} />}
                </span>
              ) : (
                '—'
              )}
            </div>
          </div>
        </div>
        <div className="stats-row">
          <button className="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
