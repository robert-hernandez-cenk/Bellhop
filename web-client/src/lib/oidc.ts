// Small shared helpers for the native OIDC gating UI (issue #1), used by
// EditableAuthMode, EditableAuthGroup, and EditableUnauthenticatedPaths.
// web-client is a fully separate build with no imports from src/ (see
// CLAUDE.md's "sortInventoryForFile" precedent for this pattern), so these
// deliberately duplicate server-side logic/strings rather than importing them.

export interface OidcEntryLike {
  authGroup?: string | null;
  authMode?: 'forward' | 'oidc';
}

// "Effective OIDC" per the controller's frontend rule: an access tier is set
// AND the mode is 'oidc'. Mirrors the server's effectiveAuth() (src/lib/
// inventory.ts) -- an entry in OIDC mode with no authGroup is inert (edge
// case in specs/002-native-oidc-gating/spec.md), same as an authGroup-only
// entry defaults to forward-auth.
export function isOidcEffective(entry: OidcEntryLike): boolean {
  return !!entry.authGroup && entry.authMode === 'oidc';
}

// The server's PATCH /inventory/guests/:name (and the MCP edit_guest tool)
// rejects an edit that would delete a Bellhop-created OpenID client with a
// 400 whose message contains this substring
// (OIDC_CLIENT_DELETION_CONFIRMATION_ERROR in src/operations/edit-guest.ts).
// Used as a safety net so a save still opens the confirmation modal even if
// this build's own client-side isOidcEffective check somehow missed a case
// (e.g. a stale `guest` prop) -- FR-022a / U10 controller clarification.
export function needsOidcDeletionConfirmation(message: string): boolean {
  return message.includes('confirmOidcClientDeletion');
}
