import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appUpdateView } from '../../web-client/src/lib/app-update-display.ts';
import type { AppUpdateResult } from '../../web-client/src/api/types.ts';

// formatTime is injected (research R11) so this stays framework-free and
// clock-free -- the test supplies a fixed, deterministic rendering rather
// than depending on Intl/locale/timezone behavior.
const formatTime = (iso: string) => `@${iso}`;

function result(overrides: Partial<AppUpdateResult>): AppUpdateResult {
  return {
    guest: 'media',
    app: 'jellyseerr',
    status: 'up-to-date',
    checkedAt: '2026-10-03T04:00:41.000Z',
    ...overrides,
  };
}

test('appUpdateView: update-available gets the "available" tone and both versions in the text', () => {
  const view = appUpdateView(
    result({ status: 'update-available', installedVersion: '1.2.3', latestVersion: '1.3.0' }),
    formatTime
  );
  assert.ok(view);
  assert.equal(view!.tone, 'available');
  assert.equal(view!.text, 'Update available 1.2.3 → 1.3.0');
  assert.ok(view!.details.includes('Checked @2026-10-03T04:00:41.000Z'));
});

test('appUpdateView: up-to-date gets a quiet note naming the installed version', () => {
  const view = appUpdateView(result({ status: 'up-to-date', installedVersion: '1.2.3' }), formatTime);
  assert.ok(view);
  assert.equal(view!.tone, 'quiet');
  assert.equal(view!.text, 'Up to date (1.2.3)');
  assert.ok(view!.details.includes('Checked @2026-10-03T04:00:41.000Z'));
});

test('appUpdateView: error gets a fixed quiet text with the reason in the details', () => {
  const view = appUpdateView(
    result({ status: 'error', message: 'GitHub API rate limit reached; the next scheduled check will retry' }),
    formatTime
  );
  assert.ok(view);
  assert.equal(view!.tone, 'quiet');
  assert.equal(view!.text, 'Update check failed');
  assert.ok(view!.details.includes('Checked @2026-10-03T04:00:41.000Z'));
  assert.ok(view!.details.includes('GitHub API rate limit reached; the next scheduled check will retry'));
});

test('appUpdateView: not-checked names the reason in the text', () => {
  const view = appUpdateView(result({ status: 'not-checked', message: 'guest stopped' }), formatTime);
  assert.ok(view);
  assert.equal(view!.tone, 'quiet');
  assert.equal(view!.text, 'Not checked: guest stopped');
  assert.ok(view!.details.includes('Checked @2026-10-03T04:00:41.000Z'));
});

test('appUpdateView: unsupported renders nothing at all', () => {
  const view = appUpdateView(result({ status: 'unsupported' }), formatTime);
  assert.equal(view, null);
});

test('appUpdateView: every rendered view\'s details includes "Checked <time>"', () => {
  const statuses: AppUpdateResult[] = [
    result({ status: 'update-available', installedVersion: '1.0.0', latestVersion: '1.1.0' }),
    result({ status: 'up-to-date', installedVersion: '1.0.0' }),
    result({ status: 'error', message: 'boom' }),
    result({ status: 'not-checked', message: 'guest stopped' }),
  ];
  for (const r of statuses) {
    const view = appUpdateView(r, formatTime);
    assert.ok(view);
    assert.ok(view!.details.includes('Checked @2026-10-03T04:00:41.000Z'), `expected a Checked time for status ${r.status}`);
  }
});
