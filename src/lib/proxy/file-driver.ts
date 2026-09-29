import { runRemote } from '../targets.ts';
import type { ProxyContext, ProxyRoute } from './routes.ts';
import type { DriverCapabilities, DriverDeps, ProxyPlan, ReverseProxyDriver } from './driver.ts';
import type { ProxyDriverId } from './ids.ts';
import { settingFix } from '../settings-hint.ts';

export interface FileSpec {
  path: string;
  // What a driver's render() returns: the whole file ('owned') or only the
  // managed block's body ('managed-section'). fileDriver's plan() wraps a
  // body in the markers below, so the FileSpecs in a plan's payload -- and
  // those buildFileDriverScript writes -- carry the markers already.
  content: string;
  // 'owned': fileDriver replaces the whole file. 'managed-section': it
  // replaces only the `# BEGIN bellhop-managed` ... `# END bellhop-managed`
  // block (appending it if absent), leaving everything else on the file
  // untouched -- see data-model.md "FileSpec (file drivers)".
  mode: 'owned' | 'managed-section';
  // 'owned' only: the exact first line an existing file must start with
  // for an apply to replace it. proxyConfigPath is shared across drivers,
  // so it can still point at another driver's file (a Caddyfile left over
  // from the Caddy driver, say) -- an owned-mode apply would otherwise
  // replace that file whole, and the new driver's own validate command
  // would still pass since it never reads it. Omitted means no check.
  ownedHeader?: string;
}

// The one definition of the managed-section markers: fileDriver both writes
// them (wrapManagedSection) and strips the old block by them
// (buildFileDriverScript), so a driver never spells them itself.
const BEGIN_MARKER = '# BEGIN bellhop-managed';
const END_MARKER = '# END bellhop-managed';

// A managed-section body wrapped in the markers. An empty body (no routes)
// is the two markers alone, with no blank line between them.
export function wrapManagedSection(body: string): string {
  return [BEGIN_MARKER, ...(body === '' ? [] : [body]), END_MARKER].join('\n');
}

