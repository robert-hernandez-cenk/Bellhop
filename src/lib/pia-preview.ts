export interface PiaPreviewServer {
  hostname: string;
  country: string;
}

// Live-validates PIA_USERNAME/PIA_PASSWORD and reports which server
// deploy-vpn-gateway would likely connect to, purely for an accurate
// dry-run preview -- mirrors resolveNordVpnPreviewServer. This does NOT
// feed the actual connection the Go agent makes at startup
// (provider/pia.Connect makes its own, independent call) -- no
// server-selection logic is duplicated here. Matches
// provider/pia.Connect's own "empty country -> first region" default, so
// this preview never claims a different server than a real connect would
// pick. Throws on failure so a dry run without working credentials fails
// fast rather than previewing a script that can't actually run, same
// philosophy as resolveNordVpnPreviewServer's own NORDVPN_ACCESS_TOKEN
// presence check.
export async function resolvePiaPreviewServer(
  username: string,
  password: string,
  fetchImpl: typeof fetch = fetch
): Promise<PiaPreviewServer> {
  const tokenResponse = await fetchImpl('https://www.privateinternetaccess.com/api/client/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
  });
  if (!tokenResponse.ok) {
    throw new Error(`PIA authentication failed (status ${tokenResponse.status}) -- check PIA_USERNAME/PIA_PASSWORD`);
  }
  const tokenBody = (await tokenResponse.json()) as { token?: string };
  if (!tokenBody.token) {
    throw new Error('PIA authentication succeeded but returned no token');
  }

  const serverListResponse = await fetchImpl('https://serverlist.piaservers.net/vpninfo/servers/v6');
  if (!serverListResponse.ok) {
    throw new Error(`PIA server list lookup failed (status ${serverListResponse.status})`);
  }
  const serverList = (await serverListResponse.json()) as {
    regions?: Array<{ name?: string; servers?: { wg?: Array<{ cn?: string }> } }>;
  };
  const region = serverList.regions?.[0];
  const server = region?.servers?.wg?.[0];
  if (!region || !server?.cn) {
    throw new Error('PIA server list: first region had no WireGuard-capable server (this preview only checks regions[0], matching Connect\'s own "empty country -> first region" default)');
  }
  return { hostname: server.cn, country: region.name ?? 'unknown' };
}
