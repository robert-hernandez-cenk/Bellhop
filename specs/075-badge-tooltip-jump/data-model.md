# Data Model: popover placement

No persisted data. The only "entities" are the value types of the pure
placement module `web-client/src/lib/popover-position.ts`.

## AnchorRect

The ⓘ button's viewport rectangle (from `getBoundingClientRect()`):
`{ top, bottom, left, right }`, in CSS pixels.

## PopoverSize

`{ width, height }`: the popover's rendered size after `maxWidth` is
applied.

## Viewport

`{ width, height }`: `documentElement.clientWidth` / `clientHeight`. The
scrollbar is excluded.

## Placement (output)

`{ top, left, side }`, where `side` is `'below' | 'above'`.

Rules:
- **side**: `'below'` when `viewport.height - anchor.bottom - GAP >= height`,
  or when the space below is at least the space above (`anchor.top - GAP`).
  Otherwise `'above'`.
- **top**: `anchor.bottom + GAP` below, `anchor.top - GAP - height` above.
- **left**: `anchor.left` clamped to
  `[GUTTER, viewport.width - GUTTER - width]`. If that range is empty (the
  popover is wider than the viewport minus both gutters), use `GUTTER`.

Constants: `POPOVER_GAP = 2`, `POPOVER_GUTTER = 16`,
`POPOVER_MAX_WIDTH = 320`.

`popoverMaxWidth(viewportWidth) = max(0, min(POPOVER_MAX_WIDTH, viewportWidth - 2 * POPOVER_GUTTER))`.
