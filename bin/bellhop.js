#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', 'src', 'cli.ts');

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', cliPath, ...process.argv.slice(2)],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
