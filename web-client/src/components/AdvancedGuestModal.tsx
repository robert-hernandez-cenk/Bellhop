import { useState } from 'react';
import { EditableAuthGroup } from './EditableAuthGroup';
import { EditableAuthMode, EditableOidcRedirectUris, EditableOidcMobileRedirectUris } from './EditableAuthMode';
import { EditableProxyManual } from './EditableProxyManual';
import { EditableInsecureBackendTls } from './EditableInsecureBackendTls';
import { EditablePort } from './EditablePort';
import { EditableSubdomains } from './EditableSubdomains';
import { EditableUnauthenticatedPaths } from './EditableUnauthenticatedPaths';
import { EditableVpn } from './EditableVpn';
import { ExternalLink } from './ExternalLink';
import { OidcCredentials } from './OidcCredentials';
import type { GuestEntry, HostEntry, CustomScripts } from '../api/types';
import { communityScriptsUrl, communityScriptsLinkLabel } from '../lib/guest-display';
import { isOidcEffective, accessFieldsFor, type AccessField } from '../lib/oidc';

interface Props {
  guest: GuestEntry;
  hosts: HostEntry[];
  guests: GuestEntry[];
  customScripts: CustomScripts | null;
  onClose: () => void;
  onSaved: () => void;
}

type Tab = 'general' | 'access';

export function AdvancedGuestModal({ guest, hosts, guests, customScripts, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<Tab>('general');
  const appUrl = communityScriptsUrl(guest, customScripts);
  const appLinkLabel = communityScriptsLinkLabel(guest, customScripts);
  const accessFields = new Set<AccessField>(accessFieldsFor(guest.authMode));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h3>Advanced — {guest.name}</h3>
        <div className="tab-strip" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'general'}
            className={`tab-button${tab === 'general' ? ' active' : ''}`}
            onClick={() => setTab('general')}
          >
            General
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'access'}
            className={`tab-button${tab === 'access' ? ' active' : ''}`}
            onClick={() => setTab('access')}
          >
            Access
          </button>
        </div>
        {tab === 'general' && (
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
              <div className="form-row-label">read-only proxy</div>
              <div className="form-row-value">
                <EditableProxyManual guest={guest} onSaved={onSaved} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-row-label">insecure backend tls</div>
              <div className="form-row-value">
                <EditableInsecureBackendTls guest={guest} onSaved={onSaved} />
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
        )}
        {tab === 'access' && (
          <div className="advanced-modal-fields">
            {accessFields.has('authGroup') && (
              <div className="form-row">
                <div className="form-row-label">auth group</div>
                <div className="form-row-value">
                  <EditableAuthGroup guest={guest} onSaved={onSaved} />
                </div>
              </div>
            )}
            {accessFields.has('authMode') && (
              <div className="form-row">
                <div className="form-row-label">auth mode</div>
                <div className="form-row-value">
                  <EditableAuthMode guest={guest} onSaved={onSaved} />
                </div>
              </div>
            )}
            {accessFields.has('unauthenticatedPaths') && (
              <div className="form-row">
                <div className="form-row-label">unauthenticated paths</div>
                <div className="form-row-value">
                  <EditableUnauthenticatedPaths guest={guest} onSaved={onSaved} />
                </div>
              </div>
            )}
            {accessFields.has('callbackUrls') && (
              <div className="form-row">
                <div className="form-row-label">callback urls</div>
                <div className="form-row-value">
                  <EditableOidcRedirectUris guest={guest} onSaved={onSaved} />
                </div>
              </div>
            )}
            {accessFields.has('mobileRedirectUrls') && (
              <div className="form-row">
                <div className="form-row-label">mobile app redirect urls</div>
                <div className="form-row-value">
                  <EditableOidcMobileRedirectUris guest={guest} onSaved={onSaved} />
                </div>
              </div>
            )}
            {accessFields.has('oidcClient') && isOidcEffective(guest) && (
              <div className="form-row">
                <div className="form-row-label">oidc client</div>
                <div className="form-row-value">
                  <OidcCredentials guest={guest} />
                </div>
              </div>
            )}
          </div>
        )}
        <div className="stats-row">
          <button className="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
