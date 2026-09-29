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
  // The restore-on-any-failure trap (installed once every backup exists)
  // is what actually copies the backup back or removes the file, for every
  // file -- here just the one -- covering both a failed validate and a
  // write-phase crash under `set -e`.
  assert.match(script, /trap .*EXIT/, 'installs a restore-on-failure trap');
  assert.match(script, /EXISTED_0/, 'tracks whether the file previously existed');
  assert.equal(lines[lines.length - 1], RELOAD_COMMAND, 'the reload command runs last');
});

test('buildFileDriverScript: the restore message is printed via printf with the validate command single-quoted, not double-quoted interpolation', () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com {\n    respond "hi"\n}')];
  const script = buildFileDriverScript(files, VALIDATE_COMMAND, RELOAD_COMMAND);
  assert.ok(
    script.includes(
      `printf '%s failed; restored previous configuration\\n' '${VALIDATE_COMMAND.replace(/'/g, `'\\''`)}' >&2`
    ),
    `expected a printf-based restore message, got:\n${script}`
  );
  assert.ok(!script.includes(`echo "${VALIDATE_COMMAND} failed`), 'must not use double-quoted echo interpolation');
});

test('buildFileDriverScript: the trap disarms before backups are removed and the reload runs, so a reload failure never triggers a restore', () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const script = buildFileDriverScript(files, VALIDATE_COMMAND, RELOAD_COMMAND);
  const disarmIndex = script.indexOf('trap - EXIT');
  const reloadIndex = script.lastIndexOf(RELOAD_COMMAND);
  assert.ok(disarmIndex !== -1, 'trap must be disarmed');
  assert.ok(disarmIndex < reloadIndex, 'trap must be disarmed before the reload command runs');
});

test('buildFileDriverScript: HUP, INT, and TERM run the same restore and exit non-zero, since an EXIT trap alone does not run when sh is killed by a signal', () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const script = buildFileDriverScript(files, VALIDATE_COMMAND, RELOAD_COMMAND);
  const signalTrap = script.split('\n').find((l) => /^trap .* HUP INT TERM$/.test(l));
  assert.ok(signalTrap, `expected a HUP INT TERM trap, got:\n${script}`);
  assert.ok(script.indexOf(signalTrap!) > script.indexOf('bellhop_restore_all() {'), 'installed after the restore function exists');
  assert.ok(script.indexOf(signalTrap!) < script.indexOf('<<\'BELLHOP_FILE_0\''), 'installed before anything is written');
  assert.match(script, /bellhop_on_signal\(\) \{[\s\S]*bellhop_restore_all[\s\S]*exit 1[\s\S]*\}/, 'the handler restores, then exits non-zero');
});

