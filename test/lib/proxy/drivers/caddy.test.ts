// Characterization test for issue #10 (reverse-proxy driver interface):
// pins the pre-refactor `buildCaddyBlock` output byte-for-byte, so the
// Caddy driver provably renders exactly what the old generator did. Its
// fixture shape and expected output must never change. See
// specs/006-reverse-proxy-driver/data-model.md "Characterization fixture".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../../../src/lib/inventory.ts';
import { buildRoutes, buildProxyContext } from '../../../../src/lib/proxy/routes.ts';
import { caddyDriver, render } from '../../../../src/lib/proxy/drivers/caddy.ts';
import { wrapManagedSection } from '../../../../src/lib/proxy/file-driver.ts';
import { FakeSSHClient } from '../../../support/fake-ssh-client.ts';

// The pre-refactor buildCaddyBlock's single-string output, rebuilt from the
// driver pipeline: render() returns only the block's body, and fileDriver
// wraps it in the bellhop-managed markers -- the same text plan() previews
// and apply() writes (the last test in this file checks plan() directly).
function buildCaddyBlock(inventory: Inventory): string {
  const routes = buildRoutes(inventory);
  const ctx = buildProxyContext(inventory);
  return wrapManagedSection(render(routes, ctx, '/etc/caddy/Caddyfile')[0].content);
}

// buildCaddyBlock reads authentikConfig().outpostPort from
// AUTHENTIK_OUTPOST_PORT, so it's pinned here (and restored after) rather
// than left to whatever the developer's shell happens to have set --
// same convention as the "sync-proxy emits the configured Authentik
// outpost port" test in test/commands/sync-proxy.test.ts.
const ORIGINAL_OUTPOST_PORT = process.env.AUTHENTIK_OUTPOST_PORT;

function withPinnedOutpostPort(fn: () => void): void {
  process.env.AUTHENTIK_OUTPOST_PORT = '9000';
  try {
    fn();
  } finally {
    if (ORIGINAL_OUTPOST_PORT === undefined) delete process.env.AUTHENTIK_OUTPOST_PORT;
    else process.env.AUTHENTIK_OUTPOST_PORT = ORIGINAL_OUTPOST_PORT;
  }
}

// Covers every shape data-model.md's "Characterization fixture" section
// lists:
//   - a host with two subdomains and insecureBackendTls: true -- pve2
//   - a guest with a non-default port -- media (8096)
//   - a guest with no port (defaults to 80) -- web-lxc
//   - an external site -- nas
//   - a forward-gated guest with no exempt paths -- app-lxc
//   - a forward-gated guest with exempt paths in both forms
//     (/health, /api/*) -- api-lxc
//   - an OIDC-mode gated guest with oidcRedirectUris -- sso-app-lxc
//   - a proxyManual entry with subdomains (no block) -- manual-lxc
//   - an entry with no subdomains (no block) -- internal-lxc
//   - the authentik: true guest with an ip -- auth-lxc
const inventory: Inventory = {
  domain: 'example.com',
  hosts: [
    { name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', proxy: true },
    {
      name: 'pve2',
      ssh_target: '192.0.2.2',
      ssh_user: 'root',
      ip: '198.51.100.10',
      port: 8006,
      subdomains: ['proxmox', 'pve-admin'],
      insecureBackendTls: true,
    },
  ],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.0.2.50', port: 8096, subdomains: ['media'] },
    { name: 'web-lxc', type: 'lxc', vmid: 106, host: 'pve1', ip: '192.0.2.51', subdomains: ['web'] },
    {
      name: 'app-lxc',
      type: 'lxc',
      vmid: 120,
      host: 'pve1',
      ip: '192.0.2.20',
      subdomains: ['app'],
      authGroup: 'bellhop-users',
    },
    {
      name: 'api-lxc',
      type: 'lxc',
      vmid: 121,
      host: 'pve1',
      ip: '192.0.2.21',
      subdomains: ['api'],
      authGroup: 'bellhop-users',
      unauthenticatedPaths: ['/health', '/api/*'],
    },
    {
      name: 'sso-app-lxc',
      type: 'lxc',
      vmid: 122,
      host: 'pve1',
      ip: '192.0.2.22',
      subdomains: ['dash'],
      authGroup: 'bellhop-users',
      authMode: 'oidc',
      oidcRedirectUris: ['https://dash.example.com/oauth/callback'],
    },
    {
      name: 'manual-lxc',
      type: 'lxc',
      vmid: 123,
      host: 'pve1',
      ip: '192.0.2.23',
      subdomains: ['manual'],
      proxyManual: true,
    },
    { name: 'internal-lxc', type: 'lxc', vmid: 124, host: 'pve1', ip: '192.0.2.24' },
    { name: 'auth-lxc', type: 'lxc', vmid: 130, host: 'pve1', ip: '192.0.2.9', authentik: true },
  ],
  externalSites: [{ name: 'nas', ip: '198.51.100.20', port: 5001, subdomains: ['nas'] }],
};

