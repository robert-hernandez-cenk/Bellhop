import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Inventory } from '../../src/lib/inventory.ts';
import { runRenderStatusPage, buildStatusPageHtml } from '../../src/commands/networking/render-status-page.ts';
import { FakeSSHClient } from '../support/fake-ssh-client.ts';

const inventory: Inventory = {
  domain: 'example.com',
  statusPagePath: '/usr/share/caddy/index.html',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
  guests: [],
};

test('buildStatusPageHtml embeds both files in <pre> blocks, HTML-escaped', () => {
  const html = buildStatusPageHtml('domain: <b>example.com</b>', 'a.example.com & b.example.com {\n}');
  assert.match(html, /<pre>domain: &lt;b&gt;example\.com&lt;\/b&gt;<\/pre>/);
  assert.match(html, /<pre>a\.example\.com &amp; b\.example\.com \{\n\}<\/pre>/);
  assert.match(html, /<title>Homelab status<\/title>/);
});

test('runRenderStatusPage throws when no entry has caddy: true', async () => {
  const noCaddy: Inventory = { ...inventory, hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }] };
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  await assert.rejects(
    () => runRenderStatusPage({}, { ssh, inventory: noCaddy }, 'domain: example.com'),
    /No inventory entry has 'caddy: true'/
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
  assert.equal(calls.length, 1, 'only the read (cat Caddyfile), no write');
  assert.match(calls[0], /cat '\/etc\/caddy\/Caddyfile'/);
  assert.match(result.html, /the-live-caddyfile-content/);
});

test('runRenderStatusPage writes the status page to the caddy host when apply is set', async () => {
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

test('runRenderStatusPage throws when reading the active Caddyfile fails', async () => {
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'no such file', code: 1 }));
  await assert.rejects(
    () => runRenderStatusPage({}, { ssh, inventory }, 'domain: example.com'),
    /Failed to read the active Caddyfile from pve1 \(exit 1\): no such file/
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
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
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
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
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
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: 'example.com { }', stderr: '', code: 0 }));
  await runRenderStatusPage({ apply: true }, { ssh, inventory }, 'domain: example.com\n');
  assert.ok(ssh.history.some((h) => h.command.includes("cat > '/var/www/my status/index.html'")));
});

test('runRenderStatusPage reads the Caddyfile from the given caddyfilePath', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    statusPagePath: '/var/www/status.html',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: 'example.com { }', stderr: '', code: 0 }));
  await runRenderStatusPage(
    { apply: false, caddyfilePath: '/opt/caddy/Caddyfile' },
    { ssh, inventory },
    'domain: example.com\n'
  );
  assert.ok(ssh.history.some((h) => h.command === "cat '/opt/caddy/Caddyfile'"));
});

test('runRenderStatusPage single-quotes a caddyfilePath containing a space', async () => {
  const inventory: Inventory = {
    domain: 'example.com',
    statusPagePath: '/var/www/status.html',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', caddy: true }],
    guests: [],
  };
  const ssh = new FakeSSHClient(() => ({ stdout: 'example.com { }', stderr: '', code: 0 }));
  await runRenderStatusPage(
    { apply: false, caddyfilePath: '/opt/my caddy/Caddyfile' },
    { ssh, inventory },
    'domain: example.com\n'
  );
  assert.ok(ssh.history.some((h) => h.command === "cat '/opt/my caddy/Caddyfile'"));
});
