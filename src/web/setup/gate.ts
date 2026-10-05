import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from 'express';
import { parseCookies } from '../login/cookies.ts';
import type { SetupService } from './service.ts';

// The browser's proof that it opened the setup address (issue #86, research
// R3). Its value is the setup token itself. Not Secure: setup runs over
// plain HTTP, before any proxy or certificate exists, and a Secure cookie
// would never come back. SameSite=Strict keeps it off every cross-site
// request; no Max-Age, so it ends with the browser session.
export const SETUP_COOKIE = 'bellhop_setup';
export const SETUP_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: false,
  sameSite: 'strict',
  path: '/',
};

export const SETUP_REQUIRED_ERROR = 'Setup is in progress -- open the setup address from the service log';
export const SETUP_AUTH_ERROR = 'Setup authorization required -- open the setup address from the service log';
export const SETUP_NOT_IN_PROGRESS_ERROR = 'Setup is not in progress';

export function setupCookieValue(req: Pick<Request, 'headers'>): string | undefined {
  return parseCookies(req.headers.cookie)[SETUP_COOKIE];
}

// A path whose last segment has a file extension is a static asset of the
// client bundle (index-<hash>.js, favicon.svg), which the setup page itself
// needs in order to load.
function isAssetPath(path: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(path.slice(path.lastIndexOf('/') + 1));
}

// First middleware in buildApp (research R4). While setup is pending, only
// the setup page, the setup API (which checks the cookie itself) and static
// assets get through; every other API and sign-in route answers 503, and
// every other page load is sent to /setup. Otherwise a no-op.
export function setupGate(setup: SetupService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!setup.isPending()) return next();
    // Express routes case-insensitively, so compare lowercased: /API/jobs/x.y
    // must not slip through as an asset past the /api check.
    const path = req.path.toLowerCase();
    if (path === '/setup' || path === '/api/setup' || path.startsWith('/api/setup/')) return next();
    if (path === '/api' || path.startsWith('/api/') || path === '/auth' || path.startsWith('/auth/')) {
      res.status(503).json({ error: SETUP_REQUIRED_ERROR, setupRequired: true });
      return;
    }
    if (isAssetPath(path)) return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.redirect(303, '/setup');
      return;
    }
    res.status(503).json({ error: SETUP_REQUIRED_ERROR, setupRequired: true });
  };
}

// Guards the setup API routes that need the cookie.
export function requireSetupAuth(setup: SetupService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!setup.isPending()) {
      res.status(404).json({ error: SETUP_NOT_IN_PROGRESS_ERROR });
      return;
    }
    if (!setup.tokenMatches(setupCookieValue(req))) {
      res.status(401).json({ error: SETUP_AUTH_ERROR });
      return;
    }
    next();
  };
}
