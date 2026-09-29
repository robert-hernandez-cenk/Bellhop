// Issue #26: the admin-API Caddy driver's remote calls. Responses are the
// real Caddy v2.10.2 captures in test/fixtures/caddy/ (see its README).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Inventory } from '../../../src/lib/inventory.ts';
import {
  buildReadCommand,
  buildWriteCommand,
  caddyfileModeMessage,
  parseReadOutput,
  parseWriteOutput,
  readCaddyConfig,
  writeCaddyConfig,
} from '../../../src/lib/proxy/caddy-admin.ts';
import { FakeSSHClient } from '../../support/fake-ssh-client.ts';

const FIXTURES = new URL('../../fixtures/caddy/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');

const inventory: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
  guests: [{ name: 'proxy-lxc', type: 'lxc', vmid: 110, host: 'pve1', ip: '192.0.2.10', proxy: true }],
};

function deps(stdout: string, code = 0, stderr = '') {
  const ssh = new FakeSSHClient(() => ({ stdout, stderr, code }));
  return { ssh, inventory, proxyHost: 'proxy-lxc' };
}

test('the read command checks the Caddyfile unit only when asked, then reads /config/ with headers', () => {
  assert.equal(
    buildReadCommand({ checkService: true }),
    [
      'if systemctl is-active --quiet caddy.service 2>/dev/null; then exit 3; fi',
      'command -v curl >/dev/null 2>&1 || exit 4',
      'curl -sS -D - http://localhost:2019/config/',
    ].join('\n')
  );
  assert.equal(
    buildReadCommand({ checkService: false }),
    ['command -v curl >/dev/null 2>&1 || exit 4', 'curl -sS -D - http://localhost:2019/config/'].join('\n')
  );
});

test('the write command PATCHes the compact config with If-Match from a quoted heredoc', () => {
  const command = buildWriteCommand({ apps: { note: "it's $HOME" } }, '"/config/ 5fa1bc684323e7a0"');
  assert.equal(
    command,
    [
      'command -v curl >/dev/null 2>&1 || exit 4',
      `curl -sS -X PATCH -H 'Content-Type: application/json' -H 'If-Match: "/config/ 5fa1bc684323e7a0"' --data-binary @- -w '\\nBELLHOP_HTTP_STATUS=%{http_code}\\n' http://localhost:2019/config/ <<'BELLHOP_CADDY_CONFIG'`,
      `{"apps":{"note":"it's $HOME"}}`,
      'BELLHOP_CADDY_CONFIG',
    ].join('\n')
  );
});

test('parses captured GET responses: status, Etag, and body', () => {
  assert.deepEqual(parseReadOutput(fixture('get-config-empty.txt')), {
    status: 200,
    etag: '"/config/ 396548453caeba50"',
    body: 'null\n',
  });
  const routes = parseReadOutput(fixture('get-config-routes.txt'));
  assert.equal(routes.etag, '"/config/ 5fa1bc684323e7a0"');
  assert.equal(JSON.parse(routes.body).apps.http.servers.srv0.listen[0], ':443');
});

test('parses captured write responses', () => {
  assert.deepEqual(parseWriteOutput(fixture('patch-200.txt')), { status: 200, body: '' });
  assert.equal(parseWriteOutput(fixture('patch-412.txt')).status, 412);
  assert.equal(parseWriteOutput(fixture('patch-500.txt')).status, 500);
});

test('readCaddyConfig returns the validated config and Etag, run on the proxy host', async () => {
  const d = deps(fixture('get-config-routes.txt'));
  const live = await readCaddyConfig(d, { checkService: true });
  assert.equal(live.etag, '"/config/ 5fa1bc684323e7a0"');
  assert.ok(live.config?.apps?.http?.servers?.srv0);
  assert.equal(d.ssh.history.length, 1);
  assert.match(d.ssh.history[0].command, /^pct exec 110 -- sh -c /);
});

test('readCaddyConfig on an empty Caddy returns null', async () => {
  const live = await readCaddyConfig(deps(fixture('get-config-empty.txt')), { checkService: false });
  assert.equal(live.config, null);
});

test('read failures name the host and the fix (FR-010, FR-011)', async () => {
  await assert.rejects(readCaddyConfig(deps('', 3), { checkService: true }), { message: caddyfileModeMessage('proxy-lxc') });
  assert.match(
    caddyfileModeMessage('proxy-lxc'),
    /^Caddy on 'proxy-lxc' is running from a Caddyfile \(caddy\.service is active\); .*'bellhop convert-caddyfile --apply'/
  );
  await assert.rejects(readCaddyConfig(deps('', 4), { checkService: true }), {
    message: "curl is not installed on 'proxy-lxc'; the caddy-api proxy driver needs it to reach Caddy's admin API at localhost:2019.",
  });
  await assert.rejects(
    readCaddyConfig(deps('', 7, "curl: (7) Failed to connect to localhost port 2019 after 0 ms: Couldn't connect to server"), {
      checkService: true,
    }),
    {
      message:
        "Could not read Caddy's configuration from the admin API at localhost:2019 on 'proxy-lxc': curl: (7) Failed to connect to localhost port 2019 after 0 ms: Couldn't connect to server",
    }
  );
  await assert.rejects(readCaddyConfig(deps('HTTP/1.1 403 Forbidden\r\n\r\n{"error":"host not allowed"}'), { checkService: true }), {
    message: "Caddy's admin API on 'proxy-lxc' answered 403 reading /config/: host not allowed",
  });
  await assert.rejects(readCaddyConfig(deps('HTTP/1.1 200 OK\r\n\r\nnull'), { checkService: true }), /needs Caddy 2\.6 or newer/);
});

test('writeCaddyConfig succeeds on 200 and maps 412/500 to the contract messages (FR-004, FR-005)', async () => {
  await writeCaddyConfig(deps(fixture('patch-200.txt')), { apps: {} }, '"/config/ 1"');
  await assert.rejects(writeCaddyConfig(deps(fixture('patch-412.txt')), { apps: {} }, '"/config/ 1"'), {
    message: "Caddy's configuration on 'proxy-lxc' changed after it was read; nothing was written. Run the sync again.",
  });
  await assert.rejects(writeCaddyConfig(deps(fixture('patch-500.txt')), { apps: {} }, '"/config/ 1"'), {
    message:
      "Caddy on 'proxy-lxc' rejected the new configuration (500); its previous configuration is still running: loading new config: loading http app module: provision http: server srv0: setting up route handlers: route 0: loading handler modules: position 0: loading module 'nope': unknown module: http.handlers.nope",
  });
});