test('buildFileDriverScript: every trap is disarmed together before backups are removed and the reload runs', () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const script = buildFileDriverScript(files, VALIDATE_COMMAND, RELOAD_COMMAND);
  const disarmIndex = script.indexOf('trap - EXIT HUP INT TERM');
  assert.ok(disarmIndex !== -1, `expected one combined disarm, got:\n${script}`);
  assert.ok(disarmIndex < script.indexOf('rm -f "$BAK_0"\n' + RELOAD_COMMAND), 'disarmed before the backups are removed');
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

// --- (a2) the owned-file header guard (issue #30 review) -------------------

const OWNED_HEADER = "# Generated by Bellhop. Don't edit";

test('buildFileDriverScript: an owned file with ownedHeader is checked against its first line before any backup, trap, or write', () => {
  const files: FileSpec[] = [
    { path: '/etc/nginx/conf.d/bellhop.conf', content: `${OWNED_HEADER}\nserver {}`, mode: 'owned', ownedHeader: OWNED_HEADER },
  ];
  const script = buildFileDriverScript(files, 'nginx -t', 'systemctl reload nginx');
  const lines = script.split('\n');

  const guardIndex = lines.findIndex((l) => l.includes("head -n 1 '/etc/nginx/conf.d/bellhop.conf'"));
  assert.ok(guardIndex > 0, 'reads the existing file\'s first line with head -n 1');
  // The header is single-quoted (its own quote escaped), never interpolated.
  assert.ok(lines[guardIndex].includes(`'# Generated by Bellhop. Don'\\''t edit'`), 'compares against the single-quoted header');
  const firstBackup = lines.findIndex((l) => l.startsWith('BAK_0='));
  const firstTrap = lines.findIndex((l) => l.startsWith('trap '));
  assert.ok(guardIndex < firstBackup, 'the guard runs before any backup');
  assert.ok(guardIndex < firstTrap, 'the guard runs before any trap is installed');

  const guardBlock = lines.slice(guardIndex, firstBackup).join('\n');
  assert.match(guardBlock, />&2/, 'the refusal is printed to stderr');
  assert.match(guardBlock, /exit 1/, 'the refusal exits non-zero');
  assert.match(guardBlock, /\/etc\/nginx\/conf\.d\/bellhop\.conf/, 'the refusal names the path');
  assert.match(guardBlock, /bellhop set-config proxyConfigPath <path> --apply/, 'the refusal says how to point elsewhere');
});

test('buildFileDriverScript: an owned file without ownedHeader, and a managed-section file, get no header guard', () => {
  const script = buildFileDriverScript(
    [ownedFile('/etc/a.conf', 'x'), managedFile('/etc/caddy/Caddyfile', 'y')],
    'nginx -t',
    'systemctl reload nginx'
  );
  assert.ok(!script.includes('head -n 1'), 'no first-line check without ownedHeader');
});

// --- (b) fileDriver(...).plan() -------------------------------------------

test('fileDriver.plan: a single owned file preview is that file\'s content alone', async () => {
  const files = [ownedFile('/etc/caddy/Caddyfile', 'example.com {\n    respond "hi"\n}')];
  const driver = fileDriver({
    id: 'caddy',
    label: 'Test driver',
    statusPage: null,
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

test('fileDriver.plan: wraps a managed-section body in the bellhop-managed markers, in both preview and payload', async () => {
  const driver = fileDriver({
    id: 'caddy',
    label: 'Test driver',
    statusPage: null,
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: true },
    defaultConfigPath: '/etc/caddy/Caddyfile',
    render: (_routes, _ctx, configPath) => [managedFile(configPath, 'example.com {\n    respond "hi"\n}')],
    validateCommand: () => 'caddy validate',
    reloadCommand: RELOAD_COMMAND,
  });
  const deps = {
    ssh: new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 })),
    inventory: { domain: 'example.com', hosts: [], guests: [] } as Inventory,
    proxyHost: 'pve1',
    configPath: '/etc/caddy/Caddyfile',
  };
  const plan = await driver.plan([] as ProxyRoute[], { externalPort: 443 } as ProxyContext, deps);
  const wrapped = '# BEGIN bellhop-managed\nexample.com {\n    respond "hi"\n}\n# END bellhop-managed';
  assert.equal(plan.preview, wrapped);
  assert.deepEqual(plan.payload, [managedFile('/etc/caddy/Caddyfile', wrapped)]);
});

test('fileDriver.plan: an empty managed-section body is just the two markers', async () => {
  const driver = fileDriver({
    id: 'caddy',
    label: 'Test driver',
    statusPage: null,
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: true },
    defaultConfigPath: '/etc/caddy/Caddyfile',
    render: (_routes, _ctx, configPath) => [managedFile(configPath, '')],
    validateCommand: () => 'caddy validate',
    reloadCommand: RELOAD_COMMAND,
  });
  const deps = {
    ssh: new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 })),
    inventory: { domain: 'example.com', hosts: [], guests: [] } as Inventory,
    proxyHost: 'pve1',
    configPath: '/etc/caddy/Caddyfile',
  };
  const plan = await driver.plan([] as ProxyRoute[], { externalPort: 443 } as ProxyContext, deps);
  assert.equal(plan.preview, '# BEGIN bellhop-managed\n# END bellhop-managed');
});

test('fileDriver.plan: several files join their content with a newline', async () => {
  const files = [ownedFile('/etc/nginx/conf.d/bellhop-a.conf', 'server { listen 80; }'), ownedFile('/etc/nginx/conf.d/bellhop-b.conf', 'server { listen 81; }')];
  const driver = fileDriver({
    id: 'caddy',
    label: 'Test driver',
    statusPage: null,
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

// issue #31 (T004): DriverDeps.configPath is string | null (research.md
// R11) -- null only for a driver with no config file at all (e.g. a
// REST-managed driver like Nginx Proxy Manager), never reachable for a
// fileDriver-built driver in practice, since every one of those declares a
// real defaultConfigPath. plan()/apply()/snapshot() each resolve configPath
// through the same programming-error guard, so a driver that somehow does
// see null here fails loudly and by name rather than passing null through
// to render()/validateCommand()/a `cat` command.
test('fileDriver.plan/apply/snapshot throw a named programming-error message when deps.configPath is null', async () => {
  const driver = fileDriver({
    id: 'nginx',
    label: 'Test driver',
    statusPage: null,
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false },
    defaultConfigPath: '/etc/nginx/conf.d/bellhop.conf',
    render: () => [ownedFile('/etc/nginx/conf.d/bellhop.conf', 'server {}')],
    validateCommand: () => 'nginx -t',
    reloadCommand: 'systemctl reload nginx',
  });
  const deps = {
    ssh: new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 })),
    inventory: { domain: 'example.com', hosts: [], guests: [] } as Inventory,
    proxyHost: 'pve1',
    configPath: null,
  };
  await assert.rejects(
    () => driver.plan([] as ProxyRoute[], { externalPort: 443 } as ProxyContext, deps),
    /^Error: nginx driver requires a config path$/
  );
  await assert.rejects(
    () => driver.apply({ preview: '', payload: [] }, deps),
    /^Error: nginx driver requires a config path$/
  );
  await assert.rejects(() => driver.snapshot(deps), /^Error: nginx driver requires a config path$/);
});

