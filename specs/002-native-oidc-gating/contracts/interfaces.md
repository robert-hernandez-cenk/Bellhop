# Interface Contracts: Native OIDC Gating

Phase 1 output for [plan.md](plan.md). Example values only.

## CLI

### `sync-authentik [--apply]` (changed)

New output sections, each printed only when non-empty so existing output is unchanged:

```text
OpenID clients to create: 1
  + media
OpenID client settings to update: 1
  ~ media: redirect_uris, grant_types
Auth mode switches: 1
  ~ media: forward -> oidc
OpenID clients to delete: 1
  - media — the app's OIDC login stops working until new credentials are entered in it
OIDC entries skipped: 1
  ! media — no callback URL set (set oidcRedirectUris, or Callback URLs on the Dashboard)
OIDC discovery: 1
  ✓ media https://auth.example.com/application/o/media/
```

Exit code: non-zero when any `discovery` entry failed or any OIDC entry was skipped for a missing
signing key or scope mapping (misconfiguration the operator must fix). Dry run never exits
non-zero for a skip.

### `oidc-credentials <entry>` (new)

Read-only; `<entry>` is a host, guest or external-site name. Prints:

```text
Issuer:        https://auth.example.com/application/o/media/
Client ID:     <client-id>
Client secret: <client-secret>
```

Fails with a named error when the entry is not OIDC-gated, when no Bellhop-owned OpenID client
exists yet ("run sync-authentik --apply"), or when Authentik is unconfigured.

### `adopt-oidc-client <entry> [--apply]` (new)

Dry run lists what adoption would change (`meta_publisher`, then every drifted setting from
research R4, then binding changes). `--apply` performs it. Refuses when the entry is not
OIDC-gated, when no Application exists at its slug, when that Application is already owned, or when
it is not backed by an OAuth2 provider.

### Inventory editing

Hosts and external sites get `authMode`/`oidcRedirectUris` through the database or
`import-yaml-inventory`, as `authGroup` works today. `inventory/hosts.yaml.example` documents both.

## Web API

All routes are under `/api` and behind `requireAuth`.

### `PATCH /inventory/guests/:name` (changed)

New body fields:

| Field | Type | Rule |
|---|---|---|
| `authMode` | `'forward' \| 'oidc' \| null` | admin only (403 otherwise); `null` clears to forward |
| `oidcRedirectUris` | `string` (`;`-joined) or `string[]` | admin only; each must be an absolute http(s) URL (400) |
| `confirmOidcClientDeletion` | `boolean` | required `true` when the edit leaves effective OIDC (400 otherwise) |

New response field, omitted when empty: `oidcDiscoveryFailures: { slug, issuer, error }[]`, scoped to
this guest, shown as a warning. The save itself still succeeds.

### `GET /oidc/:entry/credentials` (new, admin only)

`200 { issuer, clientId, clientSecret }`. `404` when the entry is unknown, `409` when it is not
OIDC-gated or has no owned client yet (body names `sync-authentik`), `502` when Authentik fails,
`503` when Authentik is unconfigured. Response is never logged.

### `POST /oidc/:entry/adopt/preview` and `/adopt/apply` (new, admin only)

Preview returns `{ preview: string }`. Apply enqueues the shared `adopt-oidc-client` operation and
returns `{ jobId }`, same as other operations.

## MCP tools

- `edit_guest`: gains `authMode`, `oidcRedirectUris`, `confirmOidcClientDeletion` with the same
  rules as the web PATCH. The MCP server runs as the admin operator, so the admin checks pass; the
  confirmation rule still applies.
- `get_oidc_client` (new): input `{ entry }`, returns `{ issuer, clientId, secretAvailableFrom }`
  where `secretAvailableFrom` is the fixed text "the Dashboard (admin) or `bellhop oidc-credentials
  <entry>`". Never returns the secret.
- `adopt_oidc_client` (new, generated from the shared operation): dry run by default, `apply: true`
  enqueues a job.

## `AuthentikClient` additions (`src/lib/authentik-client.ts`)

```ts
interface AuthentikOAuth2Provider {
  id: string;
  name: string;
  assignedApplicationSlug?: string;
  clientType: 'confidential' | 'public';
  grantTypes: string[];
  signingKeyId?: string;
  propertyMappingIds: string[];
  redirectUris: { matchingMode: 'strict' | 'regex'; url: string }[];
}

listOAuth2Providers(): Promise<AuthentikOAuth2Provider[]>;
createOAuth2Provider(input: OAuth2ProviderSettings & { name: string }): Promise<AuthentikOAuth2Provider>;
updateOAuth2Provider(id: string, input: Partial<OAuth2ProviderSettings>): Promise<void>;
deleteOAuth2Provider(id: string): Promise<void>;
getOAuth2Credentials(id: string): Promise<{ clientId: string; clientSecret: string; issuer: string }>;
updateApplication(slug: string, input: { providerId?: string; metaPublisher?: string }): Promise<void>;
getSigningKeyId(name: string): Promise<string>;           // throws, naming AUTHENTIK_OIDC_SIGNING_KEY_NAME
getScopeMappingIds(managed: string[]): Promise<string[]>; // throws, naming the missing mapping
```

`AuthentikApplication` gains `metaPublisher?: string`. `OAuth2ProviderSettings` is the
`clientType`/`grantTypes`/`signingKeyId`/`propertyMappingIds`/`redirectUris`/
`authorizationFlowId`/`invalidationFlowId` subset. `UnconfiguredAuthentikClient` rejects every new
method with `UNCONFIGURED_MESSAGE`. `FakeAuthentikClient` implements all of them in memory and
generates a deterministic `client_id`/`client_secret` per provider.
