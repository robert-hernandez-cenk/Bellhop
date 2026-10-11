import { useState } from 'react';
import { EditableAuthGroup } from './EditableAuthGroup';
import { EditableAuthMode, EditableOidcRedirectUris, EditableOidcMobileRedirectUris } from './EditableAuthMode';
import { EditableBellhop } from './EditableBellhop';
import { EditableProxyManual } from './EditableProxyManual';
import { EditableInsecureBackendTls } from './EditableInsecureBackendTls';
import { EditablePort } from './EditablePort';
import { EditableSubdomains } from './EditableSubdomains';
import { EditableUnauthenticatedPaths } from './EditableUnauthenticatedPaths';
import { EditableVpn } from './EditableVpn';
import { ExternalLink } from './ExternalLink';
import { FieldHelp } from './FieldHelp';
import { OidcCredentials } from './OidcCredentials';
import type { GuestEntry, HostEntry, CustomScripts } from '../api/types';
import { ADVANCED_FIELD_HELP, type AdvancedFieldLabel } from '../lib/advanced-field-help';
import { communityScriptsUrl, communityScriptsLinkLabel } from '../lib/guest-display';
import { isOidcEffective, accessFieldsFor, type AccessField } from '../lib/oidc';
import { liveHelp, renderedAdvancedFields, type AdvancedTab, type HelpState } from '../lib/advanced-modal';

interface Props {
  guest: GuestEntry;
  hosts: HostEntry[];
  guests: GuestEntry[];
  customScripts: CustomScripts | null;
  onClose: () => void;
  onSaved: () => void;
}

// At most one field's explanation is open at a time (FR-006), tracked here
// rather than inside FieldHelp itself so a hover/click on one field can
// close another -- see specs/011-advanced-field-help/data-model.md for the
// exact transition table `helpFor` below implements, and
// lib/advanced-modal.ts for HelpState and liveHelp.

