import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #69 US5 (T044): Sign out goes through Bellhop's own POST /auth/logout, and
// is not offered to the local operator (who has no session to end). Pinned
// against the source, like confirm-modal-button.test.ts.
const sidebar = readFileSync(new URL('../../web-client/src/components/Sidebar.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../web-client/src/index.css', import.meta.url), 'utf8');

test('Sign out is a POST form to /auth/logout, shown only when not the local operator', () => {
  assert.match(sidebar, /!whoami\.localOperator && \(\s*<form method="post" action="\/auth\/logout"/);
  assert.match(sidebar, /<button type="submit" className="link-button">Sign out<\/button>/);
});

test('the sidebar no longer links to authentik\'s sign-out endpoint', () => {
  assert.doesNotMatch(sidebar, /outpost\.goauthentik\.io/);
});

test('the sign-out button is styled like the previous link', () => {
  assert.match(css, /\.signed-in-as \.link-button\s*\{[^}]*color: var\(--accent\)/);
});
