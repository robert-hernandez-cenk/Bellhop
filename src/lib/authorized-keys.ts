import type { SSHClient } from './ssh-client.ts';
import type { Inventory } from './inventory.ts';
import { runRemote } from './targets.ts';
import { shellQuote } from './ssh-client.ts';

// Reads the same file community-scripts' own build.func sources its
// interactive "add an SSH key?" prompt from (its find_host_ssh_keys() /
// ssh_discover_default_files() scan /root/.ssh/authorized_keys first) --
// this toolkit already assumes passwordless key auth to every Proxmox
// host, so that file is exactly the set of keys already trusted to reach
// it today. `~` expands to whichever ssh_user that host's inventory entry
// carries, since runRemote's 'pve' branch execs through a real shell.
// Any failure (missing file, unreadable, empty) collapses to undefined --
// there's no meaningful difference between "no keys" and "couldn't read
// them" for this feature, and neither should block guest creation. This
// includes SSH transport failures (host unreachable, auth failure, etc.) --
// runRemote/Ssh2SSHClient reject their promise in that case rather than
// returning a non-zero ExecResult, so those are caught here too, not just
// the file-level "cat exited non-zero" case. Callers (create-lxc/
// install-app previews, in particular) depend on this never rejecting:
// their dry-run path calls this before any job is created, so a rejection
// here would surface as a raw error instead of a normal, browsable dry-run
// or job failure.
export async function readHostAuthorizedKeys(
  ssh: SSHClient,
  inventory: Inventory,
  hostName: string
): Promise<string | undefined> {
  let result;
  try {
    result = await runRemote(ssh, inventory, hostName, 'cat ~/.ssh/authorized_keys 2>/dev/null');
  } catch {
    return undefined;
  }
  // A pty-backed exec (issue #57's install-app prompt watcher) translates
  // every \n in the remote output to \r\n (the default ONLCR terminal
  // mode) -- .trim() alone only strips the outermost whitespace, leaving
  // an embedded \r on every key line but the last on a multi-key host.
  // Stripping \r unconditionally keeps this function's output identical
  // regardless of which exec path (pty or plain) produced it.
  const trimmed = result.stdout.replace(/\r/g, '').trim();
  return trimmed ? trimmed : undefined;
}

// A freshly created guest has no pre-existing authorized_keys worth
// preserving, so this overwrites rather than appends -- named ...WriteScript
// (not ...AppendScript) precisely because it uses `>`, not `>>`: a future
// caller reaching for this against an *existing* guest (see GitHub issue
// #12, a planned "push SSH keys to existing guests" bulk action) would
// silently wipe that guest's keys if the name suggested appending. pct exec
// doesn't invoke a shell itself, so the compound mkdir/chmod/printf/chmod
// needs its own sh -c wrapper (POSIX sh, not bash -- a default Alpine
// container has no bash) -- same double-shellQuote nesting runRemote's own
// 'lxc' branch already uses for guest-targeted commands.
export function buildAuthorizedKeysWriteScript(vmid: number, keysContent: string): string {
  const inner =
    `mkdir -p /root/.ssh && chmod 700 /root/.ssh && ` +
    `printf '%s\\n' ${shellQuote(keysContent)} > /root/.ssh/authorized_keys && ` +
    `chmod 600 /root/.ssh/authorized_keys`;
  return `pct exec ${vmid} -- sh -c ${shellQuote(inner)}`;
}

// Unlike buildAuthorizedKeysWriteScript (used only by create-lxc, against a
// guest that doesn't exist in inventory yet -- so it has to build its own
// `pct exec <vmid> -- sh -c '...'` wrapper by hand), every caller of this
// function targets an *already-existing* inventory entry, reachable by
// name through runRemote's own generic host/lxc/vm dispatch
// (src/lib/targets.ts) -- so this returns a plain multi-line shell command,
// with no vmid parameter and no manual pct exec/shellQuote wrapping at all.
// Pass the result directly as the `command` argument to
// runRemote(ssh, inventory, <entryName>, script).
//
// Idempotent: `grep -qxF "$line" ... || printf ... >>` per line means a key
// already present is never duplicated, and nothing already on the guest
// (including a key that arrived some other way) is ever touched or
// removed -- unlike buildAuthorizedKeysWriteScript's overwrite, this is
// safe to run against a guest that already has other keys.
export function buildAuthorizedKeysEnsurePresentScript(keysContent: string): string {
  const delimiter = 'BELLHOP_KEYS_EOF';
  return [
    'mkdir -p /root/.ssh && chmod 700 /root/.ssh',
    'touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys',
    // Guard against a file that exists but doesn't end in a newline (e.g.
    // written by `echo -n`, an editor that strips a trailing newline, or a
    // manually `pct push`'d file) -- without this, the first `printf ... >>`
    // below would concatenate directly onto the end of the last existing
    // line instead of starting a fresh one, corrupting both the existing
    // last key and the newly appended one in a single write. `$(...)`
    // strips a trailing newline from command substitution, so `tail -c1`
    // on a correctly-terminated file yields an empty string (no-op) and on
    // a file missing its trailing newline yields that last character
    // (non-empty, triggers the fix); `-s` excludes the still-empty file
    // left by `touch` above, where `tail -c1` would also be empty but for
    // an unrelated, harmless reason.
    'if [ -s /root/.ssh/authorized_keys ] && [ -n "$(tail -c1 /root/.ssh/authorized_keys)" ]; then',
    '  printf \'\\n\' >> /root/.ssh/authorized_keys',
    'fi',
    `while IFS= read -r line; do [ -z "$line" ] && continue; grep -qxF "$line" /root/.ssh/authorized_keys || printf '%s\\n' "$line" >> /root/.ssh/authorized_keys; done <<'${delimiter}'`,
    keysContent,
    delimiter,
  ].join('\n');
}
