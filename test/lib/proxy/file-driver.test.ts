import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Inventory } from '../../../src/lib/inventory.ts';
import type { ProxyContext, ProxyRoute } from '../../../src/lib/proxy/routes.ts';
import { FakeSSHClient } from '../../support/fake-ssh-client.ts';
import { buildFileDriverScript, fileDriver, type FileSpec } from '../../../src/lib/proxy/file-driver.ts';

const VALIDATE_COMMAND = "caddy validate --adapter caddyfile --config '/etc/caddy/Caddyfile'";
const RELOAD_COMMAND = 'systemctl reload caddy';

function managedFile(path: string, content: string): FileSpec {
  return { path, content, mode: 'managed-section' };
}

function ownedFile(path: string, content: string): FileSpec {
  return { path, content, mode: 'owned' };
}

// --- (a) buildFileDriverScript shape -------------------------------------

test('buildFileDriverScript: one managed-section file has a backup, the marker-stripping sed, the validate command, a restore-and-exit-1 branch, and the reload command last', () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com {\n    respond "hi"\n}')];
  const script = buildFileDriverScript(files, VALIDATE_COMMAND, RELOAD_COMMAND);
  const lines = script.split('\n');

  assert.match(script, /mktemp/, 'takes a backup via mktemp');
  assert.match(script, /'\/etc\/caddy\/Caddyfile'/, 'the path is single-quoted');
  assert.match(script, /sed '\/# BEGIN bellhop-managed\/,\/# END bellhop-managed\/d'/, 'strips the old managed section');
  assert.ok(script.includes(VALIDATE_COMMAND), 'runs the validate command');
  assert.match(script, /if ! .*caddy validate.*; then/, 'validates before deciding whether to restore');
  assert.ok(script.includes('exit 1'), 'exits 1 on a failed validate');
  // The restore branch (inside the "if ! validate" block) copies the backup
  // back or removes the file, for every file -- here just the one.
  assert.match(script, /EXISTED_0/, 'tracks whether the file previously existed');
  assert.equal(lines[lines.length - 1], RELOAD_COMMAND, 'the reload command runs last');
});

test('buildFileDriverScript: two owned files each get their own backup and restore branch', () => {
  const files = [ownedFile('/etc/nginx/conf.d/bellhop-a.conf', 'server { listen 80; }'), ownedFile('/etc/nginx/conf.d/bellhop-b.conf', 'server { listen 81; }')];
  const script = buildFileDriverScript(files, 'nginx -t', 'systemctl reload nginx');
  const lines = script.split('\n');

  assert.match(script, /'\/etc\/nginx\/conf\.d\/bellhop-a\.conf'/);
  assert.match(script, /'\/etc\/nginx\/conf\.d\/bellhop-b\.conf'/);
  // A backup per file.
  assert.match(script, /EXISTED_0/);
  assert.match(script, /EXISTED_1/);
  assert.equal((script.match(/mktemp/g) ?? []).length, 2, 'one backup temp file per owned file');
  assert.ok(script.includes('nginx -t'));
  assert.equal(lines[lines.length - 1], 'systemctl reload nginx');
});

// --- (b) fileDriver(...).plan() -------------------------------------------

test('fileDriver.plan: a single file preview is that file\'s content alone', async () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com {\n    respond "hi"\n}')];
  const driver = fileDriver({
    id: 'caddy',
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: true },
    defaultConfigPath: '/etc/caddy/Caddyfile',
    render: () => files,
    validateCommand: (p) => `caddy validate --adapter caddyfile --config '${p}'`,
    reloadCommand: RELOAD_COMMAND,
  });
  const deps = {
    ssh: new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 })),
    inventory: { domain: 'example.com', hosts: [], guests: [] } as Inventory,
    proxyHost: 'pve1',
    configPath: '/etc/caddy/Caddyfile',
  };
  const plan = await driver.plan([] as ProxyRoute[], { externalPort: 443 } as ProxyContext, deps);
  assert.equal(plan.preview, files[0].content);
  assert.deepEqual(plan.payload, files);
});

test('fileDriver.plan: several files join their content with a newline', async () => {
  const files = [ownedFile('/etc/nginx/conf.d/bellhop-a.conf', 'server { listen 80; }'), ownedFile('/etc/nginx/conf.d/bellhop-b.conf', 'server { listen 81; }')];
  const driver = fileDriver({
    id: 'caddy',
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false },
    defaultConfigPath: '/etc/nginx/nginx.conf',
    render: () => files,
    validateCommand: () => 'nginx -t',
    reloadCommand: 'systemctl reload nginx',
  });
  const deps = {
    ssh: new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 })),
    inventory: { domain: 'example.com', hosts: [], guests: [] } as Inventory,
    proxyHost: 'pve1',
    configPath: '/etc/nginx/nginx.conf',
  };
  const plan = await driver.plan([] as ProxyRoute[], { externalPort: 443 } as ProxyContext, deps);
  assert.equal(plan.preview, `${files[0].content}\n${files[1].content}`);
  assert.deepEqual(plan.payload, files);
});

