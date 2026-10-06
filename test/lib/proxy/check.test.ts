// The read-only proxy check (issue #87, research R1/R2): every file-configured
// driver proves the live proxy without writing, backing up, restoring or
// reloading anything. Remote calls go through FakeSSHClient; the proxy runs
// in a guest, so the command arrives wrapped in `pct exec`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../../src/lib/inventory.ts';
import { FakeSSHClient, type FakeSSHResponder } from '../../support/fake-ssh-client.ts';
import { driverDeps } from '../../../src/lib/proxy/index.ts';
import type { ReverseProxyDriver } from '../../../src/lib/proxy/driver.ts';
import { caddyDriver } from '../../../src/lib/proxy/drivers/caddy.ts';
import { nginxDriver } from '../../../src/lib/proxy/drivers/nginx.ts';
import { haproxyDriver } from '../../../src/lib/proxy/drivers/haproxy.ts';
import { buildApiPing, traefikDriver } from '../../../src/lib/proxy/drivers/traefik.ts';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

function inv(overrides: Partial<Inventory> = {}): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.10', ssh_user: 'root' }],
    guests: [{ name: 'proxy-lxc', type: 'lxc', vmid: 101, host: 'pve1', ip: '192.0.2.30', proxy: true }],
    ...overrides,
  };
}

const pass: FakeSSHResponder = () => ({ stdout: '', stderr: '', code: 0 });
const fail = (code: number, stderr = ''): FakeSSHResponder => () => ({ stdout: '', stderr, code });

async function runCheck(driver: ReverseProxyDriver, inventory: Inventory, responder: FakeSSHResponder = pass) {
  const ssh = new FakeSSHClient(responder);
  const check = driver.check;
  assert.ok(check, `${driver.id} has a check`);
  const summary = await check.call(driver, driverDeps(inventory, ssh, driver));
  return { ssh, summary };
}

