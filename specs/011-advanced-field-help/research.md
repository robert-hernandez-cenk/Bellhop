# Research: Field Explanations in the Guest Advanced Modal

## R1: How the explanation is reached (mouse, keyboard, touch)

- **Decision**: a real `<button type="button">` showing ⓘ next to each label,
  following the disclosure pattern: `aria-expanded` plus `aria-controls` pointing at
  the popover, and an accessible name of `About <label>`. Hovering with a mouse
  shows the explanation transiently. Click, tap, Enter or Space toggles a *pinned*
  state. Escape, a pointer-down outside the button and popover, or focus leaving the
  button closes it.
- **Rationale**: a `title` attribute is hover-only and never shows on touch. A
  native button gets keyboard focus and Enter/Space activation for free. Hover is
  shown on `pointerenter` only when `pointerType === 'mouse'`. Without that check,
  a tap would fire a hover-open first and then a click-toggle that closes the
  explanation straight away.
- **Alternatives considered**: showing the explanation on focus. Rejected: clicking
  a button focuses it, so a focus-open followed by a click-toggle would close it
  again, and a keyboard user tabbing through the modal would get a popover at every
  stop. Also considered `role="tooltip"` with `aria-describedby`. Rejected: a
  tooltip is supposed to appear on focus and is not meant to be toggled, which
  conflicts with the tap-to-pin behavior touch requires.

## R2: Where the popover renders

- **Decision**: `.form-row` becomes `position: relative`. The popover is
  `position: absolute; top: 100%; left: 0; right: 0`, spanning the full row just
  below it, with a `z-index` above the following rows, a themed background and
  border, and normal text wrapping.
- **Rationale**: absolute positioning takes the popover out of the flow, so no row
  moves (FR-007). Anchoring to the row's full width, not the small button, keeps it
  inside the modal at any width, which covers FR-008 without measuring the
  viewport.
- **Alternatives considered**: expanding the text inline below the row. That shifts
  layout, which is jarring on hover. A portal-based floating popover with viewport
  collision detection is too heavy for static text.

## R3: One open explanation at a time

- **Decision**: `AdvancedGuestModal` holds `help: { field: string; pinned: boolean } | null`
  and passes each `FieldHelp` its `open`/`pinned` state and callbacks. Hover opens a
  field unpinned. Leaving that field closes it unless it is pinned. Pinning one
  field replaces any other.
- **Rationale**: FR-006. Keeping the state in the parent is the simplest way to
  coordinate the fields without a context provider.

## R4: Escape must not close the modal

- **Finding**: `AdvancedGuestModal` has no Escape handler today (only a backdrop
  click closes it), so FieldHelp's `keydown` Escape handling can't conflict. It
  still calls `stopPropagation()`, so a future modal-level Escape handler doesn't
  close the whole modal.

## R5: Where the text lives and how it stays complete

- **Decision**: `web-client/src/lib/advanced-field-help.ts` exports
  `ADVANCED_FIELD_HELP: Record<string, string>`, keyed by the exact label text the
  modal renders. A test reads `AdvancedGuestModal.tsx`'s source and extracts every
  `<FieldHelp field="...">` / label. It then asserts that the label set equals the
  map's key set, so a new field without an explanation fails, and so does a stale
  explanation (SC-005).
- **Rationale**: FR-009. The lib module has no React import, so `node --test` can
  import it directly, matching `prompt-banner.ts` and `admin-nav.ts`.

## R6: Facts behind the explanation text

Verified against the current code and `CLAUDE.md`:

- read-only proxy (`proxyManual`): `buildRoutes` skips the entry, but
  `sync-authentik` still manages its Provider, Application and bindings.
- insecure backend tls: the Dashboard PATCH probes after a `subdomains`/`port`
  change, and install-app's web apply probes too. A *conclusive* probe overwrites
  the submitted value, while an inconclusive one leaves it alone.
- unauthenticated paths: only rendered inside a forward-auth route. It is inert
  when ungated, in OIDC mode, or when the entry is `proxyManual`.
- callback urls (`oidcRedirectUris`): only used once `effectiveAuth()` is `'oidc'`.
  Admin-only in the Dashboard.
- auth group: the entry binds to that rung and every rung above it. Anyone with
  access to the guest may raise it; only an admin may lower or clear it.
- auth mode: admin-only. Leaving OIDC deletes the OIDC client, after a
  confirmation.
- oidc client: issuer, client ID and secret read live from Authentik; only admins
  can reveal them.
- vpn: `set-guest-vpn` runs as a job and reboots the guest (`pct reboot`).
- port: `buildRoutes` defaults a missing port to 80.
- subdomains: the first one is canonical. It is the Authentik application slug for
  a gated entry.
- ip/type: refreshed by `sync-inventory` from Proxmox. `update-all` and
  `configure-guest --packages` never act on a VM.
- host: changed by `migrate-guest`, not editable here.
- vmid: unique across the whole cluster, and derived from the host's MID scheme at
  creation.
- app: recorded by the web/MCP install-app apply. The link opens that app's script,
  in the configured custom repository when it came from there.
