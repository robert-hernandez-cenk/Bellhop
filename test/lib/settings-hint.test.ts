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

test('settingFix for a secret key points at --stdin and takes no value hint', () => {
  assert.equal(
    settingFix('authentikApiToken'),
    "run: bellhop set-config authentikApiToken --stdin --apply, or set it on the web UI's Settings page"
  );
  assert.equal(
    settingFix('npmApiPassword'),
    "run: bellhop set-config npmApiPassword --stdin --apply, or set it on the web UI's Settings page"
  );
});

test('settingFix accepts a moved non-secret key like any other setting', () => {
  assert.equal(
    settingFix('authentikApiUrl', '<url>'),
    "run: bellhop set-config authentikApiUrl <url> --apply, or set it on the web UI's Settings page"
  );
});
