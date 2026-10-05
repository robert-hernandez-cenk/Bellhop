import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadInventory, saveInventory, type Inventory } from '../../src/lib/inventory.ts';
import { runSetConfig, resolveSetConfigValue } from '../../src/commands/maintenance/set-config.ts';
import Database from 'better-sqlite3';
import { writeSecret } from '../../src/lib/config.ts';
import { captureWarnings } from '../support/capture-warnings.ts';

const FIXTURE: Inventory = {
  domain: 'example.com',
  hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root' }],
  guests: [],
};

function tempInventoryPath(inv: Inventory = FIXTURE): string {
  const dest = path.join(mkdtempSync(path.join(tmpdir(), 'inventory-')), 'bellhop.db');
  saveInventory(dest, inv);
  return dest;
}

test('runSetConfig writes a value with --apply', () => {
  const inventoryPath = tempInventoryPath();
  const result = runSetConfig({ key: 'dnsServer', value: '10.0.0.53', apply: true }, { inventoryPath });
  assert.equal(result.applied, true);
  assert.equal(loadInventory(inventoryPath).dnsServer, '10.0.0.53');
});

test('runSetConfig writes nothing on a dry run', () => {
  const inventoryPath = tempInventoryPath();
  const result = runSetConfig({ key: 'dnsServer', value: '10.0.0.53' }, { inventoryPath });
  assert.equal(result.applied, false);
  assert.equal(loadInventory(inventoryPath).dnsServer, undefined);
});

test('runSetConfig --unset clears an existing value', () => {
  const inventoryPath = tempInventoryPath({ ...FIXTURE, dnsServer: '10.0.0.53' });
  runSetConfig({ key: 'dnsServer', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).dnsServer, undefined);
});

test('runSetConfig rejects an unknown key', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'domain', value: 'other.com', apply: true }, { inventoryPath }),
    /Unknown setting 'domain'/
  );
});

test('runSetConfig rejects a value the schema refuses', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'statusPagePath', value: 'relative/path.html', apply: true }, { inventoryPath }),
    /must be an absolute path/
  );
});

test('runSetConfig requires a value when not unsetting', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'dnsServer', apply: true }, { inventoryPath }),
    /requires a value/
  );
});

test('runSetConfig round-trips customScriptsRepo through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'customScriptsRepo', value: 'example-user/ProxmoxVED', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).customScriptsRepo, 'example-user/ProxmoxVED');
  runSetConfig({ key: 'customScriptsRepo', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).customScriptsRepo, undefined);
});

test('runSetConfig round-trips customScriptsBranch through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'customScriptsBranch', value: 'my-apps', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).customScriptsBranch, 'my-apps');
  runSetConfig({ key: 'customScriptsBranch', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).customScriptsBranch, undefined);
});

test('runSetConfig rejects a customScriptsRepo not shaped like owner/repo', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'customScriptsRepo', value: 'not-a-repo', apply: true }, { inventoryPath }),
    /must be owner\/repo/
  );
});

test('runSetConfig rejects a customScriptsBranch that looks like a path traversal', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'customScriptsBranch', value: '../x', apply: true }, { inventoryPath }),
    /must be a valid git branch name/
  );
});

test('runSetConfig allows setting only customScriptsRepo without customScriptsBranch', () => {
  // The both-or-neither rule is enforced at the point of use
  // (customScriptSource), not by SettingsSchema -- set-config writes one
  // key at a time, so this must succeed on its own.
  const inventoryPath = tempInventoryPath();
  const result = runSetConfig(
    { key: 'customScriptsRepo', value: 'example-user/ProxmoxVED', apply: true },
    { inventoryPath }
  );
  assert.equal(result.applied, true);
  assert.equal(loadInventory(inventoryPath).customScriptsRepo, 'example-user/ProxmoxVED');
  assert.equal(loadInventory(inventoryPath).customScriptsBranch, undefined);
});

test('runSetConfig round-trips proxyDriver through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyDriver', value: 'caddy', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyDriver, 'caddy');
  runSetConfig({ key: 'proxyDriver', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyDriver, undefined);
});

test('runSetConfig rejects an unknown proxyDriver', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(() => runSetConfig({ key: 'proxyDriver', value: 'unknown-provider', apply: true }, { inventoryPath }), /proxyDriver/);
  assert.equal(loadInventory(inventoryPath).proxyDriver, undefined);
});

