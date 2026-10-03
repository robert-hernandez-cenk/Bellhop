// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same rationale as
// advanced-field-help.ts. Which field rows the guest Advanced modal renders
// for a given tab and guest, and the help-state rule built on it: at most one
// field's explanation is open (issue #34, FR-006), and an open state for a
// row that isn't rendered right now counts as closed.

import type { AdvancedFieldLabel } from './advanced-field-help.ts';
import { accessFieldsFor, isOidcEffective, type AccessField, type AccessFieldsInput } from './oidc.ts';

export type AdvancedTab = 'general' | 'access';

// In the order AdvancedGuestModal renders them on the General tab. 'created
// by' is the one field here that isn't unconditional (unlike 'app', which
// always renders and just shows '—' when unset) -- it's a row that doesn't
// exist at all for a guest with no recorded creator (issue #58), so
// renderedAdvancedFields below filters it out rather than including it
// unconditionally.
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
  'created by',
];

const ACCESS_FIELD_LABELS: Record<AccessField, AdvancedFieldLabel> = {
  authGroup: 'auth group',
  authMode: 'auth mode',
  unauthenticatedPaths: 'unauthenticated paths',
  callbackUrls: 'callback urls',
  mobileRedirectUrls: 'mobile app redirect urls',
  oidcClient: 'oidc client',
};

// Who created this guest from Bellhop, mirroring the server's GuestEntry
// (src/lib/inventory.ts's GuestCreatorSchema) -- undefined for a guest
// created another way (issue #58).
export interface GeneralTabInput {
  creator?: { uid?: string; username: string };
}

export function renderedAdvancedFields(
  tab: AdvancedTab,
  guest: AccessFieldsInput & GeneralTabInput
): Set<AdvancedFieldLabel> {
  if (tab === 'general') {
    const fields = GENERAL_TAB_FIELDS.filter((f) => f !== 'created by' || !!guest.creator);
    return new Set(fields);
  }
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
