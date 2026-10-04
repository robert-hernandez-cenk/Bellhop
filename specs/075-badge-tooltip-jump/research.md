# Research: App update badge explanation that stays put

## R1. Root cause (reproduced, not assumed)

Reproduced on the demo instance (`PORT=<free port> npm run demo`, example
inventory only) at a 1905 px-wide window. A script clicked the first
`.app-update-badge .field-help-button`:

- the popover's `offsetParent` was `BODY`
- its rect was `x: 0, width: 1905, y: 996`, the full window width, below
  every card
- `document.scrollingElement.scrollHeight` went from 1031 to 1068 (+37 px)
- the document then scrolled 37 px. That is FieldHelp's
  `scrollIntoView({ block: 'nearest' })` bringing the misplaced popover
  into view.

So the issue's suspected cause is confirmed. The "jump" is that
`scrollIntoView` acting on a popover that was placed against `<body>`. A
hover-opened popover triggers the same scroll, and the scroll can move the
badge out from under the pointer, so hover-out closes it again: the flicker
the issue mentions.

## R2. Positioning strategy

- **Decision**: For the badge, use `position: fixed` with coordinates
  computed in JS from the ⓘ button's `getBoundingClientRect()`. Clamp them
  to the viewport, flip above when there is no room below, and recompute on
  `scroll` (capture phase, passive) and `resize` while open.
- **Rationale**:
  - A fixed box isn't part of the document's scrollable overflow, so it
    cannot change page size or create a scrollbar (FR-004). An absolutely
    positioned box near the bottom can.
  - Viewport-relative coordinates make the horizontal clamp (FR-003) and the
    flip (FR-001) simple arithmetic.
  - No ancestor of the Update page's cards creates a containing block for
    fixed elements: no `transform`, `filter`, `contain` or `will-change`.
    The only `transform` in `index.css` is the mobile sidebar drawer, which
    does not contain the badge.
- **Alternatives considered**:
  - *`position: relative` on `.app-update-badge` + absolute popover sized
    `max-content`.* Simple, but it can't be clamped against the viewport
    without JS. The rightmost card's popover would run off-screen and cause
    horizontal scroll, and a bottom-row popover still adds to the document
    height.
  - *CSS anchor positioning (`anchor-name`, `position-try`).* It would do
    this declaratively, but Firefox does not support it, and the web UI has
    no browser floor that excludes Firefox.
  - *A tooltip library (Floating UI, Popper).* Ruled out by the spec, and
    unnecessary for one below/above placement.
  - *Change the shared `.field-help-popover` for everyone.* That would
    change the Advanced modal's popovers. The modal's row-spanning layout
    and its scroll-into-view inside the scrolling modal are correct there
    (issue #34), and the spec requires keeping them (FR-007).

## R3. `scrollIntoView` in anchored mode

- **Decision**: Skip it in anchored mode.
- **Rationale**: The anchored popover is clamped into the viewport already,
  so there is nothing to scroll to. Any scroll would violate FR-004.

## R4. Width and measurement

- **Decision**: JS sets `maxWidth = popoverMaxWidth(clientWidth)`, which is
  `min(320, clientWidth − 32)` and never less than 0. It then reads the
  popover's `offsetWidth`/`offsetHeight` and calls `placePopover`.
  `width: max-content` in CSS makes the box only as wide as its content.
  CSS also carries a `max-width: min(320px, calc(100vw - 32px))` fallback.
- **Rationale**: `100vw` includes a desktop scrollbar while
  `documentElement.clientWidth` excludes it, so the JS value is what keeps
  a 16 px gutter exact (SC-002). The layout effect runs before paint, so
  the popover never paints at the CSS fallback position.

## R5. Hover continuity

The popover stays a DOM descendant of the FieldHelp wrapper `<span>`, so the
wrapper's `pointerenter`/`pointerleave` and the outside-pointerdown
containment check keep working unchanged: pointer events follow the DOM
tree, not the visual box. The popover sits 2 px from the button (the
existing `margin-top: 2px` gap, applied in JS in anchored mode), well within
the 150 ms hover-out grace delay.
