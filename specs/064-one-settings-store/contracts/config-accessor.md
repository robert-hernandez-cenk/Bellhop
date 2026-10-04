# Contract: config accessor (`src/lib/config.ts`)

```ts
type ConfigKey = MovedSettingKey | SecretSettingKey;
type ConfigSource = 'environment' | 'settings' | 'none';

useConfigStore(inventoryPath: string | null): void   // register once per entry point; null resets (tests)
configValue(key: ConfigKey, env?: NodeJS.ProcessEnv): { value?: string; source: ConfigSource }
invalidateConfigSnapshot(): void                     // web /api middleware + every in-process write
writeSecret(inventoryPath: string, key: SecretSettingKey, value: string): void
clearSecret(inventoryPath: string, key: SecretSettingKey): void
storedSecretKeys(inventoryPath): Set<SecretSettingKey>   // for "set"/"not set"; never values
effectiveValue(key, stored: string | undefined, env): { value?; source }   // pure; shared with the #158 migration
```

Consumers (all read at point of use, never cached beyond the snapshot):

| Consumer | Keys |
| --- | --- |
| `authentikConfig()`, `authentikConfigured()` | `authentik*` |
| `authMode()` | `webUiAuthMode` |
| `buildAuthentikClient()` (live) | `authentikApiUrl`, `authentikApiToken` |
| `buildCloudflareClient()` (live) | `cloudflareDnsApiToken` |
| `buildNpmClient()` | `npmApiUrl`, `npmApiEmail`, `npmApiPassword` |
| `githubApiHeaders()` | `githubApiToken` |
| #158 migration (inside `openInventoryDb`) | `authentikGroupLadder` via `effectiveValue` |

Errors name the key and its env var, never a value.

`importEnvFiles(inventoryPath, dataDir)` (`src/lib/config-import.ts`): returns
`{ imported: Array<{ key, variable, file }>, skipped: Array<{ key, variable, file, reason }> }`;
logs one line per imported key; never overwrites; never touches the files; no-op when the
database file does not exist.