test('runSetConfig round-trips proxyConfigPath through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyConfigPath', value: '/etc/caddy/Caddyfile', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyConfigPath, '/etc/caddy/Caddyfile');
  runSetConfig({ key: 'proxyConfigPath', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyConfigPath, undefined);
});

test('runSetConfig rejects a relative proxyConfigPath', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'proxyConfigPath', value: 'etc/caddy/Caddyfile', apply: true }, { inventoryPath }),
    /must be an absolute path/
  );
});

test('runSetConfig round-trips proxyTlsCertificate through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig(
    { key: 'proxyTlsCertificate', value: '/etc/ssl/example/fullchain.pem', apply: true },
    { inventoryPath }
  );
  assert.equal(loadInventory(inventoryPath).proxyTlsCertificate, '/etc/ssl/example/fullchain.pem');
  runSetConfig({ key: 'proxyTlsCertificate', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyTlsCertificate, undefined);
});

test('runSetConfig rejects a relative proxyTlsCertificate', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () =>
      runSetConfig(
        { key: 'proxyTlsCertificate', value: 'etc/ssl/example/fullchain.pem', apply: true },
        { inventoryPath }
      ),
    /proxyTlsCertificate: must be an absolute path/
  );
});

test('runSetConfig round-trips proxyTlsKey through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyTlsKey', value: '/etc/ssl/example/privkey.pem', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyTlsKey, '/etc/ssl/example/privkey.pem');
  runSetConfig({ key: 'proxyTlsKey', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyTlsKey, undefined);
});

test('runSetConfig rejects a relative proxyTlsKey', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () =>
      runSetConfig({ key: 'proxyTlsKey', value: 'etc/ssl/example/privkey.pem', apply: true }, { inventoryPath }),
    /proxyTlsKey: must be an absolute path/
  );
});

test('runSetConfig round-trips proxyCertResolver through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyCertResolver', value: 'cloudflare', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyCertResolver, 'cloudflare');
  runSetConfig({ key: 'proxyCertResolver', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyCertResolver, undefined);
});

test('runSetConfig rejects a proxyCertResolver with characters other than letters, digits, - and _', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'proxyCertResolver', value: 'my resolver', apply: true }, { inventoryPath }),
    /proxyCertResolver: must contain only letters, digits, - and _/
  );
});

test('runSetConfig round-trips proxyApiUrl through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyApiUrl', value: 'http://192.0.2.5:8080', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyApiUrl, 'http://192.0.2.5:8080');
  runSetConfig({ key: 'proxyApiUrl', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyApiUrl, undefined);
});

test('runSetConfig rejects a proxyApiUrl with a scheme other than http/https', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'proxyApiUrl', value: 'ftp://192.0.2.5', apply: true }, { inventoryPath }),
    /proxyApiUrl: must be an http:\/\/ or https:\/\/ URL/
  );
});

// issue #51: proxyCaddyTls is the two Caddy drivers' own setting -- same
// round-trip/rejection pattern as proxyCertResolver above.
test('runSetConfig round-trips proxyCaddyTls through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyCaddyTls', value: 'internal', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyCaddyTls, 'internal');
  runSetConfig({ key: 'proxyCaddyTls', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyCaddyTls, undefined);
});

test('runSetConfig round-trips every proxyCaddyTls mode through --apply', () => {
  const inventoryPath = tempInventoryPath();
  for (const mode of ['cloudflare', 'letsencrypt', 'internal', 'files']) {
    runSetConfig({ key: 'proxyCaddyTls', value: mode, apply: true }, { inventoryPath });
    assert.equal(loadInventory(inventoryPath).proxyCaddyTls, mode);
  }
});

test('runSetConfig rejects a proxyCaddyTls value outside the four modes', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'proxyCaddyTls', value: 'bogus', apply: true }, { inventoryPath }),
    /proxyCaddyTls/
  );
  assert.equal(loadInventory(inventoryPath).proxyCaddyTls, undefined);
});

test('runSetConfig round-trips proxyDriver nginx through --apply', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'proxyDriver', value: 'nginx', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).proxyDriver, 'nginx');
});

