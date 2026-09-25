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
| generation | number | 0 | incremented by 1 when a `refresh()` request settles and is still the latest request started; never by `load()`; a superseded `refresh()`'s settling (bump included) is ignored |

### Transitions

```text
initial {whoami:null, loading:true, error:null, gen:0}
  load() success   -> {whoami:W, loading:false, error:null, gen:0}
  load() failure   -> {whoami:null, loading:false, error:E, gen:0}
  refresh() start  -> loading:true (whoami kept until settled)
  refresh() success, still latest -> {whoami:W', loading:false, error:null, gen:+1}
  refresh() failure, still latest -> {whoami:null, loading:false, error:E, gen:+1}
  stale response (an older request settling after a newer one started) -> ignored entirely,
    including any generation bump it would have produced -- overlapping refresh() calls
    therefore bump gen once, not once per call
```

Every transition produces a new state object (reference change) so
`useSyncExternalStore` re-renders; `getState()` returns the same object between
transitions.
