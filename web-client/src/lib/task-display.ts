// Framework-free (no React/DOM imports) so it compiles under the root
// NodeNext config and is testable with plain node --test, same rationale as
// admin-nav.ts/settings-display.ts/app-update-display.ts. `formatTime` is
// injected rather than called directly (Intl.DateTimeFormat/toLocaleString)
// so this file stays clock- and locale-free for tests, and so the caller
// controls exactly how a timestamp reads (the Tasks page shows browser-local
// time, per research R11).

import type { JobRow, TaskView } from '../api/types.ts';

// The same HH:MM 24-hour rule src/lib/task-schedules.ts enforces server-side
// (TIME_OF_DAY_PATTERN) -- duplicated, not imported, since web-client is a
// fully separate build with no imports from src/ (CLAUDE.md's
// sortInventoryForFile precedent). Used by the Tasks page to reject an
// invalid time before ever sending the PATCH, so a typo is caught inline
// rather than only after a round trip.
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeOfDay(value: string): boolean {
  return TIME_OF_DAY_PATTERN.test(value);
}

export function lastRunText(lastRun: TaskView['lastRun'], formatTime: (iso: string) => string): string {
  return lastRun === null ? 'Never run' : formatTime(lastRun.startedAt);
}

export function nextRunText(nextRun: string | null, formatTime: (iso: string) => string): string {
  return nextRun === null ? 'Disabled' : formatTime(nextRun);
}

// Title-case labels for a last run's status, including the one status a
// JobRow itself never carries: the job row behind an old lastJobId is gone
// (data-model.md: "status ... null if that job row is gone").
const STATUS_LABELS: Record<JobRow['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting_input: 'Awaiting input',
  success: 'Success',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export function taskStatusLabel(status: JobRow['status'] | null): string {
  return status === null ? 'Unknown' : STATUS_LABELS[status];
}
