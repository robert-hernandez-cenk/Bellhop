import { resolveAppUrl, resolveDevAppUrl, resolveInstallScriptUrl } from '../commands/provisioning/install-app.ts';
import { resolveAppSource, type AppSource, type ShadowedRepo } from '../lib/app-source.ts';
import type { Inventory } from '../lib/inventory.ts';

export interface AppDefaults {
  cores?: number;
  memory?: number;
  disk?: number;
  port?: number;
}

// community-scripts ct/<app>.sh scripts declare their recommended sizing
// near the top as var_cpu="${var_cpu:-N}" / var_ram="${var_ram:-N}" (MB) /
// var_disk="${var_disk:-N}" (GB) -- parsed best-effort so the UI can prefill
// Cores/Memory/Disk with what the script itself recommends instead of this
// toolkit's generic fallback. A script that doesn't match the convention
// just yields no defaults for that field, no error.
//
// Every script also ends with a hardcoded "Access it using the following
// URL" echo of the form http(s)://${IP}[:PORT][/path] -- that's the actual
// port the installed app listens on (Plex 32400, Jellyfin 8096, ...), which
// is what sync-caddy needs for a working reverse_proxy, not a generic
// fallback. Take the first such line (a script with more than one, e.g. an
// app plus a bundled Portainer, lists the primary app first) and default to
// the scheme's standard port (80/443) when none is given, same as a browser
// would.
export function parseAppDefaults(scriptText: string): AppDefaults {
  const match = (name: string) => scriptText.match(new RegExp(`var_${name}="\\$\\{var_${name}:-(\\d+)\\}"`))?.[1];
  const defaults: AppDefaults = {};
  const cores = match('cpu');
  const memory = match('ram');
  const disk = match('disk');
  if (cores !== undefined) defaults.cores = Number(cores);
  if (memory !== undefined) defaults.memory = Number(memory);
  if (disk !== undefined) defaults.disk = Number(disk);
  const urlMatch = scriptText.match(/(https?):\/\/\$\{IP\}(?::(\d+))?/);
  if (urlMatch) {
    const [, protocol, port] = urlMatch;
    defaults.port = port !== undefined ? Number(port) : protocol === 'https' ? 443 : 80;
  }
  return defaults;
}

// community-scripts installer scripts occasionally have their own
// interactive read prompts baked in, outside the generic build.func
// whiptail flow this toolkit's var_*/mode/PHS_SILENT unattended-mode env
// vars already cover (paperless-gpt, paperless-ngx -- see #52). Regex-
// matches the prompt text out of any `read -p`/`read -rp`/`read -r -p` line
// in the script body -- best-effort, same precedent as parseAppDefaults: a
// script whose prompt text is built from a variable rather than a literal
// string just yields no hints, not an error.
// As of issue #160 these are no longer display-only: JobSSHClient compiles
// them into its first detection tier (see src/web/jobs/prompt-matcher.ts), so
// a prompt found here is detected in ~2s rather than depending on the two
// trailing-line heuristics that miss 52% of real prompts. They are still
// best-effort -- a prompt whose text is built from a variable yields no
// usable hint, and the heuristic and stall tiers remain the fallback.
export function parsePromptHints(scriptText: string): string[] {
  const pattern = /read\s+(?:-r\s+-p|-rp|-p)\s+["']([^"']+)["']/g;
  const hints: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(scriptText)) !== null) {
    hints.push(match[1]);
  }
  return hints;
}

