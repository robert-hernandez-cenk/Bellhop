import { runRemote } from '../targets.ts';
import type { ProxyContext, ProxyRoute } from './routes.ts';
import type { DriverCapabilities, DriverDeps, ProxyPlan, ReverseProxyDriver } from './driver.ts';
import type { ProxyDriverId } from './ids.ts';

export interface FileSpec {
  path: string;
  content: string;
  // 'owned': fileDriver replaces the whole file. 'managed-section': it
  // replaces only the `# BEGIN bellhop-managed` ... `# END bellhop-managed`
  // block (appending it if absent), leaving everything else on the file
  // untouched -- see data-model.md "FileSpec (file drivers)".
  mode: 'owned' | 'managed-section';
}

const BEGIN_MARKER = '# BEGIN bellhop-managed';
const END_MARKER = '# END bellhop-managed';

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
// either way. It is disarmed (`trap - EXIT`) right before backups are
// removed and the reload runs, so a reload failure is never treated as a
// reason to restore (unchanged from before this round: reload always runs
// against the new, already-validated configuration).
export function buildFileDriverScript(files: FileSpec[], validateCommand: string, reloadCommand: string): string {
  const lines: string[] = ['set -e'];

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

  // 4. Disarm the trap, remove backups, reload.
  lines.push('trap - EXIT');
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

// Builds a ReverseProxyDriver for a proxy that's configured entirely by
// files delivered to the proxy host (Caddy today; nginx/HAProxy are
// candidate future drivers -- research.md R1/R8). Owns the full
// render -> back up -> write -> validate -> restore-or-reload cycle so a
// new file-configured driver only has to supply `render`, its validate
// command, and its reload command.
export function fileDriver(def: {
  id: ProxyDriverId;
  capabilities: DriverCapabilities;
  defaultConfigPath: string;
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
    capabilities: def.capabilities,
    defaultConfigPath: def.defaultConfigPath,

    async plan(routes: ProxyRoute[], ctx: ProxyContext, deps: DriverDeps): Promise<ProxyPlan> {
      const files = def.render(routes, ctx, deps.configPath);
      return { preview: files.map((f) => f.content).join('\n'), payload: files };
    },

    async apply(plan: ProxyPlan, deps: DriverDeps): Promise<void> {
      const files = plan.payload as FileSpec[];
      const validateCommand = def.validateCommand(deps.configPath);
      const script = buildFileDriverScript(files, validateCommand, def.reloadCommand);
      const result = await runRemote(deps.ssh, deps.inventory, deps.proxyHost, script);
      if (result.code !== 0) {
        throw new Error(`Failed to apply proxy configuration on '${deps.proxyHost}': ${result.stderr || result.stdout}`);
      }
    },

    async snapshot(deps: DriverDeps): Promise<string> {
      const paths = (def.configFiles ?? ((configPath: string) => [configPath]))(deps.configPath);
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
