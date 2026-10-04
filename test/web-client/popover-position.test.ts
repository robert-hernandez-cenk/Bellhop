import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  placePopover,
  popoverMaxWidth,
  POPOVER_GAP,
  POPOVER_GUTTER,
  POPOVER_MAX_WIDTH,
} from '../../web-client/src/lib/popover-position.ts';

// Issue #75: the anchored FieldHelp explanation (the Update page's
// app-update badge) is positioned from the ⓘ button's viewport rectangle by
// this pure module, so its placement rules are tested without a DOM.

test('constants match the data model', () => {
  assert.equal(POPOVER_GAP, 2);
  assert.equal(POPOVER_GUTTER, 16);
  assert.equal(POPOVER_MAX_WIDTH, 320);
});

test('popoverMaxWidth caps at 320 and leaves both gutters', () => {
  assert.equal(popoverMaxWidth(1280), 320);
  assert.equal(popoverMaxWidth(390), 320);
  assert.equal(popoverMaxWidth(340), 308);
  assert.equal(popoverMaxWidth(20), 0);
});

const viewport = { width: 1000, height: 800 };
const size = { width: 200, height: 100 };

test('places the popover below the anchor when it fits', () => {
  const anchor = { top: 100, bottom: 124, left: 300, right: 324 };
  assert.deepEqual(placePopover(anchor, size, viewport), { top: 126, left: 300, side: 'below' });
});

test('flips above when below is too short and above has more room', () => {
  const anchor = { top: 740, bottom: 764, left: 300, right: 324 };
  assert.deepEqual(placePopover(anchor, size, viewport), { top: 740 - 2 - 100, left: 300, side: 'above' });
});

test('stays below when neither side fits but below has more room', () => {
  const tall = { width: 200, height: 500 };
  const anchor = { top: 300, bottom: 324, left: 300, right: 324 };
  // below: 800 - 324 - 2 = 474; above: 300 - 2 = 298
  assert.deepEqual(placePopover(anchor, tall, { width: 1000, height: 800 }), { top: 326, left: 300, side: 'below' });
});

test('clamps left at the right edge', () => {
  const anchor = { top: 100, bottom: 124, left: 950, right: 974 };
  assert.equal(placePopover(anchor, size, viewport).left, 1000 - 16 - 200);
});

test('clamps left at the left edge', () => {
  const anchor = { top: 100, bottom: 124, left: 4, right: 28 };
  assert.equal(placePopover(anchor, size, viewport).left, 16);
});

test('uses the gutter when the popover is wider than the viewport minus both gutters', () => {
  const anchor = { top: 100, bottom: 124, left: 100, right: 124 };
  const wide = { width: 380, height: 100 };
  assert.equal(placePopover(anchor, wide, { width: 390, height: 800 }).left, 16);
});
