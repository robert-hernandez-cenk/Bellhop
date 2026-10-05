# Contract: Settings API and Proxy tab (#72)

## `GET`/`PATCH /api/settings` response changes

`proxyDrivers[]` entries:

```diff
  id, label, defaultConfigPath, suggestedStatusPagePath, managesProxy,
- usesSharedCertificate: boolean,
- usesCaddyTls: boolean,
+ tlsSources: string[],        // driver's supported list, TLS_SOURCES order
+ defaultTlsSource: string,
  usesCertResolver, usesApiUrl, usesNpmApi, configPathNote
```

Top level:

```diff
- caddyTlsModes: string[];
- defaultCaddyTls: string;
+ acmeDnsProviders: string[];   // ['cloudflare']
+ defaultAcmeDnsProvider: string;
```

`settings` gains `tlsSource?` and `acmeDnsProvider?` and loses
`proxyCaddyTls?`. PATCH accepts `tlsSource`/`acmeDnsProvider` like any other
enum setting (schema-validated, no driver check). An unknown `proxyCaddyTls`
key is rejected by the existing unknown-key check.

## Proxy tab field order

`proxyDriver`, `proxyConfigPath`, `statusPagePath`, `tlsSource`,
`acmeDnsProvider`, `proxyTlsCertificate`, `proxyTlsKey`, `proxyCertResolver`,
`proxyApiUrl`, `npmApiUrl`, `npmApiEmail`, `npmApiPassword`.

## Visibility (`proxyFieldView`)

"Shown source" = unsaved `tlsSource` draft, else stored `tlsSource`, else the
selected driver's `defaultTlsSource`.

| Field | Shown when |
|---|---|
| TLS source | selected driver manages a proxy |
| ACME DNS provider | managed and shown source is `acme-dns` |
| TLS certificate / key | managed and shown source is `files` |
| Proxy cert resolver | managed, driver `usesCertResolver`, and shown source is `acme-dns` or `acme-http` |
| Proxy API URL, NPM fields | unchanged (`usesApiUrl`, `usesNpmApi`) |

## TLS source dropdown options (`tlsSourceOptions`)

The driver's `tlsSources` in order, the default suffixed ` (default)`. If the
shown source is not in that list, it is appended as `<value> (not supported)`
so the select can display it.

## Unsupported warning

Shown under the TLS source field when the shown source is not in the
selected driver's list:

```text
The <driver label> driver does not support '<value>'. It supports: <a>, <b>.
```

Hiding is display-only: switching driver or source never clears a stored or
drafted value. Layout follows the existing field rows (no horizontal scroll
at ≤640px).
