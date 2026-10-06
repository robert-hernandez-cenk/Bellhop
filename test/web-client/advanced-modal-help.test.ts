import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADVANCED_FIELD_HELP } from '../../web-client/src/lib/advanced-field-help.ts';
import {
  GENERAL_TAB_FIELDS,
  renderedAdvancedFields,
  liveHelp,
} from '../../web-client/src/lib/advanced-modal.ts';

// F2 (#22 final review): a pinned explanation on a row that is not rendered
// right now (the other tab's rows, an Access row the current auth mode hides,
// or the oidc client row outside effective OIDC) must count as closed, or it
// blocks hover on every visible field (#34's FR-006).

const FORWARD_GUEST = { authMode: 'forward' as const };
const OIDC_GUEST = { authGroup: 'bellhop-users', authMode: 'oidc' as const, creator: { username: 'test-user' } };

test('the General tab renders exactly the general fields for a guest with a recorded creator', () => {
  assert.deepEqual(renderedAdvancedFields('general', OIDC_GUEST), new Set(GENERAL_TAB_FIELDS));
});

// issue #58: 'created by' only renders for a guest with a recorded creator,
// unlike every other General-tab field, which renders unconditionally.
test("the General tab omits 'created by' for a guest with no recorded creator", () => {
  const rendered = renderedAdvancedFields('general', FORWARD_GUEST);
  assert.equal(rendered.has('created by'), false);
  assert.deepEqual(rendered, new Set(GENERAL_TAB_FIELDS.filter((f) => f !== 'created by')));
});

test('every help label is rendered on some tab for some guest', () => {
  const all = new Set([
    ...renderedAdvancedFields('general', FORWARD_GUEST),
    ...renderedAdvancedFields('general', OIDC_GUEST),
    ...renderedAdvancedFields('access', FORWARD_GUEST),
    ...renderedAdvancedFields('access', OIDC_GUEST),
  ]);
  assert.deepEqual(all, new Set(Object.keys(ADVANCED_FIELD_HELP)));
});

test('the Access tab renders the fields for the guest auth mode', () => {
  assert.deepEqual(
    renderedAdvancedFields('access', FORWARD_GUEST),
    new Set(['auth group', 'auth mode', 'unauthenticated paths'])
  );
  assert.deepEqual(
    renderedAdvancedFields('access', OIDC_GUEST),
    new Set(['auth group', 'auth mode', 'callback urls', 'mobile app redirect urls', 'oidc client', 'this is bellhop'])
  );
  // OIDC mode without a tier is not effective, so no oidc client row.
  assert.equal(renderedAdvancedFields('access', { authMode: 'oidc' }).has('oidc client'), false);
});

test('liveHelp keeps a state for a rendered field and closes one for an unrendered field', () => {
  const general = renderedAdvancedFields('general', FORWARD_GUEST);
  const access = renderedAdvancedFields('access', FORWARD_GUEST);
  assert.equal(liveHelp(null, general), null);
  assert.deepEqual(liveHelp({ field: 'port', pinned: true }, general), { field: 'port', pinned: true });
  // Pinned on General, then switched to Access.
  assert.equal(liveHelp({ field: 'port', pinned: true }, access), null);
  // Pinned on Access, then switched to General.
  assert.equal(liveHelp({ field: 'auth group', pinned: true }, general), null);
  // An Access row the current auth mode hides.
  assert.equal(liveHelp({ field: 'mobile app redirect urls', pinned: true }, access), null);
  // The oidc client row once the guest leaves effective OIDC.
  assert.equal(liveHelp({ field: 'oidc client', pinned: true }, access), null);
  // The Bellhop row on a forward guest that is not flagged (#85).
  assert.equal(liveHelp({ field: 'this is bellhop', pinned: true }, access), null);
});
