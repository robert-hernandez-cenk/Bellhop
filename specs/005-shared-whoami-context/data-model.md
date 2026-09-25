# Data Model: Shared signed-in identity in the web UI

## WhoAmI (unchanged shape, moved)

Response of `GET /api/whoami`. Moves from `components/Sidebar.tsx` to `api/types.ts`.

| Field | Type | Notes |
| --- | --- | --- |
| username | string | |
| email | string? | |
| groups | string[] | overlaid by impersonation server-side |
| impersonating | string? | present only while impersonating |
| localOperator | boolean | |
| isAdmin | boolean | computed server-side |
| adminGroups | `{ app: string; authentikBuiltin: string }` | |
| capabilities | `{ userDirectory: boolean }` | |

## WhoAmIState (new, client-only)

| Field | Type | Initial | Meaning |
| --- | --- | --- | --- |
| whoami | WhoAmI \| null | null | last successful answer; null when unknown or after a failure |
| loading | boolean | true | a request is in flight |
| error | string \| null | null | message of the most recent failure; cleared on success |
| generation | number | 0 | incremented once per settled `refresh()`, never by `load()` |

### Transitions

```text
initial {whoami:null, loading:true, error:null, gen:0}
  load() success   -> {whoami:W, loading:false, error:null, gen:0}
  load() failure   -> {whoami:null, loading:false, error:E, gen:0}
  refresh() start  -> loading:true (whoami kept until settled)
  refresh() success-> {whoami:W', loading:false, error:null, gen:+1}
  refresh() failure-> {whoami:null, loading:false, error:E, gen:+1}
  stale response (an older request settling after a newer one started) -> ignored
```

Every transition produces a new state object (reference change) so
`useSyncExternalStore` re-renders; `getState()` returns the same object between
transitions.
