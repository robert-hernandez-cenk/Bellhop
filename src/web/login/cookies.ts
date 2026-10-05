import type { CookieOptions } from 'express';

// Cookie handling for Bellhop's own web login (#69, research R8). The parser
// is shared by Express requests and the raw WebSocket upgrade (which has no
// Express req.cookies); setting and clearing go through res.cookie /
// res.clearCookie with the option objects below.

export const SESSION_COOKIE = 'bellhop_session';
export const LOGIN_COOKIE = 'bellhop_login';

// The session cookie carries only an opaque random id; the identity and the
// refresh token stay server-side (SessionStore). Max-Age matches the store's
// 30-day session lifetime.
export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

// The short-lived cookie tying a browser to its pending sign-in. Scoped to
// /auth so it is never sent with ordinary requests, and Lax so it does come
// back on the top-level redirect from the provider to /auth/callback.
export const LOGIN_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/auth',
  maxAge: 600 * 1000,
};

// Each pending sign-in gets its own cookie, named after its OAuth `state`, so
// sign-ins started in parallel (several tabs hitting a 401 at once) don't
// overwrite each other's attempt. The state is random and already travels in
// the provider redirect URL, so naming a cookie after it reveals nothing. A
// state outside base64url (the provider's alphabet for it, and a safe cookie
// name) yields undefined: no cookie to look up.
export function loginCookieName(state: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,128}$/.test(state) ? `${LOGIN_COOKIE}_${state}` : undefined;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Parses a Cookie request header into name -> value. A pair with no "=" or
// an empty name is skipped, the first occurrence of a repeated name wins
// (the browser sends the most specific path first), and only the first "="
// splits, since a value may itself contain "=".
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name === '' || name in cookies) continue;
    cookies[name] = decode(pair.slice(eq + 1).trim());
  }
  return cookies;
}