// Captured verbatim from the current (pre-refactor) buildCaddyBlock's
// output against the fixture above, with AUTHENTIK_OUTPOST_PORT pinned to
// '9000'.
const EXPECTED_LINES = [
  '# BEGIN bellhop-managed',
  'proxmox.example.com, pve-admin.example.com {',
  '    reverse_proxy 198.51.100.10:8006 {',
  '        header_up X-Forwarded-Port 443',
  '        transport http {',
  '            tls_insecure_skip_verify',
  '        }',
  '    }',
  '    tls {',
  '        dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
  '        resolvers 1.1.1.1 8.8.8.8',
  '    }',
  '}',
  'media.example.com {',
  '    reverse_proxy 192.0.2.50:8096 {',
  '        header_up X-Forwarded-Port 443',
  '    }',
  '    tls {',
  '        dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
  '        resolvers 1.1.1.1 8.8.8.8',
  '    }',
  '}',
  'web.example.com {',
  '    reverse_proxy 192.0.2.51:80 {',
  '        header_up X-Forwarded-Port 443',
  '    }',
  '    tls {',
  '        dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
  '        resolvers 1.1.1.1 8.8.8.8',
  '    }',
  '}',
  'app.example.com {',
  '    reverse_proxy 192.0.2.20:80 {',
  '        header_up X-Forwarded-Port 443',
  '    }',
  '    forward_auth 192.0.2.9:9000 {',
  '        uri /outpost.goauthentik.io/auth/caddy',
  '        copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email X-Authentik-Name X-Authentik-Uid',
  '    }',
  '    handle /outpost.goauthentik.io/* {',
  '        reverse_proxy 192.0.2.9:9000',
  '    }',
  '    tls {',
  '        dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
  '        resolvers 1.1.1.1 8.8.8.8',
  '    }',
  '}',
  'api.example.com {',
  '    reverse_proxy 192.0.2.21:80 {',
  '        header_up X-Forwarded-Port 443',
  '    }',
  '    @auth_required {',
  '        not path /health /api/*',
  '    }',
  '    forward_auth @auth_required 192.0.2.9:9000 {',
  '        uri /outpost.goauthentik.io/auth/caddy',
  '        copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email X-Authentik-Name X-Authentik-Uid',
  '    }',
  '    handle /outpost.goauthentik.io/* {',
  '        reverse_proxy 192.0.2.9:9000',
  '    }',
  '    tls {',
  '        dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
  '        resolvers 1.1.1.1 8.8.8.8',
  '    }',
  '}',
  'dash.example.com {',
  '    reverse_proxy 192.0.2.22:80 {',
  '        header_up X-Forwarded-Port 443',
  '    }',
  '    tls {',
  '        dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
  '        resolvers 1.1.1.1 8.8.8.8',
  '    }',
  '}',
  'nas.example.com {',
  '    reverse_proxy 198.51.100.20:5001 {',
  '        header_up X-Forwarded-Port 443',
  '    }',
  '    tls {',
  '        dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
  '        resolvers 1.1.1.1 8.8.8.8',
  '    }',
  '}',
  '# END bellhop-managed',
];

test('buildCaddyBlock output is pinned byte-for-byte against the full characterization fixture (issue #10)', () => {
  withPinnedOutpostPort(() => {
    const block = buildCaddyBlock(inventory);
    assert.equal(block, EXPECTED_LINES.join('\n'));
  });
});

test('buildCaddyBlock throws the missing-authentik error text when a forward-gated entry has no authentik:true ip', () => {
  const inv: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', proxy: true }],
    guests: [
      {
        name: 'app-lxc',
        type: 'lxc',
        vmid: 120,
        host: 'pve1',
        ip: '192.0.2.20',
        subdomains: ['app'],
        authGroup: 'bellhop-users',
      },
    ],
  };
  assert.throws(
    () => buildCaddyBlock(inv),
    /^Error: Entry 'app-lxc' has an 'authGroup' set but no inventory entry has 'authentik: true' with an ip set$/
  );
});

test('render returns only the body; the bellhop-managed markers come from fileDriver', () => {
  withPinnedOutpostPort(() => {
    const [file] = render(buildRoutes(inventory), buildProxyContext(inventory), '/etc/caddy/Caddyfile');
    assert.equal(file.mode, 'managed-section');
    assert.equal(file.content, EXPECTED_LINES.slice(1, -1).join('\n'));
  });
});

