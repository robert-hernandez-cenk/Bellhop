# Interface contracts: Keep custom scope mappings on an OpenID client

## `AuthentikClient` (`src/lib/authentik-client.ts`)

Removed:

```ts
getScopeMappingIds(managed: string[]): Promise<string[]>;
```

Added:

```ts
// Every scope property mapping on the instance. Throws when Authentik reports
// more mappings (pagination.count) than the single page returned.
listScopeMappings(): Promise<AuthentikScopeMapping[]>;
```

`UnconfiguredAuthentikClient.listScopeMappings` rejects with the usual "not configured"
error, like every other method.

## `sync-authentik.ts` exports

```ts
export type OidcInstanceSettings =
  | { ok: true; signingKeyId: string; scopeMappingIds: string[]; scopeNameById: ReadonlyMap<string, string> }
  | { ok: false; kind: 'missing-signing-key' | 'missing-scope-mapping'; reason: string };

export function diffOAuth2Settings(
  current: AuthentikOAuth2Provider,
  desired: DesiredOAuth2Settings,
  scopeNameById: ReadonlyMap<string, string>
): { changes: string[]; patch: Partial<OAuth2ProviderSettings> };
```

The `missing-scope-mapping` reason text is unchanged: `could not resolve the OpenID scope
mappings: No Authentik scope property mapping found for managed id '<id>'`.

## CLI / web / MCP output

No format change. `sync-authentik`'s `OpenID client settings to update` line and
`adopt-oidc-client`'s preview print `property_mappings` under the new, narrower condition
only.