// Single-quote escaping for embedding a path or command into the generated
// remote shell script -- exported so every other file-configured driver
// (src/lib/proxy/drivers/caddy.ts today) shares this one implementation
// rather than keeping its own duplicate copy.
export function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Builds the POSIX `sh` script `fileDriver`'s apply() sends over `runRemote`
// (research.md R6): back up every file (or record that it did not exist),
// write each file's new content in place, run the validate command against
// the real paths, restore every backup and exit non-zero on failure,
// otherwise remove the backups and reload. The file list is fixed at
// script-generation time, so each file's steps are unrolled literally rather
// than driven by a runtime loop -- POSIX sh has no arrays, and unrolling
// keeps every step legible in the generated text.
//
// Restoring on failure is handled by one `trap ... EXIT`, installed right
// after every backup completes, rather than a restore block duplicated at
// each place the script can fail: a write-phase command failing under
// `set -e` (a `cat`/`sed`/`cp` erroring, e.g. a target directory vanishing)
// exits non-zero exactly the same way the explicit `exit 1` after a failed
// validate does, and both need the same restore. The trap fires on *any*
// non-zero exit once installed, so the validate-failure branch only has to
// print its own message and `exit 1`; the trap does the actual restoring
// either way. An EXIT trap does not run when the shell is killed by a
// signal (dash, for one, just dies), so HUP, INT, and TERM get their own
// trap that runs the same restore and exits 1 -- clearing every trap first
// so the restore never runs twice. All four are disarmed together
// (`trap - EXIT HUP INT TERM`) right before backups are removed and the
// reload runs, so a reload failure is never treated as a reason to
// restore: reload always runs against the new, already-validated
// configuration.
export function buildFileDriverScript(files: FileSpec[], validateCommand: string, reloadCommand: string): string {
  const lines: string[] = ['set -e'];

  // 0. Refuse to replace an existing owned file this driver didn't write
  // (its first line isn't the driver's ownedHeader). Runs before any
  // backup, trap, or write, so a refusal leaves every file untouched and
  // needs no restore.
  files.forEach((file) => {
    if (file.mode !== 'owned' || file.ownedHeader === undefined) return;
    const p = singleQuote(file.path);
    const message =
      `Refusing to replace ${file.path}: the file exists but was not written by this proxy driver ` +
      `(its first line is not the driver's generated header). To use this driver, point proxyConfigPath ` +
      `at a different file (bellhop set-config proxyConfigPath <path> --apply, or ` +
      `bellhop set-config proxyConfigPath --unset --apply for the driver's default), or remove the file.`;
    lines.push(`if [ -f ${p} ] && [ "$(head -n 1 ${p})" != ${singleQuote(file.ownedHeader)} ]; then`);
    lines.push(`  printf '%s\\n' ${singleQuote(message)} >&2`);
    lines.push('  exit 1');
    lines.push('fi');
  });

  // 1. Back up each file, or record that it did not exist.
  files.forEach((file, i) => {
    const p = singleQuote(file.path);
    lines.push(`BAK_${i}="$(mktemp)"`);
    lines.push(`if [ -f ${p} ]; then`);
    lines.push(`  cp ${p} "$BAK_${i}"`);
    lines.push(`  EXISTED_${i}=1`);
    lines.push('else');
    lines.push(`  EXISTED_${i}=0`);
    lines.push('fi');
  });

  // Install the restore-on-failure trap now that every backup exists -- a
  // failure during the backup phase itself needs no restore, since nothing
  // has been written yet.
  lines.push('bellhop_restore_all() {');
  files.forEach((file, i) => {
    const p = singleQuote(file.path);
    lines.push(`  if [ "$EXISTED_${i}" = "1" ]; then`);
    lines.push(`    cp "$BAK_${i}" ${p}`);
    lines.push('  else');
    lines.push(`    rm -f ${p}`);
    lines.push('  fi');
    lines.push(`  rm -f "$BAK_${i}"`);
  });
  lines.push('}');
  lines.push('trap \'BELLHOP_STATUS=$?; if [ "$BELLHOP_STATUS" != "0" ]; then bellhop_restore_all; fi\' EXIT');
  lines.push('bellhop_on_signal() {');
  lines.push('  trap - EXIT HUP INT TERM');
  lines.push('  bellhop_restore_all');
  lines.push("  printf 'interrupted; restored previous configuration\\n' >&2");
  lines.push('  exit 1');
  lines.push('}');
  lines.push('trap bellhop_on_signal HUP INT TERM');

  // 2. Write each file's new content in place.
  files.forEach((file, i) => {
    const p = singleQuote(file.path);
    const heredocTag = `BELLHOP_FILE_${i}`;
    if (file.mode === 'owned') {
      lines.push(`cat > ${p} <<'${heredocTag}'`);
      lines.push(file.content);
      lines.push(heredocTag);
    } else {
      lines.push(`TMP_${i}="$(mktemp)"`);
      lines.push(`if [ -f ${p} ] && grep -q '${BEGIN_MARKER}' ${p} 2>/dev/null; then`);
      lines.push(`  sed '/${BEGIN_MARKER}/,/${END_MARKER}/d' ${p} > "$TMP_${i}"`);
      lines.push(`elif [ -f ${p} ]; then`);
      lines.push(`  cp ${p} "$TMP_${i}"`);
      lines.push('else');
      lines.push(`  : > "$TMP_${i}"`);
      lines.push('fi');
      lines.push(`cat >> "$TMP_${i}" <<'${heredocTag}'`);
      lines.push(file.content);
      lines.push(heredocTag);
      lines.push(`cat "$TMP_${i}" > ${p}`);
      lines.push(`rm -f "$TMP_${i}"`);
    }
  });

  // 3. Validate; on failure the trap above restores every backup (removing
  // files that did not exist before) once this exits non-zero.
  lines.push(`if ! ${validateCommand}; then`);
  lines.push(`  printf '%s failed; restored previous configuration\\n' ${singleQuote(validateCommand)} >&2`);
  lines.push('  exit 1');
  lines.push('fi');

  // 4. Disarm every trap, remove backups, reload.
  lines.push('trap - EXIT HUP INT TERM');
  files.forEach((_file, i) => lines.push(`rm -f "$BAK_${i}"`));
  lines.push(reloadCommand);

  return lines.join('\n');
}

// One remote command that `cat`s every file, adding a `==> <path> <==`
// header per file only when there is more than one -- mirrors `head`'s
// multi-file header convention (plain `cat` has none of its own), since a
// single-file driver's snapshot should read exactly like `cat <path>` with
// nothing extra.
function buildSnapshotCommand(paths: string[]): string {
  if (paths.length <= 1) {
    return paths.map((p) => `cat ${singleQuote(p)}`).join('; ') || 'true';
  }
  return paths.map((p) => `echo ${singleQuote(`==> ${p} <==`)}; cat ${singleQuote(p)}`).join('; ');
}

