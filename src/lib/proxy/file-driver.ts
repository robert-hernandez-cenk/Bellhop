import { posix as posixPath } from 'node:path';
import { runRemote } from '../targets.ts';
import type { Inventory } from '../inventory.ts';
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
  // 'owned' only (research.md R5): write through a same-directory,
  // dot-prefixed temp file (`mktemp '<dir>/.<base>.XXXXXX'`) and `mv -f` it
  // over the real path, instead of truncating the real path in place with
  // `cat >`. For a proxy whose file provider watches the directory and
  // reloads on any change it sees (Traefik), an in-place `cat >` briefly
  // exposes a half-written or empty file to that watcher; a same-filesystem
  // rename is atomic, so the watcher only ever observes the old or the new
  // content, never a partial one. `cp -p`/`chmod 644` before writing is what
  // makes the temp file's mode match the file it is about to replace (a
  // fresh `mktemp` file is 0600), so replacing a non-root-owned file does
  // not lock the proxy out of it. Restoring an atomic file on failure uses
  // the same same-directory-temp-file-then-mv-f convention. Caddy and nginx
  // never set this -- both reload explicitly only after a successful
  // validate, so a partial file is never read by either.
  atomic?: boolean;
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
// The mktemp template for an atomic file's same-directory, dot-prefixed
// temp name -- shared by the write step and the restore step, so the two
// can never drift on the naming convention (research.md R5). posixPath
// (node:path's posix flavor) is used rather than the platform path module
// because the generated script always runs on the remote proxy host's
// POSIX sh, regardless of what OS Bellhop itself runs on (Windows included).
function atomicTempTemplate(filePath: string): string {
  return `${posixPath.dirname(filePath)}/.${posixPath.basename(filePath)}.XXXXXX`;
}

