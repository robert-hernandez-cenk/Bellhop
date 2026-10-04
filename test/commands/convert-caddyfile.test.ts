// Issue #26 (spec User Story 5, FR-015): the one-time Caddyfile -> admin-API
// conversion. Responses are the real Caddy v2.10.2 captures in
// test/fixtures/caddy/ (see its README).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Inventory } from '../../src/lib/inventory.ts';
import {
  buildAdaptCommand,
  formatConvertCaddyfile,
  nextSteps,
  runConvertCaddyfile,
} from '../../src/commands/networking/convert-caddyfile.ts';
import { planCaddyConfig } from '../../src/lib/proxy/caddy-json.ts';
import { buildRoutes, buildProxyContext } from '../../src/lib/proxy/routes.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';
import type { ExecResult } from '../../src/lib/ssh-client.ts';

const FIXTURES = new URL('../fixtures/caddy/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');
const adaptedText = fixture('convert-adapted.json');
const adapted = JSON.parse(adaptedText);

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root', proxy: true }],
  guests: [
    { name: 'media', type: 'lxc', vmid: 105, host: 'pve1', ip: '192.0.2.50', port: 8096, subdomains: ['media'] },
    { name: 'web-lxc', type: 'lxc', vmid: 106, host: 'pve1', ip: '192.0.2.51', subdomains: ['web'] },
  ],
};

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

// The live Caddy (still running from its Caddyfile) answers GET /config/;
// the adapt command answers with `adapt`; the PATCH with `write`.
function fakeProxyHost(opts: { live?: string; adapt?: ExecResult; write?: string } = {}) {
  return new FakeSSHClient((_t, _u, command) => {
    if (command.includes('caddy adapt')) return opts.adapt ?? ok(adaptedText);
    if (command.includes('-X PATCH')) return ok(opts.write ?? fixture('patch-200.txt'));
    return ok(opts.live ?? fixture('get-config-routes.txt'));
  });
}

test('the adapt command strips the managed section into a temp file beside the Caddyfile', () => {
  assert.equal(
    buildAdaptCommand('/etc/caddy/Caddyfile'),
    [
      "F='/etc/caddy/Caddyfile'",
      '[ -f "$F" ] || exit 5',
      'T="$(mktemp "$(dirname "$F")/.bellhop-convert.XXXXXX")"',
      `trap 'rm -f "$T"' EXIT`,
      `sed '/# BEGIN bellhop-managed/,/# END bellhop-managed/d' "$F" > "$T"`,
      `if grep -q '[^[:space:]]' "$T"; then caddy adapt --adapter caddyfile --config "$T"; else echo null; fi`,
    ].join('\n')
  );
});

test('a dry run reads and adapts, previews what it keeps and adds, and writes nothing', async () => {
  const ssh = fakeProxyHost();
  const result = await runConvertCaddyfile({}, { ssh, inventory });
  assert.equal(result.applied, false);
  assert.equal(result.caddyfile, '/etc/caddy/Caddyfile');
  assert.match(result.preview, /^Hand-authored configuration kept from \/etc\/caddy\/Caddyfile:\n {2}server srv0 \(:443\): 1 route$/m);
  assert.match(result.preview, /^\+ route media\.example\.com -> 192\.0\.2\.50:8096$/m);
  assert.equal(ssh.history.length, 2);
  assert.ok(!ssh.history.some((h) => h.command.includes('PATCH')));
  assert.ok(!ssh.history.some((h) => h.command.includes('systemctl')), 'the conversion runs while caddy.service is still active');
});

