import { logInfo } from './log.ts';

export function confirmOrDryRun(description: string, apply: boolean): boolean {
  if (apply) {
    logInfo(description);
    return true;
  }
  logInfo(`[DRY RUN] ${description}`);
  return false;
}
