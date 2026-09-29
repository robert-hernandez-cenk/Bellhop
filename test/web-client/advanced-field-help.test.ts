import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADVANCED_FIELD_HELP } from '../../web-client/src/lib/advanced-field-help.ts';

// Pins the 15 label -> explanation entries in
// specs/011-advanced-field-help/contracts/field-help.md verbatim.

const CONTRACT: Record<string, string> = {
  type: 'Whether this guest is an LXC container (lxc) or a virtual machine (vm), as reported by Proxmox. Update All and package installs never act on a VM.',
  ip: "The guest's LAN address, which the proxy forwards this guest's subdomains to. Sync Inventory refreshes it from the guest's Proxmox network config.",
  subdomains:
    "The hostnames the reverse proxy serves for this guest, all forwarding to its ip and port. The first one is canonical and also names the guest's Authentik application when it is gated.",
  host: 'The Proxmox node this guest runs on; Bellhop reaches the guest through this host over SSH. Move a guest to another host with Migrate Guest, not here.',
  vmid: "The guest's Proxmox ID, unique across the whole cluster. Bellhop derives it from the host's machine ID scheme when it creates a guest.",
  port: "The port the guest's app listens on, which the proxy forwards to. Left empty, the proxy uses port 80.",
  'read-only proxy':
    "The proxy block for this guest is hand-written outside Bellhop's managed section, so Sync Proxy leaves it alone. Authentik gating still applies: its application and group bindings are still kept in sync.",
  'insecure backend tls':
    "Lets the proxy reach a backend that serves HTTPS with a self-signed or otherwise untrusted certificate. Set automatically when Bellhop checks the backend's TLS after a subdomain or port change, overriding what is ticked here.",
  'auth group':
    'Puts the app behind an Authentik login that members of this group, and of every group above it, can pass. Anyone who can edit this guest may raise it, but only an admin may lower it or remove the gate.',
  'auth mode':
    'How the auth group is enforced: forward-auth checks the login at the proxy, while OIDC gives the app its own Authentik login client. Only an admin may change it, and switching away from OIDC deletes that client.',
  'callback urls':
    'The addresses Authentik may send a user back to after an OIDC login. No effect unless the guest is gated in OIDC mode, and only an admin may change them.',
  'oidc client':
    'The issuer, client ID and client secret the app needs for its OIDC login, read live from Authentik. Only admins can reveal them.',
  'unauthenticated paths':
    'Paths that skip the login check, written exactly or ending in /*, such as an API another app calls. No effect unless the guest is gated with forward-auth and read-only proxy is off.',
  vpn: "Routes the guest's internet traffic through a VPN gateway guest, or through the LAN gateway when set to none. Changing it starts a job that reboots the guest.",
  app: "The community-scripts app this guest was installed from, recorded when Bellhop installed it. The link opens the app's community-scripts page, or its script in your custom script repository.",
};

test('ADVANCED_FIELD_HELP equals the 15 contract entries verbatim', () => {
  assert.deepEqual(ADVANCED_FIELD_HELP, CONTRACT);
});

test('every explanation is non-empty and has one or two sentences', () => {
  for (const [field, text] of Object.entries(ADVANCED_FIELD_HELP)) {
    assert.ok(text.trim().length > 0, `${field} explanation is empty`);
    const parts = text
      .trim()
      .split(/[.!?](\s|$)/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    assert.ok(
      parts.length >= 1 && parts.length <= 2,
      `${field} explanation has ${parts.length} sentences, expected 1 or 2`,
    );
  }
});

test('FR-003 facts appear in the relevant explanations', () => {
  const readOnlyProxy = ADVANCED_FIELD_HELP['read-only proxy'];
  assert.match(readOnlyProxy, /hand-written/);
  assert.match(readOnlyProxy, /managed section/);
  assert.match(readOnlyProxy, /Authentik gating still applies/);

  const insecureBackendTls = ADVANCED_FIELD_HELP['insecure backend tls'];
  assert.match(insecureBackendTls, /automatically/);

  const unauthenticatedPaths = ADVANCED_FIELD_HELP['unauthenticated paths'];
  assert.match(unauthenticatedPaths, /No effect unless/);
  assert.match(unauthenticatedPaths, /forward-auth/);

  const callbackUrls = ADVANCED_FIELD_HELP['callback urls'];
  assert.match(callbackUrls, /No effect unless/);
  assert.match(callbackUrls, /OIDC mode/);
});

// US1: every label rendered by AdvancedGuestModal.tsx must go through the
// modal's local fieldHelp('<label>') helper with a label matching a key in
// ADVANCED_FIELD_HELP, and no bare (unwrapped) form-row-label may remain
// (SC-005).

const modalPath = new URL('../../web-client/src/components/AdvancedGuestModal.tsx', import.meta.url);
const modalSource = readFileSync(modalPath, 'utf8');

function collectFieldHelpFields(source: string): string[] {
  const fields: string[] = [];
  const re = /fieldHelp\('([^']+)'\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    fields.push(match[1]);
  }
  return fields;
}

function collectBareLabels(source: string): string[] {
  const bare: string[] = [];
  // A label is wrapped only when its whole content is one fieldHelp('...')
  // call; anything else (plain text, or text beside the call) is bare.
  const re = /<div className="form-row-label">([\s\S]*?)<\/div>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const content = match[1].trim();
    if (!/^\{fieldHelp\('[^']+'\)\}$/.test(content)) bare.push(content);
  }
  return bare;
}

test('every form-row-label in AdvancedGuestModal.tsx is wrapped by fieldHelp(), one per ADVANCED_FIELD_HELP key, no bare labels (SC-005)', () => {
  const fields = collectFieldHelpFields(modalSource);
  const bareLabels = collectBareLabels(modalSource);

  assert.deepEqual(new Set(fields), new Set(Object.keys(ADVANCED_FIELD_HELP)));
  assert.equal(fields.length, new Set(fields).size, 'duplicate fieldHelp() labels found');
  assert.deepEqual(bareLabels, [], 'bare form-row-label divs found, not wrapped by FieldHelp');
});