test('caddyDriver.plan previews and carries exactly the pinned block', async () => {
  process.env.AUTHENTIK_OUTPOST_PORT = '9000';
  try {
    const deps = {
      ssh: new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 })),
      inventory,
      proxyHost: 'pve1',
      configPath: '/etc/caddy/Caddyfile',
    };
    const plan = await caddyDriver.plan(buildRoutes(inventory), buildProxyContext(inventory), deps);
    assert.equal(plan.preview, EXPECTED_LINES.join('\n'));
    assert.deepEqual(plan.payload, [{ path: '/etc/caddy/Caddyfile', content: EXPECTED_LINES.join('\n'), mode: 'managed-section' }]);
  } finally {
    if (ORIGINAL_OUTPOST_PORT === undefined) delete process.env.AUTHENTIK_OUTPOST_PORT;
    else process.env.AUTHENTIK_OUTPOST_PORT = ORIGINAL_OUTPOST_PORT;
  }
});

// --- issue #51: proxyCaddyTls ----------------------------------------------
// Every mode renders the same characterization block with only the per-site
// TLS clause swapped (contracts/rendering-and-settings.md "Caddyfile per-site
// TLS clause"). The cloudflare clause is the four lines EXPECTED_LINES
// carries after each site's directives; these helpers rebuild the expected
// block from EXPECTED_LINES with that clause replaced, so the other modes
// are pinned against exactly the same routes the characterization pins.
const CLOUDFLARE_CLAUSE = [
  '    tls {',
  '        dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
  '        resolvers 1.1.1.1 8.8.8.8',
  '    }',
];

function expectedWithClause(clause: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < EXPECTED_LINES.length; i++) {
    if (EXPECTED_LINES.slice(i, i + CLOUDFLARE_CLAUSE.length).join('\n') === CLOUDFLARE_CLAUSE.join('\n')) {
      out.push(...clause);
      i += CLOUDFLARE_CLAUSE.length - 1;
    } else {
      out.push(EXPECTED_LINES[i]);
    }
  }
  return out.join('\n');
}

function blockFor(inv: Inventory): string {
  let block = '';
  withPinnedOutpostPort(() => {
    block = buildCaddyBlock(inv);
  });
  return block;
}

test('proxyCaddyTls cloudflare renders exactly the characterization block (unset = cloudflare)', () => {
  assert.equal(blockFor({ ...inventory, proxyCaddyTls: 'cloudflare' }), EXPECTED_LINES.join('\n'));
});

test('proxyCaddyTls letsencrypt renders the same block with every TLS clause removed', () => {
  const block = blockFor({ ...inventory, proxyCaddyTls: 'letsencrypt' });
  assert.equal(block, expectedWithClause([]));
  assert.doesNotMatch(block, /\btls\b/);
});

test('proxyCaddyTls internal renders `tls internal` in place of the Cloudflare clause', () => {
  assert.equal(blockFor({ ...inventory, proxyCaddyTls: 'internal' }), expectedWithClause(['    tls internal']));
});

test('proxyCaddyTls files renders the domain-derived certificate/key paths by default', () => {
  assert.equal(
    blockFor({ ...inventory, proxyCaddyTls: 'files' }),
    expectedWithClause(['    tls /etc/letsencrypt/live/example.com/fullchain.pem /etc/letsencrypt/live/example.com/privkey.pem'])
  );
});

test('proxyCaddyTls files uses proxyTlsCertificate/proxyTlsKey when set', () => {
  assert.equal(
    blockFor({
      ...inventory,
      proxyCaddyTls: 'files',
      proxyTlsCertificate: '/etc/ssl/example/cert.pem',
      proxyTlsKey: '/etc/ssl/example/key.pem',
    }),
    expectedWithClause(['    tls /etc/ssl/example/cert.pem /etc/ssl/example/key.pem'])
  );
});

test('proxyCaddyTls files double-quotes a path holding whitespace, a double quote or a backslash, escaping only the quote (research R6)', () => {
  const block = blockFor({
    ...inventory,
    proxyCaddyTls: 'files',
    proxyTlsCertificate: '/etc/ssl/my certs/cert.pem',
    // a"b\c -- one double quote and one backslash. Live-verified against
    // Caddy v2.10.2 `caddy adapt`: inside a quoted token only \" is an
    // escape, so the backslash goes out as-is (a doubled one adapts to two).
    proxyTlsKey: String.raw`/etc/ssl/a"b\c/key.pem`,
  });
  assert.equal(block, expectedWithClause([String.raw`    tls "/etc/ssl/my certs/cert.pem" "/etc/ssl/a\"b\c/key.pem"`]));
});

test('a path with a backslash but no whitespace or double quote is quoted, its backslash left single (research R6)', () => {
  const block = blockFor({ ...inventory, proxyCaddyTls: 'files', proxyTlsCertificate: String.raw`/etc/ssl/a\b.pem` });
  assert.ok(block.includes(String.raw`    tls "/etc/ssl/a\b.pem" /etc/letsencrypt/live/example.com/privkey.pem`));
});

test('caddyDriver declares usesCaddyTls for the Settings page', () => {
  assert.equal(caddyDriver.usesCaddyTls, true);
});
