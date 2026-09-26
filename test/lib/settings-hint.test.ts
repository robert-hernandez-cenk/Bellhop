import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingFix } from '../../src/lib/settings-hint.ts';

test("settingFix returns the set-config command plus the web UI's Settings page", () => {
  assert.equal(
    settingFix('nfsServer', '<ip>'),
    "run: bellhop set-config nfsServer <ip> --apply, or set it on the web UI's Settings page"
  );
});

test('settingFix substitutes the given key and value hint', () => {
  assert.equal(
    settingFix('statusPagePath', '</absolute/path>'),
    "run: bellhop set-config statusPagePath </absolute/path> --apply, or set it on the web UI's Settings page"
  );
});
