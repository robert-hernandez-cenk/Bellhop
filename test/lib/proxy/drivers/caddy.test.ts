// Characterization test for issue #10 (reverse-proxy driver interface):
// pins today's `buildCaddyBlock` output byte-for-byte before it's moved
// behind a driver interface. The import and field names are the only
// things expected to change as later tasks land -- this test's fixture
// shape and expected output must otherwise keep passing unmodified. See
// specs/006-reverse-proxy-driver/data-model.md "Characterization fixture".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../../../src/lib/inventory.ts';
import { buildRoutes, buildProxyContext } from '../../../../src/lib/proxy/routes.ts';
import { render } from '../../../../src/lib/proxy/drivers/caddy.ts';

// buildCaddyBlock itself is gone from the former src/commands/networking/
// sync-caddy.ts (now sync-proxy.ts) as of T010 (it now delegates to this
// same buildRoutes/buildProxyContext/render pipeline) -- this helper
// reproduces its old single-string return shape so the rest of this file
// (written against that shape) needs no other changes, per T010's "import
// and call path only" instruction.
function buildCaddyBlock(inventory: Inventory): string {
  const routes = buildRoutes(inventory);
  const ctx = buildProxyContext(inventory);
  return render(routes, ctx, '/etc/caddy/Caddyfile')[0].content;
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
