#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', 'src', 'cli.ts');
// Resolved here rather than passed as a bare 'tsx': node resolves a bare
// --import specifier against the caller's working directory, so the shim
// failed with ERR_MODULE_NOT_FOUND anywhere outside the repository root
// (issue #67 -- the LXC container's bellhop wrapper, or an `npm link`ed
// bellhop run from another directory).
const tsxLoader = import.meta.resolve('tsx');

const result = spawnSync(
  process.execPath,
  ['--import', tsxLoader, cliPath, ...process.argv.slice(2)],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