// DriverDeps.configPath is null only for a driver with usesConfigFile: false
// (issue #26), which a fileDriver never is -- driverDeps() always resolves a
// path for one. Throwing the same message driverDeps() uses for a missing
// default keeps a wiring mistake from surfacing as a remote `cat 'null'`.
function requireConfigPath(id: ProxyDriverId, deps: DriverDeps): string {
  if (deps.configPath === null) {
    throw new Error(`The '${id}' proxy driver has no default config path -- ${settingFix('proxyConfigPath', '</absolute/path>')}`);
  }
  return deps.configPath;
}

// Builds a ReverseProxyDriver for a proxy that's configured entirely by
// files delivered to the proxy host (Caddy and nginx today, issue #30;
// HAProxy is a candidate future driver). Owns the full
// render -> back up -> write -> validate -> restore-or-reload cycle so a
// new file-configured driver only has to supply `render`, its validate
// command, and its reload command.
export function fileDriver(def: {
  id: ProxyDriverId;
  // The Settings page's dropdown label. Required so a new driver can never
  // silently show up there as its bare id.
  label: string;
  capabilities: DriverCapabilities;
  // Always a real path here, never null -- a file-configured driver always
  // has a file (data-model.md "ReverseProxyDriver (extended)": only the
  // 'none' driver's own defaultConfigPath is null).
  defaultConfigPath: string;
  // null = this driver serves no status page. Required rather than
  // defaulted, so a new driver has to decide whether it serves one instead
  // of quietly opting out by omission.
  statusPage: { suggestedPath: string } | null;
  // See ReverseProxyDriver in ./driver.ts -- both optional, absent = false/
  // no note.
  usesSharedCertificate?: boolean;
  configPathNote?: string;
  render(routes: ProxyRoute[], ctx: ProxyContext, configPath: string): FileSpec[];
  validateCommand(configPath: string): string;
  reloadCommand: string;
  // The absolute paths snapshot() reads, given the resolved configPath --
  // defaults to `[configPath]` (right for every single-file driver, Caddy
  // included). Deliberately independent of `render`: snapshot is read-only
  // and must work even when the current inventory is invalid or unloadable
  // (a bad unauthenticatedPaths entry, a missing authentik ip, ...) --
  // deriving paths from routes/ctx/render would make a read-only status
  // page fail right alongside a real sync-proxy error.
  configFiles?(configPath: string): string[];
}): ReverseProxyDriver {
  return {
    id: def.id,
    label: def.label,
    capabilities: def.capabilities,
    defaultConfigPath: def.defaultConfigPath,
    statusPage: def.statusPage,
    ...(def.usesSharedCertificate !== undefined ? { usesSharedCertificate: def.usesSharedCertificate } : {}),
    ...(def.configPathNote !== undefined ? { configPathNote: def.configPathNote } : {}),

    async plan(routes: ProxyRoute[], ctx: ProxyContext, deps: DriverDeps): Promise<ProxyPlan> {
      const files = def
        .render(routes, ctx, requireConfigPath(def.id, deps))
        .map((f) => (f.mode === 'managed-section' ? { ...f, content: wrapManagedSection(f.content) } : f));
      return { preview: files.map((f) => f.content).join('\n'), payload: files };
    },

    async apply(plan: ProxyPlan, deps: DriverDeps): Promise<void> {
      const files = plan.payload as FileSpec[];
      const validateCommand = def.validateCommand(requireConfigPath(def.id, deps));
      const script = buildFileDriverScript(files, validateCommand, def.reloadCommand);
      const result = await runRemote(deps.ssh, deps.inventory, deps.proxyHost, script);
      if (result.code !== 0) {
        throw new Error(`Failed to apply proxy configuration on '${deps.proxyHost}': ${result.stderr || result.stdout}`);
      }
    },

    async snapshot(deps: DriverDeps): Promise<string> {
      const paths = (def.configFiles ?? ((configPath: string) => [configPath]))(requireConfigPath(def.id, deps));
      const command = buildSnapshotCommand(paths);
      const result = await runRemote(deps.ssh, deps.inventory, deps.proxyHost, command);
      if (result.code !== 0) {
        throw new Error(
          `Failed to read the deployed proxy configuration from '${deps.proxyHost}': ${result.stderr || result.stdout}`
        );
      }
      return result.stdout;
    },
  };
}
