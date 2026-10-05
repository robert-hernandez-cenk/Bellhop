import { Router, type Response } from 'express';
import { logInfo, logWarn } from '../../lib/log.ts';
import { webLoginConfig, type WebLoginConfig } from '../login/config.ts';
import { LOGIN_COOKIE, LOGIN_COOKIE_OPTIONS, parseCookies, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from '../login/cookies.ts';
import { WebLoginError, type WebLoginClient, type WebLoginSettings } from '../login/oidc-client.ts';
import type { SessionService } from '../login/sessions.ts';

// Bellhop's own sign-in (#69, contracts/http-auth.md): GET /auth/login starts
// an authorization-code + PKCE sign-in with the configured provider, and GET
// /auth/callback finishes it and creates the session. Mounted in buildApp
// *before* requireAuth, so both are reachable without a session in either
// mode. The pages are small server-rendered HTML -- no client bundle -- and
// every interpolated value goes through escapeHtml, since some of them (the
// provider's `error`, a reason naming the issuer) come from outside.
//
// Secrecy: nothing here ever renders the client secret, a token, the PKCE
// verifier or the nonce. Reasons come from WebLoginError (secret-free by
// construction, oidc-client.ts), fixed text, or the provider's OAuth error
// code; an unexpected error's message is never shown or logged.

// `client` defaults to the session service's own client: one provider
// conversation for sign-in and re-checks. AppDeps.webLogin overrides it.
export function authRoutes(sessions: SessionService, client: WebLoginClient = sessions.client): Router {
  const router = Router();

  // These pages carry one-time state; never let a cache keep them.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/login', async (req, res) => {
    const returnTo = safeReturnTo(req.query.returnTo);
    const retry = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

    let cfg: WebLoginConfig;
    try {
      cfg = webLoginConfig();
    } catch (err) {
      // An invalid WEB_UI_OIDC_* environment value. The message names the
      // key and the variable, never the value (config.ts).
      sendPage(res, 200, 'Web login is not configured', [
        `<p>${escapeHtml((err as Error).message)}</p>`,
        fixesHtml(),
      ]);
      return;
    }
    if (!cfg.configured) {
      sendPage(res, 200, 'Web login is not configured', [
        '<p>Bellhop cannot send you to sign in until these settings are set:</p>',
        `<ul>${cfg.missing.map((key) => `<li><code>${escapeHtml(key)}</code></li>`).join('')}</ul>`,
        fixesHtml(),
      ]);
      return;
    }

    let started;
    try {
      started = await client.startLogin(cfg);
    } catch (err) {
      // Discovery is the only provider round trip here, so any failure is
      // "could not reach it". WebLoginError messages already name the issuer
      // and are secret-free; anything else gets fixed text.
      const detail = err instanceof WebLoginError ? err.message : `Could not reach the identity provider at ${cfg.issuer}`;
      logWarn(`Web sign-in could not start: ${detail}`);
      sendPage(res, 502, 'Could not reach the identity provider', [
        `<p>Could not reach the identity provider at <code>${escapeHtml(cfg.issuer)}</code>.</p>`,
        `<p>${escapeHtml(detail)}</p>`,
        `<p><a href="${escapeHtml(retry)}">Try again</a></p>`,
      ]);
      return;
    }

    const attemptId = sessions.store.createAttempt({
      state: started.state,
      nonce: started.nonce,
      codeVerifier: started.codeVerifier,
      returnTo,
    });
    res.cookie(LOGIN_COOKIE, attemptId, LOGIN_COOKIE_OPTIONS);
    res.redirect(302, started.authorizationUrl);
  });

  router.get('/callback', async (req, res) => {
    // Consume the attempt first, whatever happens next: it is single use
    // (FR-010), so even a failed callback cannot be replayed.
    const attemptId = parseCookies(req.headers.cookie)[LOGIN_COOKIE];
    const attempt = attemptId ? sessions.store.consumeAttempt(attemptId) : undefined;
    res.clearCookie(LOGIN_COOKIE, clearOptions(LOGIN_COOKIE_OPTIONS));

    const fail = (reason: string): void => {
      const returnTo = attempt?.returnTo ?? '/';
      logInfo(`Web sign-in failed: ${reason}`);
      sendPage(res, 400, 'Sign-in failed', [
        `<p>${escapeHtml(reason)}</p>`,
        `<p><a href="/auth/login?returnTo=${escapeHtml(encodeURIComponent(returnTo))}">Sign in again</a></p>`,
      ]);
    };

    if (!attempt) {
      fail('This sign-in attempt is missing, has expired (they last 10 minutes), or was already used. Start again.');
      return;
    }
    const providerError = queryString(req.query.error);
    if (providerError !== undefined) {
      // The OAuth error code only; error_description is provider free text.
      fail(`The identity provider refused the sign-in: ${providerError}`);
      return;
    }
    if (queryString(req.query.state) !== attempt.state) {
      fail('The sign-in response does not match this sign-in attempt (state mismatch). Start again.');
      return;
    }

    let cfg: WebLoginSettings;
    try {
      const config = webLoginConfig();
      if (!config.configured) {
        fail('Web login is not configured any more, so this sign-in cannot be completed.');
        return;
      }
      cfg = config;
    } catch (err) {
      fail((err as Error).message);
      return;
    }

    let identity;
    try {
      identity = await client.completeLogin(cfg, req.originalUrl, {
        state: attempt.state,
        nonce: attempt.nonce,
        codeVerifier: attempt.codeVerifier,
      });
    } catch (err) {
      fail(err instanceof WebLoginError ? err.message : `Sign-in with ${cfg.issuer} failed: unexpected error`);
      return;
    }

    // A browser signing in again (a stale tab, a second account) still carries
    // its previous cookie: delete that session so it does not linger as an
    // orphan until it expires.
    const previous = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (previous) sessions.destroy(previous);
    const sessionId = sessions.create(identity);
    logInfo(`Signed in ${identity.username} through ${cfg.issuer}`);
    res.cookie(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTIONS);
    res.redirect(302, attempt.returnTo);
  });

  // Sign-out (FR-015, R13). POST only, so a link or an image tag cannot sign
  // anyone out, and the Lax session cookie is not sent on a cross-site POST.
  // Whatever happens at the provider, the local session is already gone and
  // the cookie cleared before it is asked anything, so this never fails.
  router.post('/logout', async (req, res) => {
    const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = sessionId ? sessions.destroy(sessionId) : undefined;
    // Same attributes the cookie was set with (path "/"), or the browser keeps it.
    res.clearCookie(SESSION_COOKIE, clearOptions(SESSION_COOKIE_OPTIONS));

    let target = '/auth/signed-out';
    if (session) {
      try {
        const cfg = webLoginConfig();
        if (cfg.configured) {
          // Where the provider sends the browser afterwards: this deployment's
          // origin, taken from the registered redirect URI.
          const back = new URL('/auth/signed-out', cfg.redirectUri).href;
          target = (await client.endSessionUrl(cfg, session.idToken, back)) ?? target;
        }
      } catch {
        // Invalid settings or a client that threw: the unexpected error's
        // text is neither logged nor shown (it carries no secrecy guarantee).
        logWarn('Web sign-out could not ask the identity provider to end its session; signed out locally only');
      }
    }
    res.redirect(303, target);
  });

  router.get('/signed-out', (_req, res) => {
    sendPage(res, 200, 'You are signed out', ['<p><a href="/auth/login">Sign in again</a></p>']);
  });

  return router;
}