export function buildFileDriverScript(
  files: FileSpec[],
  // null = no validate step at all (Traefik with no proxyApiUrl set,
  // research.md R2) -- the script writes and reloads with nothing checked
  // in between.
  validateCommand: string | null,
  // null = no reload line (Traefik never reloads -- its file provider's own
  // watcher picks up the change once the write lands).
  reloadCommand: string | null,
  // Replaces the command text in the "... failed; restored previous
  // configuration" message when the validate command itself isn't fit to
  // echo back at an operator (Traefik's validate step is a multi-line
  // polling subshell, not a one-line command). Omitted means the command
  // text itself, unchanged for Caddy/nginx.
  validateLabel?: string
): string {
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

  // 1. Back up each file, or record that it did not exist. An atomic file's
  // backup is taken with `cp -p`: the restore below copies the backup with
  // `cp -p` into a fresh temp file and renames that over the real path, so
  // the backup itself must carry the original mode/owner -- a plain `cp`
  // into mktemp's 0600 file would restore a 0600 root-owned file that a
  // non-root proxy can no longer read. Its write-phase temp-file name starts
  // empty before the trap is armed, so the restore can tell whether there
  // is a temp file to clean up. Non-atomic files are unchanged (FR-016).
  files.forEach((file, i) => {
    const p = singleQuote(file.path);
    const atomic = file.mode === 'owned' && file.atomic === true;
    lines.push(`BAK_${i}="$(mktemp)"`);
    lines.push(`if [ -f ${p} ]; then`);
    lines.push(atomic ? `  cp -p ${p} "$BAK_${i}"` : `  cp ${p} "$BAK_${i}"`);
    lines.push(`  EXISTED_${i}=1`);
    lines.push('else');
    lines.push(`  EXISTED_${i}=0`);
    lines.push('fi');
    if (atomic) {
      lines.push(`TMP_${i}=""`);
    }
  });

  // Install the restore-on-failure trap now that every backup exists -- a
  // failure during the backup phase itself needs no restore, since nothing
  // has been written yet.
  lines.push('bellhop_restore_all() {');
  files.forEach((file, i) => {
    const p = singleQuote(file.path);
    if (file.mode === 'owned' && file.atomic) {
      // A write that failed (or was interrupted) between its mktemp and its
      // mv -f leaves the dot-prefixed temp file in the proxy's own watched
      // directory -- remove it first, before the restore's own mktemp.
      lines.push(`  if [ -n "$TMP_${i}" ]; then rm -f "$TMP_${i}"; fi`);
    }
    lines.push(`  if [ "$EXISTED_${i}" = "1" ]; then`);
    if (file.mode === 'owned' && file.atomic) {
      // Same same-directory-temp-file-then-mv-f convention as the write
      // step below, so a restore is never a truncating `cp` either --
      // research.md R5.
      const tmpl = singleQuote(atomicTempTemplate(file.path));
      lines.push(`    RESTORE_${i}="$(mktemp ${tmpl})"`);
      lines.push(`    cp -p "$BAK_${i}" "$RESTORE_${i}"`);
      lines.push(`    mv -f "$RESTORE_${i}" ${p}`);
    } else {
      lines.push(`    cp "$BAK_${i}" ${p}`);
    }
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
    if (file.mode === 'owned' && file.atomic) {
      const tmpl = singleQuote(atomicTempTemplate(file.path));
      lines.push(`TMP_${i}="$(mktemp ${tmpl})"`);
      lines.push(`if [ -f ${p} ]; then cp -p ${p} "$TMP_${i}"; else chmod 644 "$TMP_${i}"; fi`);
      lines.push(`cat > "$TMP_${i}" <<'${heredocTag}'`);
      lines.push(file.content);
      lines.push(heredocTag);
      lines.push(`mv -f "$TMP_${i}" ${p}`);
    } else if (file.mode === 'owned') {
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

  // 3. Validate (when there is one); on failure the trap above restores
  // every backup (removing files that did not exist before) once this
  // exits non-zero. A null validateCommand (Traefik with no proxyApiUrl
  // set) skips this block entirely -- there is nothing to check.
  if (validateCommand !== null) {
    const failureLabel = validateLabel ?? validateCommand;
    lines.push(`if ! ${validateCommand}; then`);
    lines.push(`  printf '%s failed; restored previous configuration\\n' ${singleQuote(failureLabel)} >&2`);
    lines.push('  exit 1');
    lines.push('fi');
  }

  // 4. Disarm every trap, remove backups, reload (when there is one --
  // Traefik's own file-provider watcher picks up the change on its own).
  lines.push('trap - EXIT HUP INT TERM');
  files.forEach((_file, i) => lines.push(`rm -f "$BAK_${i}"`));
  if (reloadCommand !== null) {
    lines.push(reloadCommand);
  }

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

// The part of a file driver's read-only check that differs per driver (issue
// #87): whether the proxy's file or only its directory must already exist (a
// driver that owns its file has none before the first sync), and the proxy's
// own read-only validation of what is live. null = nothing to run.
export interface FileDriverCheck {
  target: 'file' | 'directory';
  command(configPath: string, ctx: { inventory: Inventory }): string | null;
}

// Exit code of the check script's existence test, so the caller can name the
// missing path and the setting that controls it.
// Deliberately unusual: a validator's own exit code (nginx -t, haproxy -c) must never read as a missing path.
const CHECK_MISSING_EXIT = 87;

function checkedPath(configPath: string, check: FileDriverCheck): string {
  return check.target === 'file' ? configPath : posixPath.dirname(configPath);
}

export function buildCheckScript(configPath: string, check: FileDriverCheck, inventory: Inventory): string {
  const flag = check.target === 'file' ? '-f' : '-d';
  const lines = [`[ ${flag} ${singleQuote(checkedPath(configPath, check))} ] || exit ${CHECK_MISSING_EXIT}`];
  const command = check.command(configPath, { inventory });
  if (command !== null) lines.push(command);
  return lines.join('\n');
}

// A dry run's preview of the files an apply would write. One file is its
// content alone, byte for byte; more than one gets the same `==> <path> <==`
// label per file buildSnapshotCommand uses, with a blank line between files,
// so a reader can tell where each one starts. Only the preview is labelled
// -- the payload apply() writes carries each file's content unchanged.
function previewFiles(files: FileSpec[]): string {
  if (files.length <= 1) {
    return files.map((f) => f.content).join('\n');
  }
  return files.map((f) => `==> ${f.path} <==\n${f.content}`).join('\n\n');
}

// Resolves a file-configured driver's own config path out of DriverDeps,
// which types configPath as string | null (issue #31, research.md R11: null
// means the active driver's own defaultConfigPath is null -- a driver with
// no config file at all, e.g. a REST-managed driver like Nginx Proxy
// Manager). Every driver fileDriver builds declares a real
// defaultConfigPath (def.defaultConfigPath below is typed string, never
// null), so driverDeps() never actually returns null for one of these --
// seeing null here would mean a driver was built with fileDriver but
// somehow still resolved to a null configPath, a programming error rather
// than a state reachable through normal use.
function requireConfigPath(deps: DriverDeps, id: ProxyDriverId): string {
  if (deps.configPath === null) {
    throw new Error(`${id} driver requires a config path`);
  }
  return deps.configPath;
}

// Builds a ReverseProxyDriver for a proxy that's configured entirely by
// files delivered to the proxy host (Caddy, nginx -- issue #30 -- and
// HAProxy, issue #32, which owns two files). Owns the full
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
  // See ReverseProxyDriver in ./driver.ts -- all three optional, absent =
  // false/no note.
  usesCertResolver?: boolean;
  usesApiUrl?: boolean;
  configPathNote?: string;
  render(routes: ProxyRoute[], ctx: ProxyContext, configPath: string): FileSpec[];
  // Returns null when there is nothing to validate (Traefik with no
  // proxyApiUrl set, research.md R2) -- buildFileDriverScript then emits no
  // validate step at all. Takes the plan's own files and the inventory
  // (rather than just configPath) because a validate step can need more
  // than the path alone -- Traefik's API check needs every rendered
  // router's name, which only the files themselves carry, and the
  // configured proxyApiUrl, which only the inventory carries.
  validateCommand(configPath: string, ctx: { files: FileSpec[]; inventory: Inventory }): string | null;
  // Replaces the validate command's own text in the failure message --
  // Traefik's validate step is a multi-line polling subshell, not a
  // one-line command worth echoing back at an operator. Omitted means the
  // command text itself (Caddy/nginx, unchanged).
  validateLabel?: string;
  // null = no reload line at all (Traefik: its file provider's own watcher
  // picks up the change once the write lands, so there is nothing to run).
  reloadCommand: string | null;
  // The absolute paths snapshot() reads, given the resolved configPath --
  // defaults to `[configPath]` (right for every single-file driver, Caddy
  // included). Deliberately independent of `render`: snapshot is read-only
  // and must work even when the current inventory is invalid or unloadable
  // (a bad unauthenticatedPaths entry, a missing authentik ip, ...) --
  // deriving paths from routes/ctx/render would make a read-only status
  // page fail right alongside a real sync-proxy error.
  configFiles?(configPath: string): string[];
  // Optional (issue #87): the read-only check, see FileDriverCheck.
  check?: FileDriverCheck;
}): ReverseProxyDriver {
  return {
    id: def.id,
    label: def.label,
    capabilities: def.capabilities,
    defaultConfigPath: def.defaultConfigPath,
    statusPage: def.statusPage,
    ...(def.usesCertResolver !== undefined ? { usesCertResolver: def.usesCertResolver } : {}),
    ...(def.usesApiUrl !== undefined ? { usesApiUrl: def.usesApiUrl } : {}),
    ...(def.configPathNote !== undefined ? { configPathNote: def.configPathNote } : {}),

    async plan(routes: ProxyRoute[], ctx: ProxyContext, deps: DriverDeps): Promise<ProxyPlan> {
      const configPath = requireConfigPath(deps, def.id);
      const files = def
        .render(routes, ctx, configPath)
        .map((f) => (f.mode === 'managed-section' ? { ...f, content: wrapManagedSection(f.content) } : f));
      return { preview: previewFiles(files), payload: files };
    },

    async apply(plan: ProxyPlan, deps: DriverDeps): Promise<void> {
      const configPath = requireConfigPath(deps, def.id);
      const files = plan.payload as FileSpec[];
      const validateCommand = def.validateCommand(configPath, { files, inventory: deps.inventory });
      const script = buildFileDriverScript(files, validateCommand, def.reloadCommand, def.validateLabel);
      const result = await runRemote(deps.ssh, deps.inventory, deps.proxyHost, script);
      if (result.code !== 0) {
        throw new Error(`Failed to apply proxy configuration on '${deps.proxyHost}': ${result.stderr || result.stdout}`);
      }
    },

    ...(def.check
      ? {
          async check(deps: DriverDeps): Promise<string> {
            const spec = def.check!; // safe: this property exists only when def.check does
            const configPath = requireConfigPath(deps, def.id);
            const script = buildCheckScript(configPath, spec, deps.inventory);
            const result = await runRemote(deps.ssh, deps.inventory, deps.proxyHost, script);
            if (result.code === CHECK_MISSING_EXIT) {
              throw new Error(
                `${checkedPath(configPath, spec)} not found on '${deps.proxyHost}' -- is ${def.label} installed there? ` +
                  `Otherwise ${settingFix('proxyConfigPath', '<path>')}`
              );
            }
            if (result.code !== 0) {
              const output = (result.stderr || result.stdout).trim() || `exit code ${result.code}`;
              throw new Error(`${def.label} on '${deps.proxyHost}' did not pass its check: ${output}`);
            }
            return `${def.label} on '${deps.proxyHost}' is present and its configuration is valid`;
          },
        }
      : {}),

    async snapshot(deps: DriverDeps): Promise<string> {
      const configPath = requireConfigPath(deps, def.id);
      const paths = (def.configFiles ?? ((configPath: string) => [configPath]))(configPath);
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
