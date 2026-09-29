import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptBannerView } from '../../web-client/src/lib/prompt-banner.ts';

// Phase 2 (issue #4): these tests pin today's banner behavior verbatim, so
// the later story phases can change copy against a known-good baseline
// rather than changing structure and behavior at once. See
// specs/010-prompt-banner-copy/contracts/banner-copy.md for what each phase
// changes.

const TODAY_DISMISS_LABEL = 'Not stuck — keep waiting';

test("promptBannerView('expected', 0, 4) numbers the question and quiets the dismiss control", () => {
  const view = promptBannerView('expected', 0, 4);
  assert.equal(view.hint, "Question 1 of up to 4 — matches a known prompt in this app's install script.");
  assert.equal(view.hintStrong, false);
  assert.equal(view.dismissLabel, 'Skip this question');
  assert.equal(view.quiet, 'dismiss');
});

test("promptBannerView('expected', null, 4) falls back to the un-numbered hint", () => {
  const view = promptBannerView('expected', null, 4);
  assert.equal(view.hint, "Matches a known prompt in this app's install script.");
  assert.equal(view.hintStrong, false);
  assert.equal(view.dismissLabel, 'Skip this question');
  assert.equal(view.quiet, 'dismiss');
});

test("promptBannerView('expected', 0, 0) falls back to the un-numbered hint", () => {
  const view = promptBannerView('expected', 0, 0);
  assert.equal(view.hint, "Matches a known prompt in this app's install script.");
  assert.equal(view.hintStrong, false);
  assert.equal(view.dismissLabel, 'Skip this question');
  assert.equal(view.quiet, 'dismiss');
});

test("promptBannerView('stall', ...) reproduces today's stall hint verbatim and quiets the answer controls", () => {
  const view = promptBannerView('stall', null, 0);
  assert.equal(
    view.hint,
    'Output stopped for 5 minutes and this does not match any known prompt — it may not be a question at all. The line above is the last output received. Dismiss to keep waiting, or answer if it is in fact a prompt.',
  );
  assert.equal(view.hintStrong, true);
  assert.equal(view.dismissLabel, TODAY_DISMISS_LABEL);
  assert.equal(view.quiet, 'answers');
});

test("promptBannerView('heuristic', ...) shows no hint today", () => {
  const view = promptBannerView('heuristic', null, 2);
  assert.equal(view.hint, null);
  assert.equal(view.hintStrong, false);
  assert.equal(view.dismissLabel, TODAY_DISMISS_LABEL);
  assert.equal(view.quiet, null);
});

test('promptBannerView(null, ...) shows no hint today', () => {
  const view = promptBannerView(null, null, 0);
  assert.equal(view.hint, null);
  assert.equal(view.hintStrong, false);
  assert.equal(view.dismissLabel, TODAY_DISMISS_LABEL);
  assert.equal(view.quiet, null);
});
