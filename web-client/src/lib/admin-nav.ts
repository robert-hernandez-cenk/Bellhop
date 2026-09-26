export interface AdminNavLink {
  to: string;
  label: string;
}

// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same rationale as
// whoami-store.ts. Settings needs only an identity (isAdmin); Users and
// Permissions also need Authentik's REST API (hasDirectory) -- see
// contracts/ui-and-messages.md.
export function adminNavLinks(isAdmin: boolean, hasDirectory: boolean): AdminNavLink[] {
  if (!isAdmin) return [];
  const links: AdminNavLink[] = [];
  if (hasDirectory) {
    links.push({ to: '/users', label: 'Users' });
    links.push({ to: '/permissions', label: 'Permissions' });
  }
  links.push({ to: '/settings', label: 'Settings' });
  return links;
}