// issue #53, US3 (T014): pveUserRealm/pveCreatorRole, the Proxmox
// creator-grant settings -- set-config validates both against the same
// SettingsSchema regexes PATCH /api/settings uses (see
// test/web/routes/settings.test.ts), so the two front ends reject the
// same bad value with the same message.
test('runSetConfig round-trips pveUserRealm through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'pveUserRealm', value: 'authentik', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).pveUserRealm, 'authentik');
  runSetConfig({ key: 'pveUserRealm', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).pveUserRealm, undefined);
});

test('runSetConfig rejects a pveUserRealm that does not start with a letter', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'pveUserRealm', value: '1realm', apply: true }, { inventoryPath }),
    /pveUserRealm: must start with a letter and contain only letters, digits, \., - and _/
  );
  assert.equal(loadInventory(inventoryPath).pveUserRealm, undefined);
});

test('runSetConfig rejects a pveUserRealm with an invalid character', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'pveUserRealm', value: 'my realm', apply: true }, { inventoryPath }),
    /pveUserRealm: must start with a letter and contain only letters, digits, \., - and _/
  );
});

test('runSetConfig round-trips pveCreatorRole through --apply and --unset', () => {
  const inventoryPath = tempInventoryPath();
  runSetConfig({ key: 'pveCreatorRole', value: 'PVEVMAdmin', apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).pveCreatorRole, 'PVEVMAdmin');
  runSetConfig({ key: 'pveCreatorRole', unset: true, apply: true }, { inventoryPath });
  assert.equal(loadInventory(inventoryPath).pveCreatorRole, undefined);
});

test('runSetConfig rejects a pveCreatorRole with an invalid character', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'pveCreatorRole', value: 'My Role', apply: true }, { inventoryPath }),
    /pveCreatorRole: must contain only letters, digits, \., - and _/
  );
  assert.equal(loadInventory(inventoryPath).pveCreatorRole, undefined);
});

// -- Issue #64 US5: a key pinned by the CLI's own environment ---------------

test('runSetConfig still stores a key its env var pins, with the contract warning', async () => {
  const saved = process.env.AUTHENTIK_OUTPOST_NAME;
  process.env.AUTHENTIK_OUTPOST_NAME = 'example env outpost';
  try {
    const inventoryPath = tempInventoryPath();
    const { result, warnings } = await captureWarnings(async () =>
      runSetConfig({ key: 'authentikOutpostName', value: 'stored outpost', apply: true }, { inventoryPath })
    );
    assert.equal(result.applied, true);
    assert.equal(loadInventory(inventoryPath).authentikOutpostName, 'stored outpost');
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /AUTHENTIK_OUTPOST_NAME is set in this environment and overrides the stored authentikOutpostName$/
    );
  } finally {
    if (saved === undefined) delete process.env.AUTHENTIK_OUTPOST_NAME;
    else process.env.AUTHENTIK_OUTPOST_NAME = saved;
  }
});

test('runSetConfig does not warn when the env var is unset or empty, or the key has none', async () => {
  const saved = process.env.AUTHENTIK_OUTPOST_NAME;
  process.env.AUTHENTIK_OUTPOST_NAME = '';
  try {
    const inventoryPath = tempInventoryPath();
    const { warnings } = await captureWarnings(async () => {
      runSetConfig({ key: 'authentikOutpostName', value: 'stored outpost', apply: true }, { inventoryPath });
      runSetConfig({ key: 'dnsServer', value: '10.0.0.53', apply: true }, { inventoryPath });
    });
    assert.deepEqual(warnings, []);
  } finally {
    if (saved === undefined) delete process.env.AUTHENTIK_OUTPOST_NAME;
    else process.env.AUTHENTIK_OUTPOST_NAME = saved;
  }
});

// -- Issue #64 US2: secrets are write-only ------------------------------------

