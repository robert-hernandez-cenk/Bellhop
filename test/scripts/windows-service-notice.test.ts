import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_SERVICE_DEPRECATION_NOTICE } from '../../scripts/windows-service-notice.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the Windows service deprecation notice points to the container docs and the removal issue', () => {
  assert.match(WINDOWS_SERVICE_DEPRECATION_NOTICE, /deprecated/);
  assert.match(WINDOWS_SERVICE_DEPRECATION_NOTICE, /docs\/lxc-container\.md/);
  assert.match(WINDOWS_SERVICE_DEPRECATION_NOTICE, /#68/);
});

test('the docs page the notice names exists', () => {
  assert.ok(existsSync(path.join(REPO_ROOT, 'docs', 'lxc-container.md')));
});
