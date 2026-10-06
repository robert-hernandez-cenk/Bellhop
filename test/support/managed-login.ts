import type { Inventory } from '../../src/lib/inventory.ts';
import { configureManagedWebLogin, refreshManagedWebLogin } from '../../src/web/login/managed.ts';
import { FakeAuthentikClient } from './fake-authentik-client.ts';

// Bellhop's own guest: flagged, OIDC-gated, with the fixed /auth/callback URL.
export function bellhopInventory(overrides: Partial<Inventory['guests'][number]> = {}): Inventory {
  return {
    domain: 'example.com',
    hosts: [{ name: 'pve1', ssh_target: 'pve1.local', ssh_user: 'root', authentik: true, ip: '192.0.2.5' }],
    guests: [
      {
        name: 'bellhop-lxc',
        type: 'lxc',
        vmid: 130,
        host: 'pve1',
        ip: '192.0.2.30',
        subdomains: ['bellhop'],
        authGroup: 'bellhop-users',
        authMode: 'oidc',
        oidcRedirectUris: ['https://bellhop.example.com/auth/callback'],
        bellhop: true,
        ...overrides,
      },
    ],
  };
}

// FakeAuthentikClient's default credentials for provider 50 are
// client-50 / secret-50; the secret must never appear in a log line, a
// problem text, or any response.
export const MANAGED_SECRET = 'secret-50';
export const MANAGED_CLIENT_ID = 'client-50';
export const MANAGED_ISSUER = 'https://auth.example.com/application/o/bellhop/';
export const MANAGED_REDIRECT_URI = 'https://bellhop.example.com/auth/callback';

export class RotatableAuthentik extends FakeAuthentikClient {
  secret = MANAGED_SECRET;
  unreachable = false;
  override async listApplications(...args: Parameters<FakeAuthentikClient['listApplications']>) {
    if (this.unreachable) throw new Error('connect ECONNREFUSED 192.0.2.5:9000');
    return super.listApplications(...args);
  }
  override async getOAuth2Credentials(id: string) {
    const creds = await super.getOAuth2Credentials(id);
    return { ...creds, clientSecret: this.secret };
  }
}

// Authentik holding the OpenID client sync-authentik would have made for
// bellhopInventory()'s guest.
export function ownedAuthentik(): RotatableAuthentik {
  return new RotatableAuthentik({
    applications: [
      { id: 'bellhop', pk: 'pk-bellhop', name: 'bellhop', slug: 'bellhop', providerId: '50', metaPublisher: 'bellhop' },
    ],
    oauth2Providers: [
      {
        id: '50',
        name: 'bellhop',
        assignedApplicationSlug: 'bellhop',
        clientType: 'confidential',
        grantTypes: ['authorization_code', 'refresh_token'],
        signingKeyId: 'key-1',
        propertyMappingIds: ['scope-openid-1', 'scope-profile-1', 'scope-email-1', 'scope-offline-access-1'],
        redirectUris: [{ matchingMode: 'strict', url: MANAGED_REDIRECT_URI }],
      },
    ],
  });
}

// Points the managed login module at a flagged guest and resolves it, as the
// web service does at startup.
export async function resolveManagedLogin(
  inventory: Inventory = bellhopInventory(),
  authentik: RotatableAuthentik = ownedAuthentik()
): Promise<RotatableAuthentik> {
  configureManagedWebLogin({ inventory: () => inventory, authentik });
  await refreshManagedWebLogin();
  return authentik;
}