async function fetchScriptBody(url: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

// The `prompts` half of checkAppUrl: the install script's own `read -p`
// prompts. Swallows a 404/failure into an empty list the same way
// fetchScriptBody already swallows one -- 14 of 597 ct scripts have no
// conventionally-named install script, and a transient network failure must
// not turn a perfectly fetchable app into a "missing" one.
async function fetchInstallPrompts(ctUrl: string, fetchImpl: typeof fetch): Promise<string[]> {
  const installUrl = resolveInstallScriptUrl(ctUrl);
  if (installUrl === undefined) return [];
  const body = await fetchScriptBody(installUrl, fetchImpl);
  return body === undefined ? [] : parsePromptHints(body);
}

// The prompts for an already-resolved *custom* AppSource (research R5) --
// reused by checkAppUrl's own 'custom' branch below, and exported for
// previewAndEnqueue (src/operations/core.ts), which -- only for a 'custom'
// resolution -- has already resolved a source once per operation and must
// read prompts from that same resolution rather than calling
// checkAppUrl(app, ...) a second time (which would re-resolve where the
// script actually lives, potentially pinning a different commit). An
// 'upstream' or 'url' source has no custom install-script location to read,
// so callers use checkAppUrl's own VE->VED (or pasted-URL) logic for those
// instead of calling this at all -- see previewAndEnqueue's guard. Never
// throws -- every fetch here is swallowed the same way fetchScriptBody
// already swallows one.
export async function promptsForSource(source: AppSource, fetchImpl: typeof fetch): Promise<string[]> {
  if (source.kind !== 'custom' || !source.scriptsBaseUrl || !source.slug) return [];
  const body = await fetchScriptBody(`${source.scriptsBaseUrl}/install/${source.slug}-install.sh`, fetchImpl);
  return body === undefined ? [] : parsePromptHints(body);
}

// Resolves --app the same way buildInstallAppScript would (bare slug ->
// community-scripts URL, full URL -> used as-is) and reports whether that
// URL is actually fetchable, so the UI's check reflects exactly what Apply
// would try to curl (a GET, same as Apply's `curl -fsSL`) -- and, on success,
// the sizing defaults parsed out of the script body itself. A bare slug that
// 404s on the main repo is retried against the dev repo (resolveDevAppUrl)
// before being reported missing -- same fallback buildInstallAppScript's
// generated curl already does at apply time, so an app still "in
// development" (e.g. budget-board) checks out green instead of looking
// invalid. `dev: true` on that branch lets the UI flag it as still in
// development, rather than silently treating it the same as a graduated app.
//
// `inventory`/`preResolved` are optional (issue #11): when an inventory is
// given (and no already-resolved source is handed in via `preResolved`),
// `app` is first run through resolveAppSource. A 'custom' resolution takes
// its own branch below (fetching ctUrl directly and the install script from
// scriptsBaseUrl, never touching the VE/VED fallback at all); an 'upstream'
// or 'url' resolution -- and the no-inventory-given case, unchanged from
// before this feature existed -- falls through to today's VE->VED logic. A
// thrown resolution (bad customScriptsRepo/Branch, GitHub unreachable, see
// FR-008) becomes `{ exists: false, url: '', error: <message> }` rather than
// propagating, since this is a read-only status check, not a mutation.
export async function checkAppUrl(
  app: string,
  fetchImpl: typeof fetch = fetch,
  inventory?: Inventory,
  preResolved?: AppSource
): Promise<{
  exists: boolean;
  url: string;
  dev?: boolean;
  defaults?: AppDefaults;
  prompts?: string[];
  custom?: { label: string; sha: string };
  shadows?: ShadowedRepo[];
  conflict?: true;
  error?: string;
}> {
  let source = preResolved;
  if (!source && inventory) {
    try {
      source = await resolveAppSource(app, inventory, fetchImpl);
    } catch (err) {
      return { exists: false, url: '', error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (source?.kind === 'custom') {
    const body = await fetchScriptBody(source.ctUrl!, fetchImpl);
    return {
      exists: body !== undefined,
      url: source.ctUrl!,
      defaults: body !== undefined ? parseAppDefaults(body) : undefined,
      prompts: await promptsForSource(source, fetchImpl),
      custom: { label: source.custom!.label, sha: source.custom!.sha },
      ...(source.shadows.length > 0 ? { shadows: source.shadows } : {}),
      // Issue #15: present only when upstream also changed this app since
      // the branch point, so a plain override reads exactly as before.
      ...(source.conflict ? { conflict: true as const } : {}),
    };
  }

  const url = resolveAppUrl(app);
  const body = await fetchScriptBody(url, fetchImpl);
  if (body !== undefined)
    return { exists: true, url, defaults: parseAppDefaults(body), prompts: await fetchInstallPrompts(url, fetchImpl) };

  const devUrl = resolveDevAppUrl(app);
  if (devUrl) {
    const devBody = await fetchScriptBody(devUrl, fetchImpl);
    if (devBody !== undefined)
      return {
        exists: true,
        url: devUrl,
        dev: true,
        defaults: parseAppDefaults(devBody),
        prompts: await fetchInstallPrompts(devUrl, fetchImpl),
      };
  }
  return { exists: false, url };
}
