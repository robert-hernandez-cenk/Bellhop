import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGIN_COOKIE,
  LOGIN_COOKIE_OPTIONS,
  loginCookieName,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  parseCookies,
} from '../../../src/web/login/cookies.ts';

test('parseCookies reads several cookies, tolerating spaces', () => {
  assert.deepEqual(parseCookies('a=1; b=two;c=3 ;  d = 4'), { a: '1', b: 'two', c: '3', d: '4' });
});

test('parseCookies keeps "=" inside a value', () => {
  assert.deepEqual(parseCookies('token=abc==; x=a=b=c'), { token: 'abc==', x: 'a=b=c' });
});

test('parseCookies returns an empty object for a missing or empty header', () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
});

test('parseCookies ignores malformed pairs', () => {
  assert.deepEqual(parseCookies('novalue; =orphan; ok=1; ;'), { ok: '1' });
});

test('parseCookies keeps the first of a repeated name', () => {
  assert.deepEqual(parseCookies('a=1; a=2'), { a: '1' });
});

test('parseCookies decodes a percent-encoded value, and keeps a bad escape as-is', () => {
  assert.deepEqual(parseCookies('a=x%20y; b=%E0%A4%A'), { a: 'x y', b: '%E0%A4%A' });
});

test('cookie names', () => {
  assert.equal(SESSION_COOKIE, 'bellhop_session');
  assert.equal(LOGIN_COOKIE, 'bellhop_login');
});

test('session cookie options: HttpOnly, Secure, SameSite=Lax, path /, 30 days', () => {
  assert.deepEqual(SESSION_COOKIE_OPTIONS, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
});

test('login cookie options: HttpOnly, Secure, SameSite=Lax, path /auth, 10 minutes', () => {
  assert.deepEqual(LOGIN_COOKIE_OPTIONS, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/auth',
    maxAge: 600 * 1000,
  });
});

// Each pending sign-in has its own cookie, named after its OAuth state, so
// parallel sign-ins from one browser don't overwrite each other.
test('loginCookieName names a cookie after a base64url state, and refuses anything else', () => {
  assert.equal(loginCookieName('abcXYZ019_-'), 'bellhop_login_abcXYZ019_-');
  for (const bad of ['', 'has space', 'semi;colon', 'equals=', 'x'.repeat(129)]) {
    assert.equal(loginCookieName(bad), undefined, bad);
  }
});
