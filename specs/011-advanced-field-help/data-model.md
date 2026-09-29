# Data Model: Field Explanations in the Guest Advanced Modal

No persisted data. Two in-memory shapes:

## Field explanation map

`ADVANCED_FIELD_HELP` in `web-client/src/lib/advanced-field-help.ts`, declared `as const`; `AdvancedFieldLabel` is its key type, so the modal only compiles for a real label.

| Field | Type | Rule |
|-------|------|------|
| key | string | Exactly the label text the Advanced modal renders (e.g. `read-only proxy`). |
| value | string | One or two sentences, each ending in `.`; non-empty. Exact text in [contracts/field-help.md](contracts/field-help.md). |

Invariant: the key set equals the set of labels rendered by `AdvancedGuestModal.tsx`
(15 keys, including `oidc client`, which is rendered conditionally).

## Open-explanation state (modal-local)

`help: { field: AdvancedFieldLabel; pinned: boolean } | null`, held by `AdvancedGuestModal`. A state whose row is not rendered (`oidc client` once the guest leaves OIDC mode) is treated as `null`.

| Event | Transition |
|-------|------------|
| mouse pointer enters field F's button | if nothing pinned → `{F, pinned: false}` |
| mouse pointer leaves F's field (button, label, popover) for 150ms | if `{F, pinned: false}` → `null` |
| click / tap / Enter / Space on F | if `{F, pinned: true}` → `null`; else → `{F, pinned: true}` |
| Escape anywhere in the document while F open | → `null` (focus returns to F's button if it was inside F) |
| pointer-down outside F's button and popover | if F open → `null` |
| focus leaves F's button (not into its popover) | if F pinned → `null` |
