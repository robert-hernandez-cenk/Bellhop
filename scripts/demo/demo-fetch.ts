// A demoFetch answers the two community-scripts REST/raw shapes the app
// catalog and install-app's own app check need (src/lib/script-catalog.ts's
// fetchRepoSlugs, src/operations/app-check.ts's checkAppUrl), so the demo
// web UI's App field and its Update page never make a real network call.
// See specs/014-web-ui-screenshots/research.md R3.
const GITHUB_OWNER = 'community-scripts';
const STABLE_REPO = 'ProxmoxVE';
const DEV_REPO = 'ProxmoxVED';

// Every `app` slug set on a demo guest (scripts/demo/demo-inventory.ts) MUST
// appear here, or the Update page and the install-app app check for that
// guest would report the app missing -- plus enough other well-known public
// community-scripts slugs that the catalog's suggestion popup looks like a
// real one rather than a nine-entry list. These are public software names,
// not operator data.
export const DEMO_CATALOG_SLUGS = {
  stable: [
    'caddy',
    'authentik',
    'jellyfin',
    'homeassistant',
    'paperless-ngx',
    'nextcloud',
    'vaultwarden',
    'grafana',
    'pihole',
    'plex',
    'sonarr',
    'radarr',
    'prowlarr',
    'qbittorrent',
    'portainer',
    'uptimekuma',
    'influxdb',
    'mariadb',
    'postgresql',
    'redis',
    'nginxproxymanager',
    'wireguard',
    'adguardhome',
    'immich',
    'changedetection',
    'freshrss',
  ],
  dev: ['budget-board', 'demo-dev-app'],
} as const;

function scriptBody(slug: string): string {
  return [
    '#!/usr/bin/env bash',
    `# Demo placeholder install script for ${slug} -- community-scripts style, no real network access.`,
    'var_cpu="${var_cpu:-1}"',
    'var_ram="${var_ram:-512}"',
    'var_disk="${var_disk:-4}"',
    'echo "Access it using the following URL:"',
    'echo "http://${IP}"',
    '',
  ].join('\n');
}

function contentsResponse(slugs: readonly string[]): Response {
  const body = slugs.map((slug) => ({ name: `${slug}.sh`, type: 'file' }));
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}

function contentsUrl(repo: string): string {
  return `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/ct`;
}

function rawCtPattern(repo: string): RegExp {
  return new RegExp(`^https://raw\\.githubusercontent\\.com/${GITHUB_OWNER}/${repo}/main/ct/([^/]+)\\.sh$`);
}

function rawInstallPattern(repo: string): RegExp {
  return new RegExp(`^https://raw\\.githubusercontent\\.com/${GITHUB_OWNER}/${repo}/main/install/([^/]+)-install\\.sh$`);
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// Typed exactly as `typeof fetch` (mirrors the `withStubbedFetch` pattern in
// test/lib/authentik-client.test.ts) so it drops straight into every real
// call site's `fetchImpl` parameter.
export const demoFetch: typeof fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
  const url = requestUrl(input);

  if (url === contentsUrl(STABLE_REPO)) return contentsResponse(DEMO_CATALOG_SLUGS.stable);
  if (url === contentsUrl(DEV_REPO)) return contentsResponse(DEMO_CATALOG_SLUGS.dev);

  const stableCt = url.match(rawCtPattern(STABLE_REPO));
  if (stableCt && (DEMO_CATALOG_SLUGS.stable as readonly string[]).includes(stableCt[1])) {
    return new Response(scriptBody(stableCt[1]), { status: 200 });
  }
  const devCt = url.match(rawCtPattern(DEV_REPO));
  if (devCt && (DEMO_CATALOG_SLUGS.dev as readonly string[]).includes(devCt[1])) {
    return new Response(scriptBody(devCt[1]), { status: 200 });
  }

  const stableInstall = url.match(rawInstallPattern(STABLE_REPO));
  if (stableInstall && (DEMO_CATALOG_SLUGS.stable as readonly string[]).includes(stableInstall[1])) {
    return new Response(scriptBody(stableInstall[1]), { status: 200 });
  }
  const devInstall = url.match(rawInstallPattern(DEV_REPO));
  if (devInstall && (DEMO_CATALOG_SLUGS.dev as readonly string[]).includes(devInstall[1])) {
    return new Response(scriptBody(devInstall[1]), { status: 200 });
  }

  return notFound();
}) as typeof fetch;
