import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runRenderStatusPage, statusPageSkipReason, buildStatusPageHtml } from '../../src/commands/networking/render-status-page.ts';
import { NO_PROXY_STATUS_PAGE_ERROR } from '../../src/lib/proxy/driver.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  statusPagePath: '/usr/share/caddy/index.html',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
  guests: [],
};

test('buildStatusPageHtml embeds both files in <pre> blocks, HTML-escaped', () => {
  const html = buildStatusPageHtml('domain: <b>example.com</b>', 'a.example.com & b.example.com {\n}');
  assert.match(html, /<pre>domain: &lt;b&gt;example\.com&lt;\/b&gt;<\/pre>/);
  assert.match(html, /<pre>a\.example\.com &amp; b\.example\.com \{\n\}<\/pre>/);
  assert.match(html, /<title>Homelab status<\/title>/);
  assert.match(html, /<h2>Deployed proxy configuration<\/h2>/);
});

test('runRenderStatusPage throws when no entry has proxy: true', async () => {
  const noProxy: Inventory = { ...inventory, hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }] };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runRenderStatusPage({}, { ssh, inventory: noProxy }, 'domain: example.com'),
    /No inventory entry has 'proxy: true'/
  );
});

test('runRenderStatusPage does not call ssh a second time (the write) when apply is not set', async () => {
  const calls: string[] = [];
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: 'the-live-caddyfile-content', stderr: '', code: 0 };
  });
  const result = await runRenderStatusPage({}, { ssh, inventory }, 'domain: example.com');
  assert.equal(result.applied, false);
  assert.equal(calls.length, 1, 'only the read (cat the deployed proxy config), no write');
  assert.match(calls[0], /cat '\/etc\/caddy\/Caddyfile'/);
  assert.match(result.html, /the-live-caddyfile-content/);
});

test('runRenderStatusPage writes the status page to the proxy host when apply is set', async () => {
  const calls: string[] = [];
  const ssh = new FakeSSHClient((_t, _u, c) => {
    calls.push(c);
    return { stdout: 'live-content', stderr: '', code: 0 };
  });
  const result = await runRenderStatusPage({ apply: true }, { ssh, inventory }, 'domain: example.com');
  assert.equal(result.applied, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /cat > '\/usr\/share\/caddy\/index\.html'/);
  assert.match(calls[1], /live-content/);
});

test('runRenderStatusPage throws when reading the deployed proxy configuration fails', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'no such file', code: 1 }));
  await assert.rejects(
    () => runRenderStatusPage({}, { ssh, inventory }, 'domain: example.com'),
    /Failed to read the deployed proxy configuration from 'pve1': no such file/
  );
});

test('runRenderStatusPage throws when writing the status page fails', async () => {
  let call = 0;
  const ssh = new FakeSSHClient(() => {
    call += 1;
    if (call === 1) return { stdout: 'live-content', stderr: '', code: 0 };
    return { stdout: '', stderr: 'disk full', code: 1 };
  });
  await assert.rejects(
    () => runRenderStatusPage({ apply: true }, { ssh, inventory }, 'domain: example.com'),
    /Failed to write status page on pve1 \(exit 1\): disk full/
  );
});

test('runRenderStatusPage throws when statusPagePath is unset', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runRenderStatusPage({ apply: true }, { ssh, inventory }, 'domain: example.com\n'),
    /statusPagePath is not set -- run: bellhop set-config statusPagePath <\/absolute\/path> --apply, or set it on the web UI's Settings page/
  );
});

test('runRenderStatusPage writes to the configured path', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    statusPagePath: '/var/www/status.html',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: 'example.com { }', stderr: '', code: 0 }));
  const result = await runRenderStatusPage({ apply: true }, { ssh, inventory }, 'domain: example.com\n');
  assert.equal(result.applied, true);
  assert.ok(ssh.history.some((h) => h.command.includes("cat > '/var/www/status.html'")));
});