// --- (c) fileDriver(...).apply() ------------------------------------------

test('fileDriver.apply: sends exactly one runRemote call to the proxy host', async () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const driver = fileDriver({
    id: 'caddy',
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: true },
    defaultConfigPath: '/etc/caddy/Caddyfile',
    render: () => files,
    validateCommand: (p) => `caddy validate --config '${p}'`,
    reloadCommand: RELOAD_COMMAND,
  });
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [],
  };
  const deps = { ssh, inventory, proxyHost: 'pve1', configPath: '/etc/caddy/Caddyfile' };
  const plan = { preview: files[0].content, payload: files };
  await driver.apply(plan, deps);
  assert.equal(ssh.history.length, 1);
  assert.equal(ssh.history[0].sshTarget, '192.0.2.1');
});

test('fileDriver.apply: throws with stderr on a non-zero exit', async () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const driver = fileDriver({
    id: 'caddy',
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: true },
    defaultConfigPath: '/etc/caddy/Caddyfile',
    render: () => files,
    validateCommand: (p) => `caddy validate --config '${p}'`,
    reloadCommand: RELOAD_COMMAND,
  });
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: 'validation failed', code: 1 }));
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [],
  };
  const deps = { ssh, inventory, proxyHost: 'pve1', configPath: '/etc/caddy/Caddyfile' };
  const plan = { preview: files[0].content, payload: files };
  await assert.rejects(() => driver.apply(plan, deps), /validation failed/);
});

// --- (d) fileDriver(...).snapshot() ----------------------------------------

test('fileDriver.snapshot: a single file has no ==> <path> <== header', async () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'irrelevant for this test')];
  const driver = fileDriver({
    id: 'caddy',
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: true },
    defaultConfigPath: '/etc/caddy/Caddyfile',
    render: () => files,
    validateCommand: (p) => `caddy validate --config '${p}'`,
    reloadCommand: RELOAD_COMMAND,
  });
  const ssh = new FakeSSHClient(() => ({ stdout: 'the deployed content', stderr: '', code: 0 }));
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [],
  };
  const deps = { ssh, inventory, proxyHost: 'pve1', configPath: '/etc/caddy/Caddyfile' };
  const out = await driver.snapshot(deps);
  assert.equal(out, 'the deployed content');
  assert.equal(ssh.history.length, 1);
  assert.ok(!ssh.history[0].command.includes('==>'), 'no header for a single file');
  assert.match(ssh.history[0].command, /cat '\/etc\/caddy\/Caddyfile'/);
});

test('fileDriver.snapshot: more than one file gets a ==> <path> <== header per file', async () => {
  const files = [ownedFile('/etc/nginx/conf.d/bellhop-a.conf', 'a'), ownedFile('/etc/nginx/conf.d/bellhop-b.conf', 'b')];
  const driver = fileDriver({
    id: 'caddy',
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false },
    defaultConfigPath: '/etc/nginx/nginx.conf',
    render: () => files,
    validateCommand: () => 'nginx -t',
    reloadCommand: 'systemctl reload nginx',
  });
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [],
  };
  const deps = { ssh, inventory, proxyHost: 'pve1', configPath: '/etc/nginx/nginx.conf' };
  await driver.snapshot(deps);
  const command = ssh.history[0].command;
  assert.match(command, /==> \/etc\/nginx\/conf\.d\/bellhop-a\.conf <==/);
  assert.match(command, /==> \/etc\/nginx\/conf\.d\/bellhop-b\.conf <==/);
});

// --- (e) executed restore test ---------------------------------------------

function shAvailable(): boolean {
  const result = spawnSync('sh', ['-c', 'exit 0']);
  return result.error === undefined || result.error === null;
}