test('apply loads the adapted config plus Bellhop routes against the live Etag, then prints the next steps', async () => {
  const ssh = fakeProxyHost();
  const result = await runConvertCaddyfile({ apply: true }, { ssh, inventory });
  assert.equal(result.applied, true);
  const write = ssh.history.find((h) => h.command.includes('-X PATCH'));
  assert.ok(write);
  assert.match(write.command, /If-Match: "\/config\/ 5fa1bc684323e7a0"/);
  const expected = planCaddyConfig(adapted, buildRoutes(inventory), buildProxyContext(inventory), 'pve1').config;
  assert.deepEqual(JSON.parse(write.command.split('\n')[2]), expected);
  assert.match(formatConvertCaddyfile(result), new RegExp(nextSteps('pve1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('refuses once Caddy already holds Bellhop objects', async () => {
  const converted = planCaddyConfig(adapted, buildRoutes(inventory), buildProxyContext(inventory), 'pve1').config;
  const live = `HTTP/1.1 200 OK\r\nEtag: "/config/ 2"\r\n\r\n${JSON.stringify(converted)}`;
  const ssh = fakeProxyHost({ live });
  await assert.rejects(runConvertCaddyfile({ apply: true }, { ssh, inventory }), {
    message:
      "Caddy's configuration on 'pve1' already has Bellhop objects; convert-caddyfile is only for the first switch. Use 'bellhop sync-proxy' instead.",
  });
  assert.equal(ssh.history.length, 1);
});

// Final review F10: a 'files'-mode leftover -- a Bellhop-tagged load_files
// entry, or a Bellhop connection policy on any server -- is Bellhop's too,
// even with no Bellhop route or automation policy left beside it.
for (const [what, add] of [
  [
    'a Bellhop load_files entry',
    (c: typeof adapted) => {
      c.apps.tls = {
        certificates: {
          load_files: [{ '@id': 'bellhop-tls-files', certificate: '/etc/ssl/example/cert.pem', key: '/etc/ssl/example/key.pem', tags: ['bellhop-cert'] }],
        },
      };
    },
  ],
  [
    'a Bellhop connection policy on a non-HTTPS server',
    (c: typeof adapted) => {
      c.apps.http.servers.srv1 = { listen: [':8080'], routes: [], tls_connection_policies: [{ '@id': 'bellhop-tls-default' }] };
    },
  ],
] as const) {
  test(`refuses once Caddy already holds ${what}`, async () => {
    const config = JSON.parse(adaptedText);
    add(config);
    const live = `HTTP/1.1 200 OK\r\nEtag: "/config/ 2"\r\n\r\n${JSON.stringify(config)}`;
    const ssh = fakeProxyHost({ live });
    await assert.rejects(runConvertCaddyfile({ apply: true }, { ssh, inventory }), /already has Bellhop objects/);
    assert.equal(ssh.history.length, 1);
  });
}
test('a missing Caddyfile or an adapt failure names the path and host', async () => {
  await assert.rejects(runConvertCaddyfile({ caddyfile: '/srv/Caddyfile' }, { ssh: fakeProxyHost({ adapt: { stdout: '', stderr: '', code: 5 } }), inventory }), {
    message: "No Caddyfile at /srv/Caddyfile on 'pve1' -- pass --caddyfile <path>.",
  });
  const adapt = { stdout: '', stderr: 'Error: adapting config using caddyfile: /etc/caddy/Caddyfile:3: unrecognized directive: nope', code: 1 };
  await assert.rejects(runConvertCaddyfile({}, { ssh: fakeProxyHost({ adapt }), inventory }), {
    message:
      "caddy adapt could not convert /etc/caddy/Caddyfile on 'pve1': Error: adapting config using caddyfile: /etc/caddy/Caddyfile:3: unrecognized directive: nope",
  });
});

test('a Caddyfile holding only the managed section converts to Bellhop routes alone', async () => {
  const ssh = fakeProxyHost({ adapt: ok('null\n') });
  const result = await runConvertCaddyfile({ apply: true }, { ssh, inventory });
  assert.match(result.preview, /^Hand-authored configuration kept from \/etc\/caddy\/Caddyfile: none/m);
  const write = ssh.history.find((h) => h.command.includes('-X PATCH'));
  assert.ok(write);
  assert.deepEqual(Object.keys(JSON.parse(write.command.split('\n')[2]).apps.http.servers), ['srv0']);
});

test('a hand-authored site claiming an inventory hostname is a conflict, like sync-proxy', async () => {
  const withConflict = JSON.parse(adaptedText);
  withConflict.apps.http.servers.srv0.routes.push({ match: [{ host: ['web.example.com'] }], handle: [{ handler: 'static_response' }] });
  const ssh = fakeProxyHost({ adapt: ok(JSON.stringify(withConflict)) });
  const result = await runConvertCaddyfile({ apply: true }, { ssh, inventory });
  assert.equal(result.applied, true);
  assert.deepEqual(result.conflicts.map((c) => c.hostname), ['web.example.com']);
  assert.match(formatConvertCaddyfile(result), /Hostname 'web\.example\.com' for entry 'web-lxc' is already claimed/);
});

test('--caddyfile defaults to proxyConfigPath only while the caddy driver is active', async () => {
  const underCaddy = await runConvertCaddyfile({}, { ssh: fakeProxyHost(), inventory: { ...inventory, proxyConfigPath: '/srv/caddy/Caddyfile' } });
  assert.equal(underCaddy.caddyfile, '/srv/caddy/Caddyfile');
  const underNginx = await runConvertCaddyfile(
    {},
    { ssh: fakeProxyHost(), inventory: { ...inventory, proxyDriver: 'nginx', proxyConfigPath: '/etc/nginx/conf.d/bellhop.conf' } }
  );
  assert.equal(underNginx.caddyfile, '/etc/caddy/Caddyfile');
});
