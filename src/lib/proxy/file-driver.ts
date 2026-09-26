import { runRemote } from '../targets.ts';
import { buildRoutes, buildProxyContext, type ProxyContext, type ProxyRoute } from './routes.ts';
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

// Local single-quote escaping for embedding a path or command into the
// generated remote shell script -- same convention as
// sync-caddy.ts's own singleQuote(), duplicated rather than imported since
// that file's copy is deleted once T013 rewrites it onto this driver.
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Builds the POSIX `sh` script `fileDriver`'s apply() sends over `runRemote`
// (research.md R6): back up every file (or record that it did not exist),
// write each file's new content in place, run the validate command against
// the real paths, restore every backup and exit 1 on failure, otherwise
// remove the backups and reload. The file list is fixed at script-generation
// time, so each file's steps are unrolled literally rather than driven by a
// runtime loop -- POSIX sh has no arrays, and unrolling keeps every step
// legible in the generated text.
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

  // 3. Validate; on failure restore every backup (removing files that did
  // not exist before) and exit 1.
  lines.push(`if ! ${validateCommand}; then`);
  files.forEach((file, i) => {
    const p = singleQuote(file.path);
    lines.push(`  if [ "$EXISTED_${i}" = "1" ]; then`);
    lines.push(`    cp "$BAK_${i}" ${p}`);
    lines.push('  else');
    lines.push(`    rm -f ${p}`);
    lines.push('  fi');
    lines.push(`  rm -f "$BAK_${i}"`);
  });
  lines.push(`  echo "${validateCommand} failed; restored previous configuration" >&2`);
  lines.push('  exit 1');
  lines.push('fi');

  // 4. Remove backups, reload.
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
      // Deps carries the live inventory, not a fixed file list -- rebuild
      // the routes/paths render() would use so this stays a single source
      // of truth for "which files this driver manages" (no separate
      // paths-only export to keep in sync with render()).
      const routes = buildRoutes(deps.inventory);
      const ctx = buildProxyContext(deps.inventory);
      const files = def.render(routes, ctx, deps.configPath);
      const command = buildSnapshotCommand(files.map((f) => f.path));
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