test('runRenderStatusPage single-quotes a statusPagePath containing a space', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    statusPagePath: '/var/www/my status/index.html',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: 'example.com { }', stderr: '', code: 0 }));
  await runRenderStatusPage({ apply: true }, { ssh, inventory }, 'domain: example.com\n');
  assert.ok(ssh.history.some((h) => h.command.includes("cat > '/var/www/my status/index.html'")));
});

test('runRenderStatusPage reads the deployed configuration from the proxyConfigPath setting', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    statusPagePath: '/var/www/status.html',
    proxyConfigPath: '/opt/caddy/Caddyfile',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: 'example.com { }', stderr: '', code: 0 }));
  await runRenderStatusPage(
    { apply: false },
    { ssh, inventory },
    'domain: example.com\n'
  );
  assert.ok(ssh.history.some((h) => h.command === "cat '/opt/caddy/Caddyfile'"));
});

// Issue #33 US2: proxyDriver: 'none' has statusPage: null -- no managed
// proxy exists to serve a page from, so runRenderStatusPage must reject
// before ever calling ssh, whether or not statusPagePath happens to be set.
test('runRenderStatusPage rejects with NO_PROXY_STATUS_PAGE_ERROR under proxyDriver none, with statusPagePath set, and makes no SSH calls', async () => {
  const noneInventory: Inventory = { ...inventory, proxyDriver: 'none' };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(() => runRenderStatusPage({}, { ssh, inventory: noneInventory }, 'domain: example.com'), (err: Error) => {
    assert.equal(err.message, NO_PROXY_STATUS_PAGE_ERROR);
    return true;
  });
  assert.equal(ssh.history.length, 0);
});

test('runRenderStatusPage rejects with NO_PROXY_STATUS_PAGE_ERROR under proxyDriver none, with statusPagePath unset, and makes no SSH calls', async () => {
  const noneInventory: Inventory = { ...inventory, proxyDriver: 'none', statusPagePath: undefined };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(() => runRenderStatusPage({}, { ssh, inventory: noneInventory }, 'domain: example.com'), (err: Error) => {
    assert.equal(err.message, NO_PROXY_STATUS_PAGE_ERROR);
    return true;
  });
  assert.equal(ssh.history.length, 0);
});

test("statusPageSkipReason returns the driver skip message under proxyDriver none, taking priority over the unset-path message", () => {
  const noneInventory: Inventory = { ...inventory, proxyDriver: 'none' };
  assert.equal(statusPageSkipReason(noneInventory), "proxyDriver is 'none' -- skipping the status page render");

  const noneNoPath: Inventory = { ...inventory, proxyDriver: 'none', statusPagePath: undefined };
  assert.equal(statusPageSkipReason(noneNoPath), "proxyDriver is 'none' -- skipping the status page render");
});

test('statusPageSkipReason returns the unset-path message when statusPagePath is unset (caddy driver)', () => {
  const noPath: Inventory = { ...inventory, statusPagePath: undefined };
  assert.match(
    statusPageSkipReason(noPath) ?? '',
    /statusPagePath is not set -- skipping the status page render -- run: bellhop set-config statusPagePath <\/absolute\/path> --apply/
  );
});

test('statusPageSkipReason returns null when the driver serves a status page and statusPagePath is set (caddy driver)', () => {
  assert.equal(statusPageSkipReason(inventory), null);
});

test('runRenderStatusPage single-quotes a proxyConfigPath containing a space', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    statusPagePath: '/var/www/status.html',
    proxyConfigPath: '/opt/my caddy/Caddyfile',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', proxy: true }],
    guests: [],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: 'example.com { }', stderr: '', code: 0 }));
  await runRenderStatusPage(
    { apply: false },
    { ssh, inventory },
    'domain: example.com\n'
  );
  assert.ok(ssh.history.some((h) => h.command === "cat '/opt/my caddy/Caddyfile'"));
});