export function AdvancedGuestModal({ guest, hosts, guests, customScripts, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<AdvancedTab>('general');
  const appUrl = communityScriptsUrl(guest, customScripts);
  const appLinkLabel = communityScriptsLinkLabel(guest, customScripts);
  const accessFields = new Set<AccessField>(accessFieldsFor(guest));
  const [help, setHelp] = useState<HelpState | null>(null);
  const showOidcClient = isOidcEffective(guest);

  // A help state for a row that is not rendered right now (the other tab's
  // rows, an Access row the guest's auth mode hides, or the oidc client row
  // outside effective OIDC) counts as closed, so a pinned explanation left
  // behind there can't block hover on every visible field.
  const rendered = renderedAdvancedFields(tab, guest);
  function live(state: HelpState | null): HelpState | null {
    return liveHelp(state, rendered);
  }
  const current = live(help);

  function helpFor(field: AdvancedFieldLabel) {
    const open = current !== null && current.field === field;
    const pinned = open && current.pinned;
    return {
      open,
      pinned,
      onHover: (hoverOpen: boolean) => {
        setHelp((raw) => {
          const prev = live(raw);
          if (hoverOpen) {
            // hover-in opens unpinned only when nothing is pinned
            if (prev !== null && prev.pinned) return prev;
            return { field, pinned: false };
          }
          // hover-out closes only an unpinned open state for that field
          if (prev !== null && prev.field === field && !prev.pinned) return null;
          return prev;
        });
      },
      onToggle: () => {
        setHelp((raw) => {
          const prev = live(raw);
          // toggle flips pinned for that field and replaces any other
          if (prev !== null && prev.field === field && prev.pinned) return null;
          return { field, pinned: true };
        });
      },
      onClose: () => setHelp(null),
    };
  }

  const fieldHelp = (field: AdvancedFieldLabel) => (
    <FieldHelp field={field} text={ADVANCED_FIELD_HELP[field]} {...helpFor(field)} />
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box advanced-modal-box" onClick={(e) => e.stopPropagation()}>
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
              <div className="form-row-label">{fieldHelp('type')}</div>
              <div className="form-row-value">{guest.type}</div>
            </div>
            <div className="form-row">
              <div className="form-row-label">{fieldHelp('ip')}</div>
              <div className="form-row-value">{guest.ip}</div>
            </div>
            <div className="form-row">
              <div className="form-row-label">{fieldHelp('subdomains')}</div>
              <div className="form-row-value">
                <EditableSubdomains guest={guest} hosts={hosts} guests={guests} onSaved={onSaved} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-row-label">{fieldHelp('host')}</div>
              <div className="form-row-value">{guest.host}</div>
            </div>
            <div className="form-row">
              <div className="form-row-label">{fieldHelp('vmid')}</div>
              <div className="form-row-value">{guest.vmid}</div>
            </div>
            <div className="form-row">
              <div className="form-row-label">{fieldHelp('port')}</div>
              <div className="form-row-value">
                <EditablePort guest={guest} onSaved={onSaved} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-row-label">{fieldHelp('read-only proxy')}</div>
              <div className="form-row-value">
                <EditableProxyManual guest={guest} onSaved={onSaved} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-row-label">{fieldHelp('insecure backend tls')}</div>
              <div className="form-row-value">
                <EditableInsecureBackendTls guest={guest} onSaved={onSaved} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-row-label">{fieldHelp('vpn')}</div>
              <div className="form-row-value">
                <EditableVpn guest={guest} guests={guests} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-row-label">{fieldHelp('app')}</div>
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
            {guest.creator && (
              <div className="form-row">
                <div className="form-row-label">{fieldHelp('created by')}</div>
                <div className="form-row-value">{guest.creator.username}</div>
              </div>
            )}
          </div>
        )}
        {tab === 'access' && (
          <div className="advanced-modal-fields">
            {accessFields.has('authGroup') && (
              <div className="form-row">
                <div className="form-row-label">{fieldHelp('auth group')}</div>
                <div className="form-row-value">
                  <EditableAuthGroup guest={guest} onSaved={onSaved} />
                </div>
              </div>
            )}
            {accessFields.has('authMode') && (
              <div className="form-row">
                <div className="form-row-label">{fieldHelp('auth mode')}</div>
                <div className="form-row-value">
                  <EditableAuthMode guest={guest} onSaved={onSaved} />
                </div>
              </div>
            )}
            {accessFields.has('unauthenticatedPaths') && (
              <div className="form-row">
                <div className="form-row-label">{fieldHelp('unauthenticated paths')}</div>
                <div className="form-row-value">
                  <EditableUnauthenticatedPaths guest={guest} onSaved={onSaved} />
                </div>
              </div>
            )}
            {accessFields.has('callbackUrls') && (
              <div className="form-row">
                <div className="form-row-label">{fieldHelp('callback urls')}</div>
                <div className="form-row-value">
                  <EditableOidcRedirectUris guest={guest} onSaved={onSaved} />
                </div>
              </div>
            )}
            {accessFields.has('mobileRedirectUrls') && (
              <div className="form-row">
                <div className="form-row-label">{fieldHelp('mobile app redirect urls')}</div>
                <div className="form-row-value">
                  <EditableOidcMobileRedirectUris guest={guest} onSaved={onSaved} />
                </div>
              </div>
            )}
            {accessFields.has('oidcClient') && showOidcClient && (
              <div className="form-row">
                <div className="form-row-label">{fieldHelp('oidc client')}</div>
                <div className="form-row-value">
                  <OidcCredentials guest={guest} />
                </div>
              </div>
            )}
            {accessFields.has('bellhop') && (
              <div className="form-row">
                <div className="form-row-label">{fieldHelp('this is bellhop')}</div>
                <div className="form-row-value">
                  <EditableBellhop guest={guest} onSaved={onSaved} />
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
