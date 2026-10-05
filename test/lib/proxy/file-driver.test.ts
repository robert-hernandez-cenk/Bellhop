import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, readdirSync, existsSync } from 'node:fs';
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
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
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
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
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
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
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

test('fileDriver.plan: several files are each labelled ==> <path> <==, separated by a blank line (the payload stays unlabelled)', async () => {
  const files = [ownedFile('/etc/nginx/conf.d/bellhop-a.conf', 'server { listen 80; }'), ownedFile('/etc/nginx/conf.d/bellhop-b.conf', 'server { listen 81; }')];
  const driver = fileDriver({
    id: 'caddy',
    label: 'Test driver',
    statusPage: null,
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
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
  assert.equal(
    plan.preview,
    '==> /etc/nginx/conf.d/bellhop-a.conf <==\nserver { listen 80; }\n\n==> /etc/nginx/conf.d/bellhop-b.conf <==\nserver { listen 81; }'
  );
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
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
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

// issue #35 (T006): usesCertResolver/usesApiUrl pass through fileDriver's
// returned driver as a conditional spread -- present only when the driver
// definition sets them.

test('fileDriver: usesCertResolver/usesApiUrl are absent when the driver definition does not set them', () => {
  const driver = fileDriver({
    id: 'caddy',
    label: 'Test driver',
    statusPage: null,
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
    defaultConfigPath: '/etc/caddy/Caddyfile',
    render: () => [],
    validateCommand: () => 'caddy validate',
    reloadCommand: RELOAD_COMMAND,
  });
  assert.ok(!('usesCertResolver' in driver));
  assert.ok(!('usesApiUrl' in driver));
});

test('fileDriver: usesCertResolver/usesApiUrl pass through when the driver definition sets them', () => {
  const driver = fileDriver({
    id: 'traefik',
    label: 'Traefik',
    statusPage: null,
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
    defaultConfigPath: '/etc/traefik/dynamic/bellhop.yml',
    usesCertResolver: true,
    usesApiUrl: true,
    render: () => [],
    validateCommand: () => null,
    reloadCommand: null,
  });
  assert.equal(driver.usesCertResolver, true);
  assert.equal(driver.usesApiUrl, true);
});

// --- (c) fileDriver(...).apply() ------------------------------------------

test('fileDriver.apply: sends exactly one runRemote call, whose command equals buildFileDriverScript(files, validateCommand(configPath), reloadCommand)', async () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const validateCommand = (p: string) => `caddy validate --config '${p}'`;
  const driver = fileDriver({
    id: 'caddy',
    label: 'Test driver',
    statusPage: null,
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
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

// issue #35 (T004): validateCommand receives the plan's own files and the
// inventory alongside configPath -- a validate step can need more than the
// path alone (Traefik's API check needs every rendered router's name from
// the files, and the configured proxyApiUrl from the inventory).
test('fileDriver.apply: validateCommand is called with the plan\'s files and deps.inventory alongside configPath', async () => {
  const files = [ownedFile('/etc/traefik/dynamic/bellhop.yml', 'http: {}')];
  const seen: unknown[] = [];
  const driver = fileDriver({
    id: 'traefik',
    label: 'Traefik',
    statusPage: null,
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
    defaultConfigPath: '/etc/traefik/dynamic/bellhop.yml',
    render: () => files,
    validateCommand: (configPath, ctx) => {
      seen.push({ configPath, ctx });
      return null;
    },
    reloadCommand: null,
  });
  const ssh = new FakeSSHClient(() => ({ stdout: '', stderr: '', code: 0 }));
  const inventory: Inventory = {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: '192.0.2.1', ssh_user: 'root' }],
    guests: [],
  };
  const deps = { ssh, inventory, proxyHost: 'pve1', configPath: '/etc/traefik/dynamic/bellhop.yml' };
  await driver.apply({ preview: files[0].content, payload: files }, deps);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { configPath: '/etc/traefik/dynamic/bellhop.yml', ctx: { files, inventory } });
});

test('fileDriver.apply: throws with stderr on a non-zero exit', async () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const driver = fileDriver({
    id: 'caddy',
    label: 'Test driver',
    statusPage: null,
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
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
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
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
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
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
    capabilities: { authModes: ['forward', 'oidc'], tlsSources: ['files'], defaultTlsSource: 'files' },
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

// --- (f) null validateCommand/reloadCommand, and validateLabel (T002) -----
// The Traefik driver has no validate command at all when proxyApiUrl is
// unset (research.md R2), and never reloads (there's nothing to reload --
// the file provider's own watcher picks up the change). Both become
// string | null rather than always-required strings, and a validateLabel
// lets a driver's failure message name something other than the literal
// command text (Traefik's validate step is a multi-line subshell, not a
// one-line command an operator would want echoed back at them).

test('buildFileDriverScript: a null validateCommand emits no "if !" validate block at all', () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const script = buildFileDriverScript(files, null, RELOAD_COMMAND);
  assert.ok(!script.includes('if !'), `expected no validate block, got:\n${script}`);
  assert.ok(script.includes(RELOAD_COMMAND), 'still reloads when a reload command is given');
});

test('buildFileDriverScript: a null reloadCommand ends the script at the last backup removal -- no reload line', () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const script = buildFileDriverScript(files, VALIDATE_COMMAND, null);
  const lines = script.split('\n');
  assert.equal(lines[lines.length - 1], 'rm -f "$BAK_0"', 'the trap disarm and backup removal are the last lines');
  assert.ok(!script.includes('systemctl'), 'no reload command anywhere in the script');
});

test('buildFileDriverScript: with both null, there is no validate block and no reload line', () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const script = buildFileDriverScript(files, null, null);
  assert.ok(!script.includes('if !'));
  assert.ok(!script.includes('systemctl'));
  const lines = script.split('\n');
  assert.equal(lines[lines.length - 1], 'rm -f "$BAK_0"');
});

test('buildFileDriverScript: validateLabel replaces the command text in the failure message, but the real command still runs', () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const script = buildFileDriverScript(files, VALIDATE_COMMAND, RELOAD_COMMAND, 'Traefik API check');
  assert.ok(script.includes(`if ! ${VALIDATE_COMMAND}; then`), 'still runs the real validate command');
  assert.ok(
    script.includes("printf '%s failed; restored previous configuration\\n' 'Traefik API check' >&2"),
    `expected the label in the failure message, got:\n${script}`
  );
  assert.ok(!script.includes(`'${VALIDATE_COMMAND}' >&2`), 'must not also print the raw command text');
});

test('buildFileDriverScript: with no validateLabel, the failure message still uses the command text (unchanged for Caddy/nginx)', () => {
  const files = [managedFile('/etc/caddy/Caddyfile', 'example.com { }')];
  const script = buildFileDriverScript(files, VALIDATE_COMMAND, RELOAD_COMMAND);
  assert.ok(
    script.includes(`printf '%s failed; restored previous configuration\\n' '${VALIDATE_COMMAND.replace(/'/g, `'\\''`)}' >&2`)
  );
});

// --- (g) FileSpec.atomic (T003) --------------------------------------------
// An atomic owned file (Traefik's dynamic-configuration file, research.md
// R5) is written to a same-directory, dot-prefixed temp file and mv -f'd
// into place, rather than truncated in place with `cat >` -- Traefik's file
// provider watcher can otherwise observe a half-written file mid-`cat`.

const TRAEFIK_PATH = '/etc/traefik/dynamic/bellhop.yml';

function atomicOwnedFile(content: string): FileSpec {
  return { path: TRAEFIK_PATH, content, mode: 'owned', atomic: true };
}

test('buildFileDriverScript: an atomic owned file writes via a same-directory dot-prefixed temp file, cp -p/chmod 644, and mv -f', () => {
  const files = [atomicOwnedFile('http: {}')];
  const script = buildFileDriverScript(files, null, null);
  assert.match(
    script,
    /TMP_0="\$\(mktemp '\/etc\/traefik\/dynamic\/\.bellhop\.yml\.XXXXXX'\)"/,
    'mktemp targets a dot-prefixed name in the same directory as the real file'
  );
  assert.ok(
    script.includes(`if [ -f '${TRAEFIK_PATH}' ]; then cp -p '${TRAEFIK_PATH}' "$TMP_0"; else chmod 644 "$TMP_0"; fi`),
    `expected the cp -p/chmod 644 branch, got:\n${script}`
  );
  assert.match(script, /cat > "\$TMP_0" <<'BELLHOP_FILE_0'/, 'writes the new content into the temp file');
  assert.ok(script.includes(`mv -f "$TMP_0" '${TRAEFIK_PATH}'`), 'renames the temp file over the real path');
});

test('buildFileDriverScript: a non-atomic owned file is unchanged -- no mktemp-in-directory or mv -f write', () => {
  const files = [ownedFile('/etc/nginx/conf.d/bellhop.conf', 'server {}')];
  const script = buildFileDriverScript(files, null, null);
  assert.ok(!script.includes('mv -f'), 'no atomic rename for a non-atomic owned file');
  assert.ok(script.includes(`cat > '/etc/nginx/conf.d/bellhop.conf' <<'BELLHOP_FILE_0'`), 'writes in place as before');
});

test('buildFileDriverScript: an atomic file\'s restore also goes through a same-directory temp file and mv -f, and still rm -f\'s a file that did not previously exist', () => {
  const files = [atomicOwnedFile('http: {}')];
  const script = buildFileDriverScript(files, null, null);
  const restoreStart = script.indexOf('bellhop_restore_all() {');
  const restoreEnd = script.indexOf('}\ntrap', restoreStart);
  const restoreFn = script.slice(restoreStart, restoreEnd);
  assert.match(
    restoreFn,
    /mktemp '\/etc\/traefik\/dynamic\/\.bellhop\.yml\.XXXXXX'/,
    'restore uses the same same-directory temp-file convention'
  );
  assert.match(restoreFn, /cp -p "\$BAK_0"/, 'restore copies the backup with cp -p so the mode survives');
  assert.match(restoreFn, new RegExp(`mv -f .* '${TRAEFIK_PATH.replace(/\//g, '\\/')}'`), 'restore renames atomically over the real path');
  assert.match(restoreFn, new RegExp(`rm -f '${TRAEFIK_PATH.replace(/\//g, '\\/')}'`), 'a file that did not exist before is still rm -f\'d');
});

// --- (h) FileSpec.atomic, executed (T003) -----------------------------------

function permissionModeOf(path: string): string | undefined {
  const result = spawnSync('sh', ['-c', `stat -c '%a' '${path}' 2>/dev/null`]);
  if (result.status !== 0) return undefined;
  return result.stdout.toString().trim();
}

test('buildFileDriverScript, executed: an atomic owned file lands its new content, preserves a pre-existing file\'s mode, and leaves no temp file behind on success', (t) => {
  if (!shAvailable()) {
    t.skip('sh not found on PATH -- cannot execute the generated script');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-atomic-'));
  const posix = (p: string) => p.replace(/\\/g, '/');
  const configPath = posix(join(tmpDir, 'bellhop.yml'));
  const originalContent = 'http:\n  routers: {}\n';
  writeFileSync(configPath, originalContent);
  spawnSync('sh', ['-c', `chmod 640 '${configPath}'`]);
  const modeBefore = permissionModeOf(configPath);

  const newContent = 'http:\n  routers:\n    new: {}\n';
  const files: FileSpec[] = [{ path: configPath, content: newContent, mode: 'owned', atomic: true }];
  const script = buildFileDriverScript(files, null, null);
  const scriptPath = posix(join(tmpDir, 'apply.sh'));
  writeFileSync(scriptPath, script);

  const result = spawnSync('sh', [scriptPath]);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}, stderr: ${result.stderr}`);
  // The heredoc itself always terminates the captured content with a
  // newline (the same as every existing owned/managed-section write in
  // this file) -- not an atomic-write-specific quirk.
  assert.equal(readFileSync(configPath, 'utf8'), `${newContent}\n`, 'the new content must land');

  const leftover = readdirSync(tmpDir).filter((f) => f.startsWith('.bellhop.yml.'));
  assert.deepEqual(leftover, [], 'no .bellhop.yml.* temp file must remain after success');

  if (modeBefore === '640') {
    assert.equal(permissionModeOf(configPath), '640', "the mode of the pre-existing file must survive the atomic replace");
  } else {
    t.diagnostic('skipping mode-preservation assertion: this environment does not honor chmod 640 (e.g. Windows/MSYS)');
  }
});

test('buildFileDriverScript, executed: an atomic owned file restores the old content and leaves no temp file behind when validate fails', (t) => {
  if (!shAvailable()) {
    t.skip('sh not found on PATH -- cannot execute the generated script');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-atomic-fail-'));
  const posix = (p: string) => p.replace(/\\/g, '/');
  const configPath = posix(join(tmpDir, 'bellhop.yml'));
  const originalContent = 'http:\n  routers: {}\n';
  writeFileSync(configPath, originalContent);

  const files: FileSpec[] = [{ path: configPath, content: 'http:\n  routers:\n    new: {}\n', mode: 'owned', atomic: true }];
  // 'false' is a POSIX utility that always exits 1 -- no stub binary needed.
  const script = buildFileDriverScript(files, 'false', null);
  const scriptPath = posix(join(tmpDir, 'apply.sh'));
  writeFileSync(scriptPath, script);

  const result = spawnSync('sh', [scriptPath]);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}, stderr: ${result.stderr}`);
  assert.equal(readFileSync(configPath, 'utf8'), originalContent, 'the original content must be restored byte for byte');

  const leftover = readdirSync(tmpDir).filter((f) => f.startsWith('.bellhop.yml.'));
  assert.deepEqual(leftover, [], 'no .bellhop.yml.* temp file must remain after a restore');
});

// --- (i) atomic backup mode and temp-file cleanup (final review F1/F4) -------

test('buildFileDriverScript: an atomic file is backed up with cp -p, so a restore brings back the original mode/owner, not mktemp\'s 0600', () => {
  const script = buildFileDriverScript([atomicOwnedFile('http: {}')], 'false', null);
  assert.ok(script.includes(`  cp -p '${TRAEFIK_PATH}' "$BAK_0"`), `expected the backup taken with cp -p, got:\n${script}`);
});

test('buildFileDriverScript: a non-atomic file is still backed up with a plain cp (FR-016: Caddy/nginx/HAProxy scripts unchanged)', () => {
  const script = buildFileDriverScript([ownedFile('/etc/nginx/conf.d/bellhop.conf', 'server {}')], 'false', null);
  assert.ok(script.includes(`  cp '/etc/nginx/conf.d/bellhop.conf' "$BAK_0"`));
  assert.ok(!script.includes('cp -p'), 'no cp -p anywhere for a non-atomic file');
  assert.ok(!script.includes('TMP_0=""'), 'no temp-file bookkeeping for a non-atomic file');
});

test('buildFileDriverScript: an atomic file\'s temp name starts empty before the trap is armed, and the restore removes it when set', () => {
  const script = buildFileDriverScript([atomicOwnedFile('http: {}')], 'false', null);
  const init = script.indexOf('TMP_0=""');
  const trap = script.indexOf("trap 'BELLHOP_STATUS");
  assert.ok(init !== -1 && init < trap, `expected TMP_0="" before the EXIT trap, got:\n${script}`);
  const restoreFn = script.slice(script.indexOf('bellhop_restore_all() {'), trap);
  assert.ok(restoreFn.includes('if [ -n "$TMP_0" ]; then rm -f "$TMP_0"; fi'), `expected the temp-file cleanup, got:\n${restoreFn}`);
});

test('buildFileDriverScript, executed: a failed validate restores an atomic file\'s content and its original mode', (t) => {
  if (!shAvailable()) {
    t.skip('sh not found on PATH -- cannot execute the generated script');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-atomic-mode-'));
  const posix = (p: string) => p.replace(/\\/g, '/');
  const configPath = posix(join(tmpDir, 'bellhop.yml'));
  const originalContent = 'http:\n  routers: {}\n';
  writeFileSync(configPath, originalContent);
  spawnSync('sh', ['-c', `chmod 640 '${configPath}'`]);
  const modeBefore = permissionModeOf(configPath);

  const files: FileSpec[] = [{ path: configPath, content: 'http:\n  routers:\n    new: {}\n', mode: 'owned', atomic: true }];
  const scriptPath = posix(join(tmpDir, 'apply.sh'));
  writeFileSync(scriptPath, buildFileDriverScript(files, 'false', null));

  const result = spawnSync('sh', [scriptPath]);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}, stderr: ${result.stderr}`);
  assert.equal(readFileSync(configPath, 'utf8'), originalContent, 'the original content must be restored byte for byte');

  if (modeBefore === '640') {
    assert.equal(permissionModeOf(configPath), '640', 'the restored file must keep the original mode, not the backup\'s 0600');
  } else {
    t.diagnostic('skipping mode assertion: this environment does not honor chmod 640 (e.g. Windows/MSYS)');
  }
});

test('buildFileDriverScript, executed: a write failure after mktemp restores the original and leaves no temp file in the directory', (t) => {
  if (!shAvailable()) {
    t.skip('sh not found on PATH -- cannot execute the generated script');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-atomic-leak-'));
  const stubDir = mkdtempSync(join(tmpdir(), 'bellhop-file-driver-atomic-leak-stubs-'));
  const posix = (p: string) => p.replace(/\\/g, '/');
  const configPath = posix(join(tmpDir, 'bellhop.yml'));
  const originalContent = 'http:\n  routers: {}\n';
  writeFileSync(configPath, originalContent);

  // A stub `cat` that always fails: the write step's `cat > "$TMP_0"` is the
  // first command after the temp file is created, and nothing in the
  // restore path uses cat, so the failure lands exactly between mktemp and
  // mv -f.
  const catPath = join(stubDir, 'cat');
  writeFileSync(catPath, '#!/bin/sh\nexit 1\n');
  chmodSync(catPath, 0o755);

  const files: FileSpec[] = [{ path: configPath, content: 'http:\n  routers:\n    new: {}\n', mode: 'owned', atomic: true }];
  const scriptPath = posix(join(tmpDir, 'apply.sh'));
  writeFileSync(scriptPath, buildFileDriverScript(files, null, null));

  const env = { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH}` };
  const result = spawnSync('sh', [scriptPath], { env });
  assert.notEqual(result.status, 0, `expected a non-zero exit, got ${result.status}`);
  assert.equal(readFileSync(configPath, 'utf8'), originalContent, 'the original content must be restored byte for byte');
  const leftover = readdirSync(tmpDir).filter((f) => f.startsWith('.bellhop.yml.'));
  assert.deepEqual(leftover, [], 'no .bellhop.yml.* temp file must remain after a write failure');
});
