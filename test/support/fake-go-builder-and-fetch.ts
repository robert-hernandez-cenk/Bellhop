import type { GoBuilder } from '../../src/lib/go-build.ts';

// Shared test doubles for deploy-vpn-gateway's Go cross-compile step and its
// NordVPN/PIA API calls -- used by both test/commands/deploy-vpn-gateway.test.ts
// (command-level tests) and test/web/routes/provisioning.test.ts (route-level
// tests), which previously each carried their own copy of these.

export const FAKE_AGENT_BINARY = Buffer.from('fake-agent-binary');

export class FakeGoBuilder implements GoBuilder {
  built: string[] = [];
  async build(sourceDir: string): Promise<Buffer> {
    this.built.push(sourceDir);
    return FAKE_AGENT_BINARY;
  }
}

// `connected` drives the post-provision /status poll (the check that stops a
// forked-but-dead agent from being recorded as a working gateway).
export function fakeNordVpnFetch(connected = true): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes('users/services/credentials')) {
      return { ok: true, status: 200, json: async () => ({ nordlynx_private_key: 'priv' }) } as Response;
    }
    if (String(url).includes('servers/recommendations')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ hostname: 'nl123.nordvpn.com', locations: [{ country: { name: 'Netherlands' } }] }],
      } as Response;
    }
    if (String(url).includes('/status')) {
      return { ok: true, status: 200, json: async () => ({ connected, dns: '103.86.96.100' }) } as Response;
    }
    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof fetch;
}

export function fakePiaFetch(connected = true): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes('api/client/v2/token')) {
      return { ok: true, status: 200, json: async () => ({ token: 'session-token' }) } as Response;
    }
    if (String(url).includes('serverlist.piaservers.net')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ regions: [{ name: 'US Atlanta', servers: { wg: [{ cn: 'atlanta123' }] } }] }),
      } as Response;
    }
    if (String(url).includes('/status')) {
      return { ok: true, status: 200, json: async () => ({ connected, dns: '10.0.0.242' }) } as Response;
    }
    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof fetch;
}
