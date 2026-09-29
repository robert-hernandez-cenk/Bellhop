import { useState } from 'react';
import { EditableAuthGroup } from './EditableAuthGroup';
import { EditableAuthMode, EditableOidcRedirectUris } from './EditableAuthMode';
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
import { ADVANCED_FIELD_HELP } from '../lib/advanced-field-help';
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

// At most one field's explanation is open at a time (FR-006), tracked here
// rather than inside FieldHelp itself so a hover/click on one field can
// close another. `pinned` distinguishes a hover-opened explanation (closes
// on hover-out) from a click/tap/keyboard-opened one (stays open until
// explicitly closed) -- see specs/011-advanced-field-help/data-model.md for
// the exact transition table `helpFor` below implements.
interface HelpState {
  field: string;
  pinned: boolean;
}

export function AdvancedGuestModal({ guest, hosts, guests, customScripts, onClose, onSaved }: Props) {
  const appUrl = communityScriptsUrl(guest, customScripts);
  const appLinkLabel = communityScriptsLinkLabel(guest, customScripts);
  const [help, setHelp] = useState<HelpState | null>(null);

  function helpFor(field: string) {
    const open = help !== null && help.field === field;
    const pinned = open && help.pinned;
    return {
      open,
      pinned,
      onHover: (hoverOpen: boolean) => {
        setHelp((prev) => {
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
        setHelp((prev) => {
          // toggle flips pinned for that field and replaces any other
          if (prev !== null && prev.field === field && prev.pinned) return null;
          return { field, pinned: true };
        });
      },
      onClose: () => setHelp(null),
    };
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <h3>Advanced — {guest.name}</h3>
        <div className="advanced-modal-fields">
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp field="type" text={ADVANCED_FIELD_HELP['type']} {...helpFor('type')} />
            </div>
            <div className="form-row-value">{guest.type}</div>
          </div>
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp field="ip" text={ADVANCED_FIELD_HELP['ip']} {...helpFor('ip')} />
            </div>
            <div className="form-row-value">{guest.ip}</div>
          </div>
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp field="subdomains" text={ADVANCED_FIELD_HELP['subdomains']} {...helpFor('subdomains')} />
            </div>
            <div className="form-row-value">
              <EditableSubdomains guest={guest} hosts={hosts} guests={guests} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp field="host" text={ADVANCED_FIELD_HELP['host']} {...helpFor('host')} />
            </div>
            <div className="form-row-value">{guest.host}</div>
          </div>
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp field="vmid" text={ADVANCED_FIELD_HELP['vmid']} {...helpFor('vmid')} />
            </div>
            <div className="form-row-value">{guest.vmid}</div>
          </div>
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp field="port" text={ADVANCED_FIELD_HELP['port']} {...helpFor('port')} />
            </div>
            <div className="form-row-value">
              <EditablePort guest={guest} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp
                field="read-only proxy"
                text={ADVANCED_FIELD_HELP['read-only proxy']}
                {...helpFor('read-only proxy')}
              />
            </div>
            <div className="form-row-value">
              <EditableProxyManual guest={guest} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp
                field="insecure backend tls"
                text={ADVANCED_FIELD_HELP['insecure backend tls']}
                {...helpFor('insecure backend tls')}
              />
            </div>
            <div className="form-row-value">
              <EditableInsecureBackendTls guest={guest} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp field="auth group" text={ADVANCED_FIELD_HELP['auth group']} {...helpFor('auth group')} />
            </div>
            <div className="form-row-value">
              <EditableAuthGroup guest={guest} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp field="auth mode" text={ADVANCED_FIELD_HELP['auth mode']} {...helpFor('auth mode')} />
            </div>
            <div className="form-row-value">
              <EditableAuthMode guest={guest} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp
                field="callback urls"
                text={ADVANCED_FIELD_HELP['callback urls']}
                {...helpFor('callback urls')}
              />
            </div>
            <div className="form-row-value">
              <EditableOidcRedirectUris guest={guest} onSaved={onSaved} />
            </div>
          </div>
          {isOidcEffective(guest) && (
            <div className="form-row">
              <div className="form-row-label">
                <FieldHelp
                  field="oidc client"
                  text={ADVANCED_FIELD_HELP['oidc client']}
                  {...helpFor('oidc client')}
                />
              </div>
              <div className="form-row-value">
                <OidcCredentials guest={guest} />
              </div>
            </div>
          )}
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp
                field="unauthenticated paths"
                text={ADVANCED_FIELD_HELP['unauthenticated paths']}
                {...helpFor('unauthenticated paths')}
              />
            </div>
            <div className="form-row-value">
              <EditableUnauthenticatedPaths guest={guest} onSaved={onSaved} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp field="vpn" text={ADVANCED_FIELD_HELP['vpn']} {...helpFor('vpn')} />
            </div>
            <div className="form-row-value">
              <EditableVpn guest={guest} guests={guests} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-row-label">
              <FieldHelp field="app" text={ADVANCED_FIELD_HELP['app']} {...helpFor('app')} />
            </div>
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