// Captures everything logInfo (console.log) and logWarn (console.error) print.
async function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    return { result: await fn(), output: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function secretRows(inventoryPath: string): { meta: string[]; secrets: Record<string, string> } {
  const db = new Database(inventoryPath, { readonly: true });
  try {
    return {
      meta: (db.prepare('SELECT key FROM meta').all() as { key: string }[]).map((r) => r.key),
      secrets: Object.fromEntries(
        (db.prepare('SELECT key, value FROM secret_settings').all() as { key: string; value: string }[]).map((r) => [r.key, r.value])
      ),
    };
  } finally {
    db.close();
  }
}

test('runSetConfig --apply stores a secret in secret_settings, never logs or returns its value', async () => {
  const inventoryPath = tempInventoryPath();
  const { result, output } = await captureConsole(() =>
    runSetConfig({ key: 'authentikApiToken', value: 'example-token-SETCFG-MARKER', apply: true }, { inventoryPath })
  );
  assert.equal(result.applied, true);
  assert.equal(result.secret, true);
  assert.equal(result.value, undefined);
  assert.ok(!JSON.stringify(result).includes('SETCFG-MARKER'));
  assert.match(output, /Would set authentikApiToken \(value hidden\)/);
  assert.ok(!output.includes('SETCFG-MARKER'));
  const rows = secretRows(inventoryPath);
  assert.equal(rows.secrets.authentikApiToken, 'example-token-SETCFG-MARKER');
  assert.ok(!rows.meta.includes('authentikApiToken'));
});

test('runSetConfig dry run of a secret prints the hidden line and writes nothing', async () => {
  const inventoryPath = tempInventoryPath();
  const { result, output } = await captureConsole(() =>
    runSetConfig({ key: 'githubApiToken', value: 'example-github-DRY-MARKER' }, { inventoryPath })
  );
  assert.equal(result.applied, false);
  assert.match(output, /\[DRY RUN\] Would set githubApiToken \(value hidden\)$/);
  assert.ok(!output.includes('DRY-MARKER'));
  assert.deepEqual(secretRows(inventoryPath).secrets, {});
});

test('runSetConfig --unset clears a secret', async () => {
  const inventoryPath = tempInventoryPath();
  writeSecret(inventoryPath, 'npmApiPassword', 'example npm password');
  const { result, output } = await captureConsole(() =>
    runSetConfig({ key: 'npmApiPassword', unset: true, apply: true }, { inventoryPath })
  );
  assert.equal(result.cleared, true);
  assert.match(output, /Would clear npmApiPassword/);
  assert.deepEqual(secretRows(inventoryPath).secrets, {});
});

test('runSetConfig rejects an invalid secret naming the key, never the value', () => {
  const inventoryPath = tempInventoryPath();
  assert.throws(
    () => runSetConfig({ key: 'cloudflareDnsApiToken', value: 'has space BAD-MARKER', apply: true }, { inventoryPath }),
    (err: Error) => err.message === 'cloudflareDnsApiToken: must not contain whitespace'
  );
  assert.deepEqual(secretRows(inventoryPath).secrets, {});
});

test('runSetConfig still reports a non-secret value, and the unknown-key error lists secrets too', () => {
  const inventoryPath = tempInventoryPath();
  const result = runSetConfig({ key: 'dnsServer', value: '192.0.2.53', apply: true }, { inventoryPath });
  assert.deepEqual(result, { key: 'dnsServer', value: '192.0.2.53', secret: false, cleared: false, applied: true });
  assert.throws(() => runSetConfig({ key: 'nope', value: 'x' }, { inventoryPath }), /known settings: .*githubApiToken/);
});

test('runSetConfig warns when a secret is pinned by this environment, naming only the variable', async () => {
  const saved = process.env.GITHUB_API_TOKEN;
  process.env.GITHUB_API_TOKEN = 'example-github-ENVPIN-MARKER';
  try {
    const inventoryPath = tempInventoryPath();
    const { output } = await captureConsole(() =>
      runSetConfig({ key: 'githubApiToken', value: 'example-github-stored', apply: true }, { inventoryPath })
    );
    assert.match(output, /GITHUB_API_TOKEN is set in this environment and overrides the stored githubApiToken/);
    assert.ok(!output.includes('ENVPIN-MARKER') && !output.includes('example-github-stored'));
  } finally {
    if (saved === undefined) delete process.env.GITHUB_API_TOKEN;
    else process.env.GITHUB_API_TOKEN = saved;
  }
});

// resolveSetConfigValue is the CLI's input step: it never touches the real
// stdin here, only the injected reader/prompt.
function fakeInput(opts: { isTTY?: boolean; stdin?: string; answer?: string } = {}) {
  const prompts: string[] = [];
  const reads = { count: 0 };
  return {
    prompts,
    reads,
    input: {
      isTTY: opts.isTTY ?? false,
      readStdin: async () => {
        reads.count++;
        return opts.stdin ?? '';
      },
      prompt: async (question: string) => {
        prompts.push(question);
        return opts.answer ?? '';
      },
    },
  };
}

test('resolveSetConfigValue refuses a secret passed as an argument, with the contract message', async () => {
  await assert.rejects(
    resolveSetConfigValue({ key: 'authentikApiToken', value: 'example-token' }, fakeInput().input),
    (err: Error) =>
      err.message ===
      'authentikApiToken is a secret -- pass it on standard input with --stdin (or omit the value to be prompted), never as an argument'
  );
});

test('resolveSetConfigValue --stdin strips exactly one trailing newline', async () => {
  const read = (stdin: string) => resolveSetConfigValue({ key: 'npmApiPassword', stdin: true }, fakeInput({ stdin }).input);
  assert.equal(await read('example-pw\r\n'), 'example-pw');
  assert.equal(await read('example-pw\n'), 'example-pw');
  assert.equal(await read('example-pw\n\n'), 'example-pw\n');
  assert.equal(await read('example-pw'), 'example-pw');
});

test('resolveSetConfigValue --stdin refuses an empty value, naming --unset', async () => {
  await assert.rejects(
    resolveSetConfigValue({ key: 'githubApiToken', stdin: true }, fakeInput({ stdin: '\n' }).input),
    /githubApiToken: no value on standard input -- use --unset to clear it/
  );
});

test('resolveSetConfigValue prompts for a secret on a TTY, and refuses without one', async () => {
  const tty = fakeInput({ isTTY: true, answer: 'example-token' });
  assert.equal(await resolveSetConfigValue({ key: 'cloudflareDnsApiToken' }, tty.input), 'example-token');
  assert.deepEqual(tty.prompts, ['Value for cloudflareDnsApiToken: ']);

  await assert.rejects(resolveSetConfigValue({ key: 'cloudflareDnsApiToken' }, fakeInput({ isTTY: true }).input), /--unset/);

  const pipe = fakeInput({ isTTY: false });
  await assert.rejects(
    resolveSetConfigValue({ key: 'cloudflareDnsApiToken' }, pipe.input),
    /cloudflareDnsApiToken is a secret and standard input is not a terminal -- pass the value with --stdin/
  );
  assert.equal(pipe.reads.count, 0);
});

test('resolveSetConfigValue: --unset needs no value, and a non-secret takes an argument or --stdin', async () => {
  assert.equal(await resolveSetConfigValue({ key: 'authentikApiToken', unset: true }, fakeInput().input), undefined);
  assert.equal(await resolveSetConfigValue({ key: 'dnsServer', value: '192.0.2.53' }, fakeInput().input), '192.0.2.53');
  assert.equal(await resolveSetConfigValue({ key: 'dnsServer', stdin: true }, fakeInput({ stdin: '192.0.2.53\n' }).input), '192.0.2.53');
  const tty = fakeInput({ isTTY: true });
  assert.equal(await resolveSetConfigValue({ key: 'dnsServer' }, tty.input), undefined, 'a non-secret is never prompted');
  assert.deepEqual(tty.prompts, []);
  await assert.rejects(
    resolveSetConfigValue({ key: 'dnsServer', value: '192.0.2.53', stdin: true }, fakeInput().input),
    /either a value or --stdin, not both/
  );
});

test('resolveSetConfigValue refuses a secret passed as an argument even with --unset (final review M9)', async () => {
  await assert.rejects(
    resolveSetConfigValue({ key: 'npmApiPassword', value: 'example-pw', unset: true }, fakeInput().input),
    (err: Error) =>
      err.message ===
      'npmApiPassword is a secret -- pass it on standard input with --stdin (or omit the value to be prompted), never as an argument'
  );
  assert.equal(await resolveSetConfigValue({ key: 'npmApiPassword', unset: true }, fakeInput().input), undefined);
});

// #69 US4 / FR-021: the Settings page refuses oidc until an admin can sign in,
// but the CLI is the recovery path and stays unrestricted.
test('runSetConfig sets webUiAuthMode oidc with no login settings configured', () => {
  const inventoryPath = tempInventoryPath();
  const result = runSetConfig({ key: 'webUiAuthMode', value: 'oidc', apply: true }, { inventoryPath });
  assert.equal(result.applied, true);
  assert.equal(loadInventory(inventoryPath).webUiAuthMode, 'oidc');
});
