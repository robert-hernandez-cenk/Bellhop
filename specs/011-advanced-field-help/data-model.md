# Data Model: Field Explanations in the Guest Advanced Modal

No persisted data. Two in-memory shapes:

## Field explanation map

`ADVANCED_FIELD_HELP: Record<string, string>` in `web-client/src/lib/advanced-field-help.ts`.

| Field | Type | Rule |
|-------|------|------|
| key | string | Exactly the label text the Advanced modal renders (e.g. `read-only proxy`). |
| value | string | One or two sentences, each ending in `.`; non-empty. Exact text in [contracts/field-help.md](contracts/field-help.md). |

Invariant: the key set equals the set of labels rendered by `AdvancedGuestModal.tsx`
(15 keys, including `oidc client`, which is rendered conditionally).

## Open-explanation state (modal-local)

`help: { field: string; pinned: boolean } | null`, held by `AdvancedGuestModal`.

| Event | Transition |
|-------|------------|
| mouse pointer enters field F's button | if nothing pinned → `{F, pinned: false}` |
| mouse pointer leaves F's button | if `{F, pinned: false}` → `null` |
| click / tap / Enter / Space on F | if `{F, pinned: true}` → `null`; else → `{F, pinned: true}` |
| Escape while F open | → `null` (focus stays on F's button) |
| pointer-down outside F's button and popover | if F open → `null` |
| focus leaves F's button (not into its popover) | if F pinned → `null` |
