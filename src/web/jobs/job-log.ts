import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// name is a job's logFile (see JobStore.createJob) -- a "YYYY-MM-DD_HH-mm-ss"
// timestamp of when the job was created, not its numeric id, so log files on
// disk sort chronologically and read as a timestamp at a glance.
export interface JobLog {
  append(name: string, chunk: string): void;
  read(name: string): string;
  path(name: string): string;
}

export function createJobLog(dir: string): JobLog {
  mkdirSync(dir, { recursive: true });
  const filePath = (name: string) => path.join(dir, `${name}.log`);
  return {
    append(name: string, chunk: string): void {
      appendFileSync(filePath(name), chunk, 'utf8');
    },
    read(name: string): string {
      const p = filePath(name);
      return existsSync(p) ? readFileSync(p, 'utf8') : '';
    },
    path(name: string): string {
      return filePath(name);
    },
  };
}