// FR-011: only a same-origin path survives the round trip through the
// provider, so a crafted sign-in link cannot bounce a freshly signed-in
// browser to another site. A single leading "/" is required ("//host" and
// "/\host" are protocol-relative to a browser), and the value must still be
// a path on the same origin once a URL parser has normalized it (which also
// catches tabs and newlines the parser strips).
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  const base = 'http://bellhop.invalid';
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return '/';
  }
  if (url.origin !== base) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

// Express's default query parser can hand back an array or object for a
// repeated or bracketed key; only a single string counts.
function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// res.clearCookie must match the cookie's path (and attributes) to remove
// it; Max-Age is dropped because clearing sets an expiry in the past.
function clearOptions(options: typeof LOGIN_COOKIE_OPTIONS): typeof LOGIN_COOKIE_OPTIONS {
  const { maxAge: _maxAge, ...rest } = options;
  return rest;
}

function fixesHtml(): string {
  return [
    '<p>Either:</p>',
    '<ul>',
    `<li>configure sign-in through Authentik: <code>${escapeHtml('bellhop configure-web-login <entry> --apply')}</code>, or</li>`,
    '<li>turn sign-in off: <code>bellhop set-config webUiAuthMode none --apply</code></li>',
    '</ul>',
  ].join('');
}

function sendPage(res: Response, status: number, title: string, body: string[]): void {
  res
    .status(status)
    .type('html')
    .send(
      [
        '<!doctype html>',
        '<html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${escapeHtml(title)} - Bellhop</title>`,
        '<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}code{overflow-wrap:anywhere}</style>',
        '</head><body>',
        `<h1>${escapeHtml(title)}</h1>`,
        ...body,
        '</body></html>',
      ].join('\n')
    );
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

