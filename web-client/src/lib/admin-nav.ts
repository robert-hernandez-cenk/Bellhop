export interface AdminNavLink {
  to: string;
  label: string;
}

// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same rationale as
// whoami-store.ts. Settings and Tasks need only an identity (isAdmin);
// Users and Permissions also need Authentik's REST API (hasDirectory) --
// see contracts/ui-and-messages.md.
export function adminNavLinks(isAdmin: boolean, hasDirectory: boolean): AdminNavLink[] {
  if (!isAdmin) return [];
  const links: AdminNavLink[] = [];
  if (hasDirectory) {
    links.push({ to: '/users', label: 'Users' });
    links.push({ to: '/permissions', label: 'Permissions' });
  }
  links.push({ to: '/tasks', label: 'Tasks' });
  links.push({ to: '/settings', label: 'Settings' });
  return links;
}

// The Sidebar's warning when no identity provider is in play (the local
// operator). Since issue #64 the sign-in mode is a stored setting, so the
// fix named first is the Settings page's own field; the environment
// variable still overrides it and stays the alternative.
export const NO_AUTH_BANNER_TEXT =
  'No authentication configured — everyone who can reach this page has full access. Set Web UI sign-in (webUiAuthMode) to authentik on the Settings page, or WEB_UI_AUTH_MODE=authentik in the service environment, once an identity provider is in place.';
