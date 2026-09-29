import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runRenderStatusPage, statusPageSkipReason, statusPageUnsupportedError, buildStatusPageHtml } from '../../src/commands/networking/render-status-page.ts';
import { fileDriver } from '../../src/lib/proxy/file-driver.ts';
import { registerDriverForTests, type ProxyDriverId } from '../../src/lib/proxy/index.ts';
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

test("statusPageSkipReason returns the driver skip message (info) under proxyDriver none, taking priority over the unset-path message", () => {
  const noneInventory: Inventory = { ...inventory, proxyDriver: 'none' };
  assert.deepEqual(statusPageSkipReason(noneInventory), {
    message: "proxyDriver is 'none' -- skipping the status page render",
    level: 'info',
  });

  const noneNoPath: Inventory = { ...inventory, proxyDriver: 'none', statusPagePath: undefined };
  assert.deepEqual(statusPageSkipReason(noneNoPath), {
    message: "proxyDriver is 'none' -- skipping the status page render",
    level: 'info',
  });
});

test('statusPageSkipReason returns the unset-path message (info) when statusPagePath is unset (caddy driver)', () => {
  const noPath: Inventory = { ...inventory, statusPagePath: undefined };
  const reason = statusPageSkipReason(noPath);
  assert.equal(reason?.level, 'info');
  assert.match(
    reason?.message ?? '',
    /statusPagePath is not set -- skipping the status page render -- run: bellhop set-config statusPagePath <\/absolute\/path> --apply/
  );
});

test('statusPageSkipReason returns null when the driver serves a status page and statusPagePath is set (caddy driver)', () => {
  assert.equal(statusPageSkipReason(inventory), null);
});

// A driver that does manage a proxy but serves no status page -- none ships
// today, so this registers a test-only one. It is a different case from
// 'none' (Bellhop manages no proxy at all), so it gets its own message.
function managedDriverWithoutStatusPage(id: string) {
  return fileDriver({
    id: id as ProxyDriverId,
    label: 'Managed, no status page',
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false },
    defaultConfigPath: '/etc/test-only/test.conf',
    statusPage: null,
    render: () => [],
    validateCommand: () => 'true',
    reloadCommand: 'true',
  });
}

test('statusPageSkipReason names a managed driver that serves no status page, as a warning when statusPagePath is set (it is being ignored)', () => {
  const driver = managedDriverWithoutStatusPage('managed-no-status-page-a');
  const unregister = registerDriverForTests(driver);
  try {
    const inv: Inventory = { ...inventory, proxyDriver: driver.id as Inventory['proxyDriver'] };
    assert.deepEqual(statusPageSkipReason(inv), {
      message: "The 'managed-no-status-page-a' proxy driver does not serve a status page -- skipping the status page render",
      level: 'warn',
    });
    const noPath: Inventory = { ...inv, statusPagePath: undefined };
    assert.deepEqual(statusPageSkipReason(noPath), {
      message: "The 'managed-no-status-page-a' proxy driver does not serve a status page -- skipping the status page render",
      level: 'info',
    });
  } finally {
    unregister();
  }
});

test('runRenderStatusPage rejects with statusPageUnsupportedError for a managed driver that serves no status page, and makes no SSH calls', async () => {
  const driver = managedDriverWithoutStatusPage('managed-no-status-page-b');
  const unregister = registerDriverForTests(driver);
  try {
    const inv: Inventory = { ...inventory, proxyDriver: driver.id as Inventory['proxyDriver'] };
    const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
    await assert.rejects(() => runRenderStatusPage({}, { ssh, inventory: inv }, 'domain: example.com'), (err: Error) => {
      assert.equal(err.message, statusPageUnsupportedError('managed-no-status-page-b'));
      assert.equal(
        err.message,
        "The 'managed-no-status-page-b' proxy driver does not serve a status page -- clear statusPagePath (bellhop set-config statusPagePath --unset --apply, or on the web UI's Settings page) or choose a proxyDriver that serves one"
      );
      return true;
    });
    assert.equal(ssh.history.length, 0);
  } finally {
    unregister();
  }
});

// Issue #31 (US5, T021): the real registered 'nginx-proxy-manager' driver is
// itself exactly this "managed, but no status page" case -- it manages a
// real proxy over NPM's REST API but has no document root of its own to
// write an index.html to (statusPage: null in the contract). Unlike the
// synthetic driver above, it's already registered under its real id, so no
// registerDriverForTests fake is needed -- and since both checks below
// reject before runRenderStatusPage/statusPageSkipReason ever call
// driverDeps()/driver.snapshot(), no NPM_API_EMAIL/NPM_API_PASSWORD env vars
// or fetch stub are needed either; buildNpmClient is never reached.
test("statusPageSkipReason names 'nginx-proxy-manager' as a managed driver with no status page -- warn when statusPagePath is set (it's being ignored), info when unset", () => {
  const npmInventory: Inventory = { ...inventory, proxyDriver: 'nginx-proxy-manager' };
  assert.deepEqual(statusPageSkipReason(npmInventory), {
    message: "The 'nginx-proxy-manager' proxy driver does not serve a status page -- skipping the status page render",
    level: 'warn',
  });
  const noPath: Inventory = { ...npmInventory, statusPagePath: undefined };
  assert.deepEqual(statusPageSkipReason(noPath), {
    message: "The 'nginx-proxy-manager' proxy driver does not serve a status page -- skipping the status page render",
    level: 'info',
  });
});

test("runRenderStatusPage rejects with statusPageUnsupportedError('nginx-proxy-manager'), and makes no SSH calls", async () => {
  const npmInventory: Inventory = { ...inventory, proxyDriver: 'nginx-proxy-manager' };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(() => runRenderStatusPage({}, { ssh, inventory: npmInventory }, 'domain: example.com'), (err: Error) => {
    assert.equal(err.message, statusPageUnsupportedError('nginx-proxy-manager'));
    assert.equal(
      err.message,
      "The 'nginx-proxy-manager' proxy driver does not serve a status page -- clear statusPagePath (bellhop set-config statusPagePath --unset --apply, or on the web UI's Settings page) or choose a proxyDriver that serves one"
    );
    return true;
  });
  assert.equal(ssh.history.length, 0);
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
