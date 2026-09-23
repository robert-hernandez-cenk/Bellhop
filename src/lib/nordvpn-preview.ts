export interface NordVpnPreviewServer {
  hostname: string;
  country: string;
}

// Live-validates NORDVPN_ACCESS_TOKEN and reports which server
// deploy-vpn-gateway would likely connect to, purely for an accurate
// dry-run preview -- mirrors resolveNfsMountPath's live pvesh call during
// create-lxc's NFS preview. This does NOT feed the actual connection the
// Go agent makes at startup (provider/nordvpn.Connect makes its own,
// independent call) -- no server-selection logic is duplicated here.
// Throws on failure so a dry run without a working token fails fast
// rather than previewing a script that can't actually run,
// same philosophy as deploy-vpn-gateway's own NORDVPN_ACCESS_TOKEN
// presence check.
export async function resolveNordVpnPreviewServer(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<NordVpnPreviewServer> {
  const authResponse = await fetchImpl('https://api.nordvpn.com/v1/users/services/credentials', {
    headers: { Authorization: `Basic ${Buffer.from(`token:${accessToken}`).toString('base64')}` },
  });
  if (!authResponse.ok) {
    throw new Error(`NordVPN authentication failed (status ${authResponse.status}) -- check NORDVPN_ACCESS_TOKEN`);
  }

  const serversUrl =
    'https://api.nordvpn.com/v1/servers/recommendations?filters%5Bservers_technologies%5D%5Bidentifier%5D=wireguard_udp&limit=1';
  const serversResponse = await fetchImpl(serversUrl);
  if (!serversResponse.ok) {
    throw new Error(`NordVPN server lookup failed (status ${serversResponse.status})`);
  }
  const servers = (await serversResponse.json()) as Array<{
    hostname: string;
    locations?: Array<{ country?: { name?: string } }>;
  }>;
  const server = servers[0];
  if (!server) {
    throw new Error('NordVPN returned no WireGuard-capable server');
  }
  return { hostname: server.hostname, country: server.locations?.[0]?.country?.name ?? 'unknown' };
}