// --- (c) fileDriver(...).apply() ------------------------------------------

test('fileDriver.apply: sends exactly one runRemote call, whose command equals buildFileDriverScript(files, validateCommand(configPath), reloadCommand)', async () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const validateCommand = (p: string) => `caddy validate --config '${p}'`;
  const driver = fileDriver({
    id: 'caddy',
    label: 'Test driver',
    statusPage: null,
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: true },
    defaultConfigPath: '/etc/caddy/Caddyfile',
    render: () => files,
    validateCommand,
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
  const expectedScript = buildFileDriverScript(files, validateCommand(deps.configPath), RELOAD_COMMAND);
  assert.equal(ssh.history[0].command, expectedScript);
});

test('fileDriver.apply: throws with stderr on a non-zero exit', async () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const driver = fileDriver({
    id: 'caddy',
    label: 'Test driver',
    statusPage: null,
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
    label: 'Test driver',
    statusPage: null,
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

test('fileDriver.snapshot: uses configFiles(configPath), defaulting to [configPath], and never calls buildRoutes/buildProxyContext/render', async () => {
  // An inventory buildRoutes() would throw on: a forward-gated entry with
  // no authentik:true ip to address (see routes.test.ts's own throw case).
  // snapshot() must succeed anyway -- a read-only status-page request must
  // never fail alongside a real sync-proxy misconfiguration.
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
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
  let renderCalled = false;
  const driver = fileDriver({
    id: 'caddy',
    label: 'Test driver',
    statusPage: null,
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: true },
    defaultConfigPath: '/etc/caddy/Caddyfile',
    render: () => {
      renderCalled = true;
      return [];
    },
    validateCommand: (p) => `caddy validate --config '${p}'`,
    reloadCommand: RELOAD_COMMAND,
  });
  const ssh = new FakeSSHClient(() => ({ stdout: 'deployed content', stderr: '', code: 0 }));
  const deps = { ssh, inventory, proxyHost: 'pve1', configPath: '/etc/caddy/Caddyfile' };
  const out = await driver.snapshot(deps);
  assert.equal(out, 'deployed content');
  assert.equal(renderCalled, false, 'snapshot must never call render');
  assert.match(ssh.history[0].command, /cat '\/etc\/caddy\/Caddyfile'/);
});

test('fileDriver.snapshot: a driver-supplied configFiles overrides the [configPath] default', async () => {
  const driver = fileDriver({
    id: 'caddy',
    label: 'Test driver',
    statusPage: null,
    capabilities: { authModes: ['forward', 'oidc'], acmeDns01ViaCloudflare: false },
    defaultConfigPath: '/etc/nginx/nginx.conf',
    render: () => [],
    validateCommand: () => 'nginx -t',
    reloadCommand: 'systemctl reload nginx',
    configFiles: () => ['/etc/nginx/conf.d/bellhop-a.conf', '/etc/nginx/conf.d/bellhop-b.conf'],
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

// (The "more than one file gets a ==> <path> <== header" case is covered by
// "fileDriver.snapshot: a driver-supplied configFiles overrides the
// [configPath] default" above -- snapshot's file list now always comes from
// configFiles(configPath), never from render(), so a multi-file snapshot
// case has to supply configFiles to get more than one path.)

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

test('buildFileDriverScript, executed: a TERM signal mid-validate restores the original file and never reloads', (t) => {
  if (!shAvailable()) {
    t.skip('sh not found on PATH -- cannot execute the generated script');
    return;
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-signal-'));
  const stubDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-signal-stubs-'));
  const posix = (p: string) => p.replace(/\\/g, '/');
  const caddyfilePath = posix(join(tmpDir, 'Caddyfile'));
  const systemctlLogPath = posix(join(tmpDir, 'systemctl.log'));
  const originalContent = ['a.example.com {', '    respond "hand-authored"', '}'].join('\n');
  writeFileSync(caddyfilePath, originalContent);

  const files: FileSpec[] = [{ path: caddyfilePath, content: 'new.example.com {\n    respond "new"\n}', mode: 'managed-section' }];
  const script = buildFileDriverScript(files, `caddy validate --config '${caddyfilePath}'`, 'systemctl reload caddy');
  const scriptPath = posix(join(tmpDir, 'apply.sh'));
  writeFileSync(scriptPath, script);

  // The validate stub signals the script's own shell (its parent) and then
  // succeeds, so the only thing that can stop the reload is the signal trap.
  const caddyPath = join(stubDir, 'caddy');
  writeFileSync(caddyPath, '#!/bin/sh\nkill -TERM "$PPID"\nexit 0\n');
  chmodSync(caddyPath, 0o755);
  const systemctlPath = join(stubDir, 'systemctl');
  writeFileSync(systemctlPath, `#!/bin/sh\necho "$@" >> '${systemctlLogPath}'\n`);
  chmodSync(systemctlPath, 0o755);

  const env = { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH}` };
  const result = spawnSync('sh', [scriptPath], { env });

  assert.notEqual(result.status, 0, `expected a non-zero exit, got ${result.status} (signal ${result.signal}), stderr: ${result.stderr}`);
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

test('buildFileDriverScript, executed: a write-phase failure (before validate ever runs) still restores every backup', (t) => {
  if (!shAvailable()) {
    t.skip('sh not found on PATH -- cannot execute the generated script');
    return;
  }

  // Portable across Windows Git Bash and Linux CI alike (no chmod/root
  // dependence): a write targeting a path whose parent directory does not
  // exist fails identically on both, under `set -e`, before the validate
  // command is ever reached. File A is a real, pre-existing file (so its
  // restore is meaningfully verified); file B's write is what fails.
  const tmpDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-'));
  const stubDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-stubs-'));
  const posix = (p: string) => p.replace(/\\/g, '/');
  const fileAPath = posix(join(tmpDir, 'Caddyfile'));
  const fileBPath = posix(join(tmpDir, 'nonexistent-subdir', 'Caddyfile2'));
  const systemctlLogPath = posix(join(tmpDir, 'systemctl.log'));

  const originalContentA = [
    'a.example.com {',
    '    respond "hand-authored-a"',
    '}',
    '# BEGIN bellhop-managed',
    'old-a.example.com {',
    '    respond "old-a"',
    '}',
    '# END bellhop-managed',
  ].join('\n');
  writeFileSync(fileAPath, originalContentA);
  // fileBPath's parent directory is deliberately never created.

  const newBlockA = ['# BEGIN bellhop-managed', 'new-a.example.com {', '    respond "new-a"', '}', '# END bellhop-managed'].join('\n');
  const newBlockB = ['# BEGIN bellhop-managed', 'new-b.example.com {', '    respond "new-b"', '}', '# END bellhop-managed'].join('\n');

  const files: FileSpec[] = [
    { path: fileAPath, content: newBlockA, mode: 'managed-section' },
    { path: fileBPath, content: newBlockB, mode: 'managed-section' },
  ];
  // The validate command is irrelevant here -- the write phase must fail
  // before it's ever reached, so use an unconditionally-failing stub to
  // prove that if validate *did* run, the test would still tell them apart
  // (it doesn't run at all: no reload, and file A's restore proves the
  // trap fired from the write-phase crash, not from a validate failure).
  const validateCommand = `caddy validate --adapter caddyfile --config '${fileAPath}'`;
  const script = buildFileDriverScript(files, validateCommand, 'systemctl reload caddy');
  const scriptPath = posix(join(tmpDir, 'apply.sh'));
  writeFileSync(scriptPath, script);

  const caddyPath = join(stubDir, 'caddy');
  writeFileSync(caddyPath, '#!/bin/sh\nexit 1\n');
  chmodSync(caddyPath, 0o755);
  const systemctlPath = join(stubDir, 'systemctl');
  writeFileSync(systemctlPath, `#!/bin/sh\necho "$@" >> '${systemctlLogPath}'\n`);
  chmodSync(systemctlPath, 0o755);

  const env = { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH}` };
  const result = spawnSync('sh', [scriptPath], { env });

  assert.notEqual(result.status, 0, `expected a non-zero exit from the write-phase failure, got ${result.status}`);
  assert.equal(
    readFileSync(fileAPath, 'utf8'),
    originalContentA,
    'file A (whose own write succeeded before file B\'s write crashed the script) must still be restored byte for byte'
  );
  assert.ok(!existsSync(fileBPath), 'file B, which never existed, must not have been created');
  assert.ok(!existsSync(systemctlLogPath), 'systemctl must not have been called -- validate was never reached');
});