// What reached the guest, with the shell quoting of the `pct exec` wrapper
// undone so assertions read like the script.
const sent = (ssh: FakeSSHClient) => ssh.history.map((h) => h.command.replace(/'\\''/g, "'")).join('\n');

const FORBIDDEN = /\b(cp|mv|rm|mktemp|tee)\s|trap |cat >|reload|restart|sed -i/;

test('caddy: the Caddyfile must exist, then caddy validate runs against it', async () => {
  const { ssh, summary } = await runCheck(caddyDriver, inv());
  assert.equal(ssh.history.length, 1);
  assert.match(sent(ssh), /\[ -f '\/etc\/caddy\/Caddyfile' \]/);
  assert.match(sent(ssh), /caddy validate --adapter caddyfile --config '\/etc\/caddy\/Caddyfile'/);
  assert.match(summary, /Caddy/);
  assert.match(summary, /proxy-lxc/);
});

test('caddy: the proxyConfigPath setting decides which file is checked', async () => {
  const { ssh } = await runCheck(caddyDriver, inv({ proxyConfigPath: '/srv/caddy/Caddyfile' }));
  assert.match(sent(ssh), /\[ -f '\/srv\/caddy\/Caddyfile' \]/);
  assert.match(sent(ssh), /--config '\/srv\/caddy\/Caddyfile'/);
});

test("nginx: Bellhop's own file need not exist yet, so the directory is checked, then nginx -t", async () => {
  const { ssh } = await runCheck(nginxDriver, inv());
  assert.match(sent(ssh), /\[ -d '\/etc\/nginx\/conf\.d' \]/);
  assert.match(sent(ssh), /nginx -t/);
  assert.doesNotMatch(sent(ssh), /\[ -f /);
});

test('haproxy: the directory is checked, then the main config, adding bellhop.cfg only when it exists', async () => {
  const { ssh } = await runCheck(haproxyDriver, inv());
  assert.match(sent(ssh), /\[ -d '\/etc\/haproxy' \]/);
  assert.match(sent(ssh), /haproxy -c -f '?\/etc\/haproxy\/haproxy\.cfg'?/);
  assert.match(sent(ssh), /if \[ -f '\/etc\/haproxy\/bellhop\.cfg' \]/);
  assert.match(sent(ssh), /-f '\/etc\/haproxy\/bellhop\.cfg'/);
});

test('traefik without proxyApiUrl: the directory alone, no curl', async () => {
  const { ssh } = await runCheck(traefikDriver, inv());
  assert.match(sent(ssh), /\[ -d '\/etc\/traefik\/dynamic' \]/);
  assert.doesNotMatch(sent(ssh), /curl/);
});

test('traefik with proxyApiUrl: the API must answer HTTP 200', async () => {
  const { ssh } = await runCheck(traefikDriver, inv({ proxyApiUrl: 'http://192.0.2.30:8080' }));
  assert.match(sent(ssh), /\[ -d '\/etc\/traefik\/dynamic' \]/);
  assert.match(sent(ssh), /command -v curl/);
  assert.match(sent(ssh), /http:\/\/192\.0\.2\.30:8080\/api\/overview/);
  assert.match(sent(ssh), /"200"|= 200|= "200"/);
});

test('a missing path is named with the setting that controls it', async () => {
  await assert.rejects(
    () => runCheck(caddyDriver, inv(), fail(87)),
    (err: Error) => {
      assert.match(err.message, /\/etc\/caddy\/Caddyfile/);
      assert.match(err.message, /not found on 'proxy-lxc'/);
      assert.match(err.message, /bellhop set-config proxyConfigPath/);
      return true;
    }
  );
  await assert.rejects(
    () => runCheck(nginxDriver, inv(), fail(87)),
    /\/etc\/nginx\/conf\.d.*not found on 'proxy-lxc'/s
  );
});

test("the proxy's own validation output is shown when it fails, naming the entry", async () => {
  await assert.rejects(
    () => runCheck(nginxDriver, inv(), fail(1, 'nginx: [emerg] unexpected "}" in /etc/nginx/nginx.conf:12')),
    (err: Error) => {
      assert.match(err.message, /nginx/);
      assert.match(err.message, /'proxy-lxc'/);
      assert.match(err.message, /unexpected "\}" in \/etc\/nginx\/nginx\.conf:12/);
      return true;
    }
  );
});

test('every file driver issues exactly one read-only command: no write, backup, restore or reload', async () => {
  const cases: [ReverseProxyDriver, Partial<Inventory>][] = [
    [caddyDriver, {}],
    [nginxDriver, {}],
    [haproxyDriver, {}],
    [traefikDriver, {}],
    [traefikDriver, { proxyApiUrl: 'http://192.0.2.30:8080' }],
  ];
  for (const [driver, overrides] of cases) {
    const { ssh } = await runCheck(driver, inv(overrides));
    assert.equal(ssh.history.length, 1, `${driver.id}: one command`);
    assert.doesNotMatch(sent(ssh), FORBIDDEN, `${driver.id}: read-only`);
  }
});

// -- The Traefik API ping, executed under a real sh with only curl stubbed --

function runPing(curlBody: string | null, apiUrl = 'http://192.0.2.30:8080') {
  const dir = mkdtempSync(join(tmpdir(), 'bellhop-check-'));
  const stubs = mkdtempSync(join(tmpdir(), 'bellhop-check-stubs-'));
  if (curlBody !== null) {
    const curl = join(stubs, 'curl');
    writeFileSync(curl, `#!/bin/sh\n${curlBody}\n`);
    chmodSync(curl, 0o755);
  }
  const script = join(dir, 'ping.sh').split('\\').join('/');
  writeFileSync(script, buildApiPing(apiUrl));
  // Without a stub, PATH is only the empty stub dir plus sh's own, so curl is absent.
  const env = { ...process.env, PATH: curlBody !== null ? `${stubs}${delimiter}${process.env.PATH}` : stubs };
  return spawnSync('sh', [script], { env, encoding: 'utf8' });
}

test('buildApiPing, executed: HTTP 200 passes', (t) => {
  const result = runPing("printf '200'");
  if (result.error) return t.skip('sh not available');
  assert.equal(result.status, 0, result.stderr);
});

test('buildApiPing, executed: no answer (curl fails, 000) fails naming the API URL', (t) => {
  const result = runPing("printf '000'; exit 7");
  if (result.error) return t.skip('sh not available');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Traefik API at http:\/\/192\.0\.2\.30:8080 answered HTTP 000/);
});

test('buildApiPing, executed: another status fails naming it', (t) => {
  const result = runPing("printf '404'");
  if (result.error) return t.skip('sh not available');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /answered HTTP 404/);
});

test('buildApiPing: a missing curl is a named error before any request is made', () => {
  const script = buildApiPing('http://192.0.2.30:8080');
  assert.ok(script.indexOf('command -v curl') < script.indexOf('/api/overview'));
  assert.match(script, /curl is not installed on the proxy host/);
});

test("a validator's own exit code 3 is a failed check, not a missing path", async () => {
  await assert.rejects(
    () => runCheck(nginxDriver, inv(), fail(3, 'nginx: validation failed')),
    (err: Error) => {
      assert.match(err.message, /did not pass its check: nginx: validation failed/);
      assert.doesNotMatch(err.message, /not found/);
      return true;
    }
  );
});
