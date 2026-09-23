import { z } from 'zod';

// Field builders shared by every operation shape (#16). The web UI submits
// every form value as a string ('' for an untouched field, 'true' for a
// checked box); MCP clients send typed JSON. Each builder accepts both and
// normalizes to one output, so the operation code sees identical input
// regardless of which front end called it.

const blankToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

// Presence and type only -- an empty string still passes, so each command's
// own validation (and its operator-facing error message) stays in charge.
export const reqStr = (description: string) => z.string().describe(description);

export const optStr = (description: string) => z.preprocess(blankToUndefined, z.string().optional()).describe(description);

export const reqInt = (description: string) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int()).describe(description);

export const optInt = (description: string) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().optional()).describe(description);

export const flag = (description: string) =>
  z
    .preprocess((v) => (v === 'true' ? true : v === 'false' ? false : blankToUndefined(v)), z.boolean().optional())
    .describe(description);

// Kept as a string because parsePort (src/lib/inventory.ts) only accepts the
// form's string encoding; a typed number is stringified on the way in. The
// range check mirrors parsePort's own, but runs at parse time: install-app
// only calls parsePort after the container already exists, so an invalid
// port must be rejected before the job is ever enqueued (#16).
export const portStr = (description: string) =>
  z
    .preprocess(
      (v) => (typeof v === 'number' ? String(v) : blankToUndefined(v)),
      z
        .string()
        .optional()
        .superRefine((raw, ctx) => {
          if (raw === undefined || !raw.trim()) return;
          const port = Number(raw);
          if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid port '${raw}' (must be a whole number from 1 to 65535)` });
          }
        })
    )
    .describe(description);
