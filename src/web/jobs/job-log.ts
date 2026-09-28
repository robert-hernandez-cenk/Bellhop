import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, fstatSync, readSync, readFileSync } from 'node:fs';
import path from 'node:path';

// name is a job's logFile (see JobStore.createJob) -- a "YYYY-MM-DD_HH-mm-ss"
// timestamp of when the job was created, not its numeric id, so log files on
// disk sort chronologically and read as a timestamp at a glance.
export interface JobLog {
  append(name: string, chunk: string): void;
  read(name: string): string;
  path(name: string): string;
  // Raw bytes from `offset` to the current end of the file -- an empty
  // Buffer for a missing file or an offset at/after the end. Used by the
  // foreign-job tailer (src/web/jobs/job-tail.ts, issue #6) to poll a log
  // file another process is appending to, rather than relying on that
  // process's in-memory 'chunk' events, which never fire here.
  readBytes(name: string, offset: number): Buffer;
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
    readBytes(name: string, offset: number): Buffer {
      const p = filePath(name);
      if (!existsSync(p)) return Buffer.alloc(0);
      const fd = openSync(p, 'r');
      try {
        const size = fstatSync(fd).size;
        if (offset >= size) return Buffer.alloc(0);
        const buffer = Buffer.alloc(size - offset);
        readSync(fd, buffer, 0, buffer.length, offset);
        return buffer;
      } finally {
        closeSync(fd);
      }
    },
  };
}
