import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import nodeWindows from 'node-windows';
import { dataDir, inventoryPath } from '../src/lib/paths.ts';
import { importEnvFilesAndUseStore } from '../src/lib/config-import.ts';
import { FIREWALL_RULE_NAME, firewallRuleCommand } from './firewall-rule.ts';

const { Service, elevate } = nodeWindows;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_NAME = 'BellhopWebUI';
const SERVICE_DESCRIPTION = 'Bellhop web dashboard';
const DEFAULT_PORT = 3000;

// Mirrors src/cli.ts/src/web/server.ts (issue #64): data/authentik.env is
// loaded as an environment override, imported once into the settings store,
// and the store registered, all before the loadInventory() call below --
// the one-time requires_auth -> auth_group migration (src/lib/inventory.ts)
// reads the group ladder at DB-open time. If this script is the first thing
// to open a legacy database, an unset ladder here would migrate every gated
// entry onto the built-in default ladder's top rung instead of this
// operator's configured one -- and since requires_auth is dropped in the
// same call, there is no re-running this correctly afterward. Only
// authentik.env is loaded: nothing else this script reads comes from the
// other two files, and the import reads all three regardless.
dotenv.config({ path: path.join(dataDir(), 'authentik.env'), quiet: true });
importEnvFilesAndUseStore(inventoryPath(), dataDir());

type Action = 'install' | 'uninstall';

function resolvePort(): number {
  return process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
}

function buildService(port: number): InstanceType<typeof Service> {
  return new Service({
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    script: path.join(REPO_ROOT, 'src', 'web', 'server.ts'),
    nodeOptions: ['--import', 'tsx'],
    // Runs as LocalSystem, whose own os.homedir() is the SYSTEM profile, not
    // this user's — src/lib/ssh-client.ts reads the SSH private key from
    // os.homedir()/.ssh/, and Node's os.homedir() on Windows reads
    // USERPROFILE first before falling back to the calling account's own
    // profile. Setting it here to *this* (elevated, but still real-user)
    // process's actual home directory lets the LocalSystem-run service find
    // the real SSH key instead of silently falling back to an unreachable
    // Pageant (confirmed live: LocalSystem got "Failed to retrieve
    // identities from agent" on every SSH-touching command until this was
    // added).
    env: [
      { name: 'PORT', value: String(port) },
      { name: 'USERPROFILE', value: homedir() },
    ],
    workingDirectory: REPO_ROOT,
  });
}

function isElevated(): boolean {
  // `net session` only succeeds when the current process token is actually
  // elevated — unlike node-windows's own `isAdminUser`, which checks
  // Administrators-group membership and returns true even from a
  // non-elevated shell on a single-admin-account machine (confirmed live:
  // it reported `true` here while `netsh` still failed with "requires
  // elevation").
  try {
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function relaunchElevated(action: Action): Promise<void> {
  const scriptPath = fileURLToPath(import.meta.url);
  const cmd = `"${process.execPath}" --import tsx "${scriptPath}" ${action}`;
  return new Promise((resolve, reject) => {
    elevate(cmd, (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error) reject(error);
      else resolve();
    });
  });
}

function removeFirewallRule(): void {
  try {
    execSync(`netsh advfirewall firewall delete rule name="${FIREWALL_RULE_NAME}"`, { stdio: 'ignore' });
  } catch {
    // no matching rule — nothing to remove
  }
}

function addFirewallRule(port: number): void {
  removeFirewallRule(); // avoid duplicate rules if install runs more than once
  execSync(firewallRuleCommand(port), { stdio: 'inherit' });
}

async function install(): Promise<void> {
  console.log('Building web client...');
  execSync('npm run web:build', { cwd: REPO_ROOT, stdio: 'inherit' });

  const port = resolvePort();
  const svc = buildService(port);

  console.log(`Installing service "${SERVICE_NAME}"...`);
  const outcome = await new Promise<'install' | 'alreadyinstalled'>((resolve, reject) => {
    svc.on('install', () => resolve('install'));
    svc.on('alreadyinstalled', () => resolve('alreadyinstalled'));
    svc.on('invalidinstallation', () =>
      reject(
        new Error(
          `Service "${SERVICE_NAME}" has an invalid/partial installation — run "npm run service:uninstall" first.`
        )
      )
    );
    svc.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
    svc.install();
  });

  if (outcome === 'alreadyinstalled') {
    console.log(
      `Service "${SERVICE_NAME}" was already installed — leaving it running as-is. ` +
        'Run "npm run service:uninstall" first if you need to pick up config changes.'
    );
  } else {
    console.log('Starting service...');
    await new Promise<void>((resolve, reject) => {
      svc.on('start', () => resolve());
      svc.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
      svc.start();
    });
  }

  console.log(`Opening firewall for TCP port ${port}...`);
  addFirewallRule(port);

  console.log(`Done. Service "${SERVICE_NAME}" is installed and listening on port ${port}.`);
}

async function uninstall(): Promise<void> {
  const svc = buildService(resolvePort());

  console.log(`Stopping service "${SERVICE_NAME}" if running...`);
  await new Promise<void>((resolve) => {
    svc.on('stop', () => resolve());
    svc.on('error', () => resolve()); // not running / not installed — proceed to uninstall anyway
    svc.stop();
  });

  console.log(`Uninstalling service "${SERVICE_NAME}"...`);
  await new Promise<void>((resolve, reject) => {
    svc.on('uninstall', () => resolve());
    svc.on('alreadyuninstalled', () => resolve());
    svc.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
    svc.uninstall();
  });

  console.log('Removing firewall rule...');
  removeFirewallRule();

  console.log(`Service "${SERVICE_NAME}" uninstalled.`);
}

async function main(): Promise<void> {
  const action = process.argv[2] as Action | undefined;
  if (action !== 'install' && action !== 'uninstall') {
    console.error('Usage: tsx scripts/windows-service.ts <install|uninstall>');
    process.exit(1);
  }

  if (!isElevated()) {
    console.log('Administrator privileges required — requesting elevation (a UAC prompt will appear)...');
    await relaunchElevated(action);
    return;
  }

  if (action === 'install') await install();
  else await uninstall();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
