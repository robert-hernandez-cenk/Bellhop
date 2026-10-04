import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Final review M13 (#64): the Settings page's confirmation is for a
// non-destructive save, so its confirm button must not be the red danger
// button every delete confirmation keeps. Pinned against the sources, the
// same way advanced-field-help.test.ts pins the Advanced modal.
const modalSource = readFileSync(new URL('../../web-client/src/components/ConfirmDeleteModal.tsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('../../web-client/src/pages/SettingsPage.tsx', import.meta.url), 'utf8');

test('ConfirmDeleteModal keeps the danger button by default and accepts a confirm button class', () => {
  assert.match(modalSource, /confirmClassName = 'button button-danger'/);
  assert.match(modalSource, /className=\{confirmClassName\}/);
});

test('the Settings page confirmation uses a normal, non-danger button', () => {
  const modal = settingsSource.slice(settingsSource.indexOf('<ConfirmDeleteModal'));
  const props = modal.slice(0, modal.indexOf('/>'));
  assert.match(props, /confirmClassName="button"/);
});
