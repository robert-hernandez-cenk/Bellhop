import type { GuestEntry } from '../api/types';
import { AdoptOidcClientButton } from './AdoptOidcClientButton';
import { isOidcEffective } from '../lib/oidc';

// One of sync-authentik's per-entry skips, as the guest PATCH response
// carries it (EditGuestResult.oidcSkipped in src/operations/edit-guest.ts).
export interface AuthentikSkip {
  slug: string;
  kind: string;
  reason: string;
}

interface ConflictProps {
  conflicts: string[];
  // EditGuestResult.authentikConflictAdoptable: an unmarked OpenID client
  // holds this guest's slug, which adopt-oidc-client can take over (FR-011).
  adoptable: boolean;
  guest: GuestEntry;
  // Omitted by a row that has no admin check of its own (EditableSubdomains):
  // the banner then only says adoption exists, without offering the action.
  isAdmin?: boolean;
}

// The slug-conflict banner shared by EditableAuthGroup/EditableAuthMode/EditableSubdomains/
// EditableOidcRedirectUris, so they never disagree about whether a
// conflict can be adopted. Shorter than the CLI's CONFLICT_EXPLANATION /
// OAUTH2_CONFLICT_EXPLANATION on purpose -- those do not fit the Advanced
// modal's narrow value column.
export function AuthentikConflictBanner({ conflicts, adoptable, guest, isAdmin = false }: ConflictProps) {
  if (conflicts.length === 0) return null;
  if (!adoptable) {
    return (
      <div className="warning-banner">
        Authentik slug conflict: {conflicts.join(', ')} — the slug is held by an Application this
        toolkit does not manage; logins will fail until it is resolved by hand.
      </div>
    );
  }
  const oidc = isOidcEffective(guest);
  return (
    <div className="warning-banner">
      Authentik slug conflict: {conflicts.join(', ')} — a hand-made OpenID client holds this slug. It
      can be adopted as Bellhop-managed, keeping its client ID and secret.
      {isAdmin && oidc && <AdoptOidcClientButton entryName={guest.name} />}
      {isAdmin && !oidc && (
        <> Switch this guest to OIDC mode (save its callback URLs first), then adopt it from here.</>
      )}
      {!isAdmin && <> An admin can adopt it.</>}
    </div>
  );
}

// sync-authentik left this guest's Authentik state as it was (FR-015): the
// save itself succeeded, but the gate did not change as asked.
export function AuthentikSkipBanner({ skipped }: { skipped: AuthentikSkip[] }) {
  if (skipped.length === 0) return null;
  return (
    <div className="warning-banner">
      Authentik was not updated for this app: {skipped.map((s) => s.reason).join('; ')}
    </div>
  );
}
