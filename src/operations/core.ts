import { z } from 'zod';
import type { JobRunner } from '../web/jobs/job-runner.ts';
import type { Operation, OperationDeps } from './types.ts';
import { checkAppUrl, promptsForSource } from './app-check.ts';
import { resolveAppSource } from '../lib/app-source.ts';
import { refreshInventory } from '../lib/inventory.ts';

export interface Attribution {
  triggeredByUsername?: string;
  triggeredByImpersonating?: string;
}

// Throws one error listing every invalid field, so both front ends can show
// it as-is (a web 400 body, an MCP isError result).
export function parseOperationInput(op: Operation, raw: unknown): Record<string, any> {
  const result = z.object(op.shape).safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid input for ${op.id}: ${issues}`);
  }
  return result.data;
}

// Truthy, not just present: the web form submits every field ('' when a
// provider's credential field is hidden), and rewriting '' to '[redacted]'
// would imply a credential was supplied when none was.
export function redactSecrets(op: Operation, args: Record<string, unknown>): Record<string, unknown> {
  if (!op.secretFields?.length) return args;
  const redacted = { ...args };
  for (const name of op.secretFields) {
    if (redacted[name]) redacted[name] = '[redacted]';
  }
  return redacted;
}

export function scrubSecretValues(op: Operation, input: Record<string, unknown>, text: string): string {
  let out = text;
  for (const name of op.secretFields ?? []) {
    const value = input[name];
    if (typeof value === 'string' && value) out = out.split(value).join('[redacted]');
  }
  return out;
}

function enqueue(
  op: Operation,
  input: Record<string, any>,
  raw: unknown,
  deps: OperationDeps,
  jobRunner: JobRunner,
  attribution: Attribution,
  expectedPrompts: string[] | undefined,
  preview: string | undefined
): number {
  return jobRunner.enqueue({
    command: op.id,
    category: op.category,
    target: op.target(input),
    argsJson: JSON.stringify(redactSecrets(op, (raw ?? {}) as Record<string, unknown>)),
    watchForPrompts: op.watchForPrompts,
    expectedPrompts,
    ...attribution,
    run: async (jobSsh) => {
      // #16: the job can start long after the request/tool call that reloaded
      // inventory (queued behind another job, especially now that the MCP
      // server reloads only at the start of a tool call). Applying against
      // that stale snapshot would make any saveInventory inside apply rewrite
      // the whole database from it, silently undoing Dashboard/Settings/CLI
      // edits made in between. Reload in place so both front ends see disk.
      refreshInventory(deps.inventory, deps.inventoryPath);
      // Logging the preview (the exact generated script, for commands that
      // build one) at the top of the job's own log means a hang deep in a
      // remote script can be cross-checked against what was actually sent.
      if (preview !== undefined) console.log(`----- dry-run preview -----\n${preview}\n----- end dry-run preview -----`);
      await op.apply(input, { ...deps, ssh: jobSsh });
    },
  });
}

// The web apply routes' and MCP apply tools' shared sequence. The preview is
// computed here, before enqueue, never inside the job: preview implementations
// use withCapturedConsole, and calling that again from inside the job's own
// withCapturedConsole-wrapped run() deadlocks the job queue (confirmed live).
export async function previewAndEnqueue(
  op: Operation,
  raw: unknown,
  deps: OperationDeps,
  jobRunner: JobRunner,
  attribution: Attribution
): Promise<{ jobId: number; preview: string }> {
  const input = parseOperationInput(op, raw);
  // research R5: pin a custom-repository resolution once per operation,
  // right here -- before preview -- so preview's own runInstallApp/
  // runUpdateApp call, the prompt pre-scan below, and apply (which runs
  // inside the job, and can start much later) all read the same resolved
  // source rather than each independently re-resolving (and each
  // potentially pinning a different head commit). Stored on the parsed
  // input as the internal field `appSource`: it's never part of any
  // operation's `shape`, so it's never accepted from the raw request body
  // and this line always overwrites whatever a caller supplied -- and it's
  // never serialized into a job's argsJson either, since enqueue() below
  // stringifies `raw`, not `input`.
  if (op.resolvesApp) {
    input.appSource = await resolveAppSource(input.app, deps.inventory, deps.fetchImpl ?? fetch);
  }
  const preview = await op.preview(input, deps);
  // checkAppUrl/promptsForSource both swallow fetch failures and return no
  // prompts, so a network hiccup never blocks the apply. Only a 'custom'
  // resolution reads prompts from the source already pinned above
  // (promptsForSource, whose only job is the custom scriptsBaseUrl/install/
  // <slug>-install.sh path) -- an 'upstream' or 'url' resolution (including
  // every op that isn't resolvesApp at all, where input.appSource is
  // undefined) still goes through checkAppUrl(input.app, ...), the same as
  // before this feature existed. This matters even with the custom-
  // repository feature off entirely: a pasted ct-shaped URL
  // (kind 'url', no slug) has no scriptsBaseUrl for promptsForSource to
  // read prompts from -- checkAppUrl's own VE->VED-agnostic pasted-URL
  // handling (resolveInstallScriptUrl on the URL itself) is what finds
  // its prompts, so it must stay the one this always calls for that case.
  const expectedPrompts = op.watchForPrompts
    ? input.appSource?.kind === 'custom'
      ? await promptsForSource(input.appSource, deps.fetchImpl ?? fetch)
      : ((await checkAppUrl(input.app, deps.fetchImpl)).prompts ?? [])
    : undefined;
  const jobId = enqueue(op, input, raw, deps, jobRunner, attribution, expectedPrompts, preview);
  return { jobId, preview };
}

// For the web routes that have always run their job with no preview step
// (update-all, guest-power, set-guest-vpn, sync-ssh-keys apply, push-ssh-key).
export function enqueueWithoutPreview(
  op: Operation,
  raw: unknown,
  deps: OperationDeps,
  jobRunner: JobRunner,
  attribution: Attribution
): number {
  const input = parseOperationInput(op, raw);
  return enqueue(op, input, raw, deps, jobRunner, attribution, undefined, undefined);
}
