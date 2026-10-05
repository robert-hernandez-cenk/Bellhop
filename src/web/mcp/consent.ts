import express, { Router, type CookieOptions, type Response } from 'express';
import { z } from 'zod';
import { escapeHtml } from '../../lib/html.ts';
import { logInfo } from '../../lib/log.ts';
import { authentikConfig } from '../../lib/authentik-config.ts';
import { isAdminUser } from '../auth.ts';
import { parseCookies } from '../login/cookies.ts';
import type { LoginIdentity } from '../login/oidc-client.ts';
import type { SessionService } from '../login/sessions.ts';
import { beginSignIn, sendPage, type McpSignInFinisher } from '../routes/auth.ts';
import { sha256, type McpAuthStore } from './auth-store.ts';

// The person's half of an MCP sign-in (#65/#66, research R4,
// contracts/http-mcp.md): the consent page /authorize shows, its form post,
// and what the Authentik callback does with the identity afterwards.
//
// Dynamic client registration lets anyone register any return address, so
// nothing is issued without the person approving a page that names the
// client and that address. The pending request is tied to the browser that
// saw the page by a cookie named after it (HttpOnly, SameSite=Lax, path
// /auth): a cross-site form post carries no Lax cookie, so a pending request
// someone else planted cannot be approved from another site.

const CONSENT_COOKIE_PREFIX = 'bellhop_mcp_';
const CONSENT_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/auth',
  maxAge: 600 * 1000,
};

// One cookie per pending request, so consents in several tabs don't clash.
// The hash is already a safe cookie-name alphabet; a prefix of it suffices.
export function consentCookieName(pendingHash: string): string {
  return `${CONSENT_COOKIE_PREFIX}${pendingHash.slice(0, 16)}`;
}

export function sendConsentPage(
  res: Response,
  opts: { clientName: string; redirectUri: string; pendingId: string }
): void {
  res.cookie(consentCookieName(sha256(opts.pendingId)), opts.pendingId, CONSENT_COOKIE_OPTIONS);
  res.set('Cache-Control', 'no-store');
  const origin = safeOrigin(opts.redirectUri);
  sendPage(res, 200, 'Allow MCP access?', [
    `<p>Allow <strong>${escapeHtml(opts.clientName)}</strong> to use Bellhop as you?</p>`,
    `<p>It will return to <code>${escapeHtml(origin)}</code>. Only approve if you just asked an MCP client to connect to Bellhop.</p>`,
    '<p>It will be able to run every Bellhop tool with your admin rights, until you sign out of it or 30 days pass.</p>',
    '<form method="post" action="/auth/mcp/consent">',
    `<input type="hidden" name="pending" value="${escapeHtml(opts.pendingId)}">`,
    '<button type="submit" name="decision" value="approve">Approve and sign in</button> ',
    '<button type="submit" name="decision" value="deny">Deny</button>',
    '</form>',
  ]);
}

const ConsentForm = z.object({
  pending: z.string().min(1).max(200),
  decision: z.enum(['approve', 'deny']),
});

export function consentRoutes(deps: { store: McpAuthStore; sessions: SessionService }): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/consent', async (req, res) => {
    const parsed = ConsentForm.safeParse(req.body);
    const pendingHash = parsed.success ? sha256(parsed.data.pending) : undefined;
    const cookieName = pendingHash ? consentCookieName(pendingHash) : undefined;
    const cookie = cookieName ? parseCookies(req.headers.cookie)[cookieName] : undefined;
    const pending = pendingHash ? deps.store.getPending(pendingHash) : undefined;
    if (!parsed.success || !pending || cookie !== parsed.data.pending) {
      sendPage(res, 400, 'Authorization request expired', [
        '<p>This authorization request has expired or was already used. Start again from your MCP client.</p>',
      ]);
      return;
    }
    res.clearCookie(cookieName!, { ...CONSENT_COOKIE_OPTIONS, maxAge: undefined });

    if (parsed.data.decision === 'deny') {
      deps.store.consumePending(pendingHash!);
      res.redirect(302, clientRedirect(pending.redirectUri, { error: 'access_denied', state: pending.state }));
      return;
    }
    // The pending request's 10 minutes now cover the Authentik sign-in.
    deps.store.touchPending(pendingHash!);
    const finisher = mcpSignInFinisher(deps);
    await beginSignIn(deps.sessions, res, {
      returnTo: '/',
      mcpPendingHash: pendingHash,
      onFailure: (reason) => finisher.failSignIn(pendingHash!, 'temporarily_unavailable', reason, res),
    });
  });

  return router;
}

// The callback's MCP branch: only an admin gets a code (FR-011). The
// identity becomes a session no cookie names, kept for its re-checks; the
// code carries only that session's hash.
export function mcpSignInFinisher(deps: { store: McpAuthStore; sessions: SessionService }): McpSignInFinisher {
  return {
    finishSignIn(pendingHash: string, identity: LoginIdentity, res: Response) {
      const pending = deps.store.consumePending(pendingHash);
      if (!pending) {
        sendPage(res, 400, 'Authorization request expired', [
          '<p>This authorization request has expired or was already used. Start again from your MCP client.</p>',
        ]);
        return;
      }
      if (!isAdminUser(identity.groups)) {
        const { adminGroup, builtinAdminGroup } = authentikConfig();
        logInfo(`MCP sign-in refused for ${identity.username}: not a Bellhop admin`);
        sendPage(res, 403, 'MCP access is limited to admins', [
          `<p>MCP access is limited to Bellhop admins (members of <code>${escapeHtml(adminGroup)}</code> or <code>${escapeHtml(builtinAdminGroup)}</code>).</p>`,
        ]);
        return;
      }
      const sessionHash = deps.sessions.createDetached(identity);
      const code = deps.store.issueCode({
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        ...(pending.resource !== undefined ? { resource: pending.resource } : {}),
        sessionHash,
      });
      const client = deps.store.getClient(pending.clientId);
      logInfo(`MCP client ${client?.client_name ?? pending.clientId} signed in as ${identity.username}`);
      res.redirect(302, clientRedirect(pending.redirectUri, { code, state: pending.state }));
    },
    failSignIn(pendingHash, error, reason, res) {
      const pending = deps.store.consumePending(pendingHash);
      if (!pending) {
        sendPage(res, 400, 'Authorization request expired', [
          '<p>This authorization request has expired or was already used. Start again from your MCP client.</p>',
        ]);
        return;
      }
      res.redirect(302, clientRedirect(pending.redirectUri, { error, error_description: reason, state: pending.state }));
    },
  };
}

// The redirect URI was matched against the client's registration by the
// SDK before the pending request was stored.
function clientRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

function safeOrigin(uri: string): string {
  try {
    const url = new URL(uri);
    return url.origin === 'null' ? uri : url.origin;
  } catch {
    return uri;
  }
}