test('buildFileDriverScript, executed: a failed validate restores the original file byte for byte and never reloads', (t) => {
  if (!shAvailable()) {
    t.skip('sh not found on PATH -- cannot execute the generated script');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-'));
  const stubDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-stubs-'));
  // The script itself runs under Git Bash's `sh` on Windows, which accepts
  // forward-slash paths -- convert the temp dir once so every path embedded
  // in the generated script (and the stub scripts below) is POSIX-shaped.
  const posix = (p: string) => p.replace(/\\/g, '/');
  const caddyfilePath = posix(join(tmpDir, 'Caddyfile'));
  const systemctlLogPath = posix(join(tmpDir, 'systemctl.log'));

  const originalContent = [
    'a.example.com {',
    '    respond "hand-authored"',
    '}',
    '# BEGIN bellhop-managed',
    'old.example.com {',
    '    respond "old"',
    '}',
    '# END bellhop-managed',
  ].join('\n');
  writeFileSync(caddyfilePath, originalContent);

  const newBlockContent = [
    '# BEGIN bellhop-managed',
    'new.example.com {',
    '    respond "new"',
    '}',
    '# END bellhop-managed',
  ].join('\n');

  const files: FileSpec[] = [{ path: caddyfilePath, content: newBlockContent, mode: 'managed-section' }];
  const validateCommand = `caddy validate --adapter caddyfile --config '${caddyfilePath}'`;
  const script = buildFileDriverScript(files, validateCommand, 'systemctl reload caddy');
  const scriptPath = posix(join(tmpDir, 'apply.sh'));
  writeFileSync(scriptPath, script);

  // Stub `caddy` (fails validation) and `systemctl` (records its args) --
  // both ahead of the real PATH so the script's bare `caddy`/`systemctl`
  // invocations resolve to these instead.
  const caddyFailPath = join(stubDir, 'caddy');
  writeFileSync(caddyFailPath, '#!/bin/sh\nexit 1\n');
  chmodSync(caddyFailPath, 0o755);
  const systemctlPath = join(stubDir, 'systemctl');
  writeFileSync(systemctlPath, `#!/bin/sh\necho "$@" >> '${systemctlLogPath}'\n`);
  chmodSync(systemctlPath, 0o755);

  const env = { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH}` };
  const result = spawnSync('sh', [scriptPath], { env });

  assert.equal(result.status, 1, `expected exit 1, got ${result.status}, stderr: ${result.stderr}`);
  assert.equal(readFileSync(caddyfilePath, 'utf8'), originalContent, 'the original file must be restored byte for byte');
  assert.ok(!existsSync(systemctlLogPath), 'systemctl must not have been called');
});

test('buildFileDriverScript, executed: a successful validate replaces the managed block, keeps hand-authored content, and reloads once', (t) => {
  if (!shAvailable()) {
    t.skip('sh not found on PATH -- cannot execute the generated script');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-'));
  const stubDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-stubs-'));
  const posix = (p: string) => p.replace(/\\/g, '/');
  const caddyfilePath = posix(join(tmpDir, 'Caddyfile'));
  const systemctlLogPath = posix(join(tmpDir, 'systemctl.log'));

  const handAuthored = ['a.example.com {', '    respond "hand-authored"', '}'].join('\n');
  const originalContent = [
    handAuthored,
    '# BEGIN bellhop-managed',
    'old.example.com {',
    '    respond "old"',
    '}',
    '# END bellhop-managed',
  ].join('\n');
  writeFileSync(caddyfilePath, originalContent);

  const newBlockContent = [
    '# BEGIN bellhop-managed',
    'new.example.com {',
    '    respond "new"',
    '}',
    '# END bellhop-managed',
  ].join('\n');

  const files: FileSpec[] = [{ path: caddyfilePath, content: newBlockContent, mode: 'managed-section' }];
  const validateCommand = `caddy validate --adapter caddyfile --config '${caddyfilePath}'`;
  const script = buildFileDriverScript(files, validateCommand, 'systemctl reload caddy');
  const scriptPath = posix(join(tmpDir, 'apply.sh'));
  writeFileSync(scriptPath, script);

  const caddyOkPath = join(stubDir, 'caddy');
  writeFileSync(caddyOkPath, '#!/bin/sh\nexit 0\n');
  chmodSync(caddyOkPath, 0o755);
  const systemctlPath = join(stubDir, 'systemctl');
  writeFileSync(systemctlPath, `#!/bin/sh\necho "$@" >> '${systemctlLogPath}'\n`);
  chmodSync(systemctlPath, 0o755);

  const env = { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH}` };
  const result = spawnSync('sh', [scriptPath], { env });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}, stderr: ${result.stderr}`);
  const finalContent = readFileSync(caddyfilePath, 'utf8');
  assert.ok(finalContent.includes(handAuthored), 'hand-authored content outside the markers must survive');
  assert.ok(finalContent.includes('new.example.com'), 'the new managed block must be present');
  assert.ok(!finalContent.includes('old.example.com'), 'the old managed block must be gone');
  const systemctlLog = readFileSync(systemctlLogPath, 'utf8').trim().split('\n');
  assert.deepEqual(systemctlLog, ['reload caddy']);
});
