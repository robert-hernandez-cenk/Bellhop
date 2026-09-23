import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePromptHints, matchExpectedPrompt } from '../../../src/web/jobs/prompt-matcher.ts';

// The four real prompts from install/cloudflare-ddns-install.sh, verbatim as
// parsePromptHints extracts them (${TAB3} included), paired with what the pty
// actually prints once the shell has expanded them.
const CLOUDFLARE_DDNS: Array<{ hint: string; runtime: string }> = [
  { hint: '${TAB3}Enter the Cloudflare API token: ', runtime: '   Enter the Cloudflare API token: ' },
  {
    hint: '${TAB3}Enter the domains separated with a comma (*.example.org,www.example.org) ',
    runtime: '   Enter the domains separated with a comma (*.example.org,www.example.org) ',
  },
  { hint: '${TAB3}Proxied? (y/n): ', runtime: '   Proxied? (y/n): ' },
  { hint: '${TAB3}Enable IPv6 support? (y/n): ', runtime: '   Enable IPv6 support? (y/n): ' },
];

test('every cloudflare-ddns prompt matches its own runtime rendering and no other', () => {
  const compiled = compilePromptHints(CLOUDFLARE_DDNS.map((p) => p.hint));
  assert.equal(compiled.filter((c) => c !== null).length, 4);
  CLOUDFLARE_DDNS.forEach((prompt, index) => {
    assert.equal(matchExpectedPrompt(prompt.runtime, compiled), index, `expected index ${index} for ${prompt.runtime}`);
  });
});

test('the two API-token and domains prompts are exactly the ones the old heuristics missed', () => {
  // Regression guard for the whole point of issue #160: these two match
  // neither a string-final "?" nor a (y/n) hint, so they were never surfaced.
  const QUESTION_MARK = /\?\s*:?\s*$/;
  const YES_NO_HINT = /[(<[]\s*y\s*\/\s*n\s*[)>\]]/i;
  const compiled = compilePromptHints(CLOUDFLARE_DDNS.map((p) => p.hint));
  for (const index of [0, 1]) {
    const runtime = CLOUDFLARE_DDNS[index].runtime;
    assert.ok(!QUESTION_MARK.test(runtime), 'heuristic should not have matched');
    assert.ok(!YES_NO_HINT.test(runtime), 'heuristic should not have matched');
    assert.equal(matchExpectedPrompt(runtime, compiled), index);
  }
});

test('an expansion in the middle of a hint becomes a wildcard, so a concrete value still matches', () => {
  const compiled = compilePromptHints(['Enter value [$default]: ']);
  assert.equal(matchExpectedPrompt('Enter value [prod]: ', compiled), 0);
  assert.equal(matchExpectedPrompt('Enter value [staging-2]: ', compiled), 0);
});

test('regex metacharacters in a hint are matched literally, not as a pattern', () => {
  // (*.example.org,www.example.org) is a real cloudflare-ddns prompt fragment;
  // unescaped, "(*" alone is an invalid quantifier and would throw.
  const compiled = compilePromptHints(['Enter the domains separated with a comma (*.example.org,www.example.org) ']);
  assert.notEqual(compiled[0], null);
  assert.equal(matchExpectedPrompt('Enter the domains separated with a comma (*.example.org,www.example.org) ', compiled), 0);
  assert.equal(matchExpectedPrompt('Enter the domains separated with a comma (a.b,c.d) ', compiled), null);
});

test('a hint with too little literal text to be distinctive compiles to null', () => {
  // `read -p "$msg" x` leaves nothing; ">" leaves 1 char. Either would match
  // essentially every line and pause the job on the first quiet moment.
  const compiled = compilePromptHints(['$msg', '${PROMPT}', '> ', 'Yes? ']);
  assert.deepEqual(compiled, [null, null, null, null]);
  assert.equal(matchExpectedPrompt('anything at all', compiled), null);
});

test('whitespace differences between source and runtime do not defeat a match', () => {
  const compiled = compilePromptHints(['Enter   the    token: ']);
  assert.equal(matchExpectedPrompt('Enter the token: ', compiled), 0);
});

test('matching ignores unusable hints but keeps every other index stable', () => {
  const compiled = compilePromptHints(['$x', 'Enter the Cloudflare API token: ']);
  assert.equal(compiled[0], null);
  assert.equal(matchExpectedPrompt('Enter the Cloudflare API token: ', compiled), 1);
});

test('a trailing line that resembles nothing in the list does not match', () => {
  const compiled = compilePromptHints(CLOUDFLARE_DDNS.map((p) => p.hint));
  assert.equal(matchExpectedPrompt('Downloading dependencies...', compiled), null);
  assert.equal(matchExpectedPrompt('', compiled), null);
});
