// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same rationale as
// advanced-field-help.ts. Which field rows the guest Advanced modal renders
// for a given tab and guest, and the help-state rule built on it: at most one
// field's explanation is open (issue #34, FR-006), and an open state for a
// row that isn't rendered right now counts as closed.

import type { AdvancedFieldLabel } from './advanced-field-help.ts';
import { accessFieldsFor, isOidcEffective, type AccessField, type AccessFieldsInput } from './oidc.ts';

export type AdvancedTab = 'general' | 'access';

// In the order AdvancedGuestModal renders them on the General tab.
export const GENERAL_TAB_FIELDS: readonly AdvancedFieldLabel[] = [
  'type',
  'ip',
  'subdomains',
  'host',
  'vmid',
  'port',
  'read-only proxy',
  'insecure backend tls',
  'vpn',
  'app',
];

const ACCESS_FIELD_LABELS: Record<AccessField, AdvancedFieldLabel> = {
  authGroup: 'auth group',
  authMode: 'auth mode',
  unauthenticatedPaths: 'unauthenticated paths',
  callbackUrls: 'callback urls',
  mobileRedirectUrls: 'mobile app redirect urls',
  oidcClient: 'oidc client',
};

export function renderedAdvancedFields(tab: AdvancedTab, guest: AccessFieldsInput): Set<AdvancedFieldLabel> {
  if (tab === 'general') return new Set(GENERAL_TAB_FIELDS);
  const fields = accessFieldsFor(guest).filter((f) => f !== 'oidcClient' || isOidcEffective(guest));
  return new Set(fields.map((f) => ACCESS_FIELD_LABELS[f]));
}

// `pinned` distinguishes a hover-opened explanation (closes on hover-out)
// from a click/tap/keyboard-opened one (stays open until explicitly closed)
// -- see specs/011-advanced-field-help/data-model.md.
export interface HelpState {
  field: AdvancedFieldLabel;
  pinned: boolean;
}

// A help state for a row that isn't rendered right now (the other tab's
// rows, an Access row the guest's auth mode hides, or the oidc client row
// outside effective OIDC) counts as closed, so a pinned explanation left
// behind there can't block hover on every visible field.
export function liveHelp(state: HelpState | null, rendered: ReadonlySet<AdvancedFieldLabel>): HelpState | null {
  if (state === null || !rendered.has(state.field)) return null;
  return state;
}
