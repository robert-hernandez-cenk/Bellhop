import { z } from 'zod';
import type { JobRunner } from '../web/jobs/job-runner.ts';
import type { Operation, OperationDeps } from './types.ts';
import { checkAppUrl } from './app-check.ts';
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
  const preview = await op.preview(input, deps);
  // checkAppUrl swallows fetch failures and returns no prompts, so a network
  // hiccup never blocks the apply.
  const expectedPrompts = op.watchForPrompts ? (await checkAppUrl(input.app, deps.fetchImpl)).prompts ?? [] : undefined;
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
