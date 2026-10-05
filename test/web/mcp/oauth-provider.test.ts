import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { McpAuthStore } from '../../../src/web/mcp/auth-store.ts';
import { BellhopOAuthProvider } from '../../../src/web/mcp/oauth-provider.ts';
import { newTestSessions } from '../../support/web-session.ts';

const CLIENT: OAuthClientInformationFull = { client_id: 'client-1', redirect_uris: ['http://localhost:33418/callback'] };
const IDENTITY = {
  username: 'admin',
  uid: 'uid-admin',
  groups: ['bellhop-admins'],
  refreshToken: 'example-refresh',
  idToken: 'example-id',
};

// Review finding: revoking an MCP grant ends its sign-in too, so the
// session row holding Authentik's refresh token doesn't linger 30 days.
test('revoking a refresh token deletes the grant and its sign-in session', async () => {
  const sessions = newTestSessions();
  const store = new McpAuthStore(':memory:');
  const provider = new BellhopOAuthProvider({ store, sessions });
  const sessionHash = sessions.createDetached(IDENTITY);
  const issued = store.createGrant({ clientId: 'client-1', sessionHash });
  await provider.revokeToken(CLIENT, { token: issued.refreshToken });
  assert.equal(sessions.store.getSessionByHash(sessionHash), undefined);
  assert.equal(store.resolveAccess(issued.accessToken), undefined);
});

test('revoking an access token leaves the sign-in in place', async () => {
  const sessions = newTestSessions();
  const store = new McpAuthStore(':memory:');
  const provider = new BellhopOAuthProvider({ store, sessions });
  const sessionHash = sessions.createDetached(IDENTITY);
  const issued = store.createGrant({ clientId: 'client-1', sessionHash });
  await provider.revokeToken(CLIENT, { token: issued.accessToken });
  assert.ok(sessions.store.getSessionByHash(sessionHash));
});
