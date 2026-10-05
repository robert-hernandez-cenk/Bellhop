import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { InsufficientScopeError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { isAdminUser } from '../auth.ts';
import type { SessionService } from '../login/sessions.ts';
import type { IssuedTokens, McpAuthStore } from './auth-store.ts';
import { sendConsentPage } from './consent.ts';
import { verifyApiKey } from './api-key.ts';

// Bellhop's OAuth authorization server for /mcp (#65/#66, research R2/R3),
// plugged into the SDK's mcpAuthRouter, which validates the request shapes,
// PKCE (S256), client authentication and redirect-URI matching before
// calling in here. This class owns what is Bellhop's: consent, codes bound
// to an Authentik sign-in, rotating refresh tokens, and the per-request
// check that the person behind a token is still a Bellhop admin.

export interface BellhopOAuthDeps {
  store: McpAuthStore;
  sessions: SessionService;
  // The store's clock, so a token's reported expiry agrees with the store.
  now?: () => number;
}

export class BellhopOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly now: () => number;

  constructor(private readonly deps: BellhopOAuthDeps) {
    this.now = deps.now ?? Date.now;
    this.clientsStore = {
      getClient: (clientId) => deps.store.getClient(clientId),
      registerClient: (client) => {
        // The SDK generated client_id/client_id_issued_at already
        // (clientIdGeneration), so the type's Omit<> does not apply here.
        const full = client as OAuthClientInformationFull;
        deps.store.saveClient(full);
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const pendingId = this.deps.store.createPending({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      ...(params.state !== undefined ? { state: params.state } : {}),
      scopes: params.scopes ?? [],
      ...(params.resource !== undefined ? { resource: params.resource.href } : {}),
    });
    sendConsentPage(res, { clientName: client.client_name ?? client.client_id, redirectUri: params.redirectUri, pendingId });
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = this.deps.store.peekCode(client.client_id, authorizationCode);
    if (!code) throw new InvalidGrantError('Invalid or expired authorization code');
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const code = this.deps.store.consumeCode(client.client_id, authorizationCode);
    if (!code) throw new InvalidGrantError('Invalid or expired authorization code');
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (resource !== undefined && code.resource !== undefined && resource.href !== code.resource) {
      throw new InvalidGrantError('resource does not match the authorization request');
    }
    if (!this.deps.sessions.store.getSessionByHash(code.sessionHash)) {
      throw new InvalidGrantError('The sign-in behind this code has ended; sign in again');
    }
    const issued = this.deps.store.createGrant({
      clientId: client.client_id,
      sessionHash: code.sessionHash,
      ...(code.resource !== undefined ? { resource: code.resource } : {}),
    });
    return tokensResponse(issued);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const rotated = this.deps.store.rotateRefresh(client.client_id, refreshToken);
    if (!rotated) throw new InvalidGrantError('Invalid refresh token');
    // The grant lives exactly as long as its sign-in (30 days, or until the
    // provider refuses a re-check).
    if (!this.deps.sessions.store.getSessionByHash(rotated.sessionHash)) {
      this.deps.store.deleteGrant(rotated.grantId);
      throw new InvalidGrantError('The sign-in behind this token has ended; sign in again');
    }
    return tokensResponse(rotated);
  }

  // The API key first (#66), then an access token from this server, whose
  // person is re-checked with Authentik on the web session schedule
  // (FR-012). A token whose sign-in has ended is 401 (and its grant
  // removed); a person who is no longer an admin is 403.
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const key = verifyApiKey(token);
    if (key) return key;
    const access = this.deps.store.resolveAccess(token);
    if (!access) throw new InvalidTokenError('Invalid or expired token');
    const user = await this.deps.sessions.resolveHash(access.sessionHash);
    if (!user) {
      this.deps.store.deleteGrant(access.grantId);
      throw new InvalidTokenError('The sign-in behind this token has ended; sign in again');
    }
    if (!isAdminUser(user.groups)) throw new InsufficientScopeError('MCP access is limited to Bellhop admins');
    // bearerAuth compares expiresAt with the real clock; report the time
    // left by the store's own clock against it.
    const remainingMs = access.expiresAt - this.now();
    return {
      token,
      clientId: access.clientId,
      scopes: [],
      expiresAt: Math.floor((Date.now() + remainingMs) / 1000),
      ...(access.resource !== undefined ? { resource: new URL(access.resource) } : {}),
      extra: { principal: `grant:${access.grantId}`, username: user.username },
    };
  }

  // Revoking a grant ends its sign-in too, so the session row holding
  // Authentik's refresh token does not outlive the access it backed.
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const sessionHash = this.deps.store.revoke(client.client_id, request.token);
    if (sessionHash !== undefined) this.deps.sessions.store.deleteSessionByHash(sessionHash);
  }
}

function tokensResponse(issued: IssuedTokens): OAuthTokens {
  return {
    access_token: issued.accessToken,
    token_type: 'bearer',
    expires_in: issued.expiresInSeconds,
    refresh_token: issued.refreshToken,
  };
}
