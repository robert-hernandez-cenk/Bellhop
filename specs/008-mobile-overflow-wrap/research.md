# Research: Long values wrap instead of overflowing on phone-width screens

## Reproduction (baseline, before any change)

Measured in headless Chrome with an explicit device-metrics override against a local web service. The service used an inventory imported from `inventory/hosts.yaml.example` and a scratch jobs database seeded with example jobs, one of them with target `examplelongguestnamewithoutanyhyphenslxc` and triggering user `administrator@example.com`.

| Page | Width | Viewport | `.content` scrollWidth | Observed |
| --- | --- | --- | --- | --- |
| `/jobs/:id` (long target) | 390px | 390 | 509 | Badge and Stop button off the right edge |
| `/jobs` | 390px | 390 | 390 | Fits, but only because the example target is just short enough |
| `/jobs` | 320px | 320 | 342 | Target value runs past the card edge |
| `/jobs/:id` (hyphenated target) | 390px | 390 | 390 | Fits; the title wraps at hyphens and `AWAITING INPUT` splits over two lines |

The root cause is the same in both places. A flex item's default `min-width: auto` resolves to its min-content width, which is its longest unbreakable word. `.job-header` doesn't wrap, and its title `<div>` can't shrink below that word. Each mobile card `td` is `display: flex`, and its value, an anonymous flex item or a child element, can't shrink below its longest word either. Values with hyphens or spaces already break, which is why the problem only shows up with single-word names.

A third instance of the same cause turned up during implementation, once the header fix was in (see R5). At 320px an `awaiting_input` job's prompt banner is still 325px wide, even with a short target.

## R1: Wrapping versus truncation

**Decision**: wrap, breaking inside a word only when there's no other break point.

**Rationale**: a phone has no hover to reveal truncated text, and the values involved (guest names, usernames) are the ones an operator reads to identify a job. The issue left this open. The spec settles it (FR-007).

**Alternatives considered**: ellipsis truncation with `text-overflow`. It keeps rows one line tall, but hides the part of the name that often tells two similar guests apart.

## R2: Which wrapping property

**Decision**: `overflow-wrap: anywhere`.

**Rationale**: `anywhere` is the only `overflow-wrap` value whose soft wrap opportunities count toward min-content size. That lowers the flex item's automatic minimum width, which is exactly the constraint causing the overflow. `overflow-wrap: break-word` breaks the word visually but leaves min-content unchanged, so the flex item still refuses to shrink. `overflow-wrap` is inherited, so setting it on the card `td` also covers text inside child elements (links, spans), with no need to put `min-width: 0` on every child. The file already uses `overflow-wrap: anywhere` for the same reason on `.warning-banner`, `.preview-pane` and the custom-script notices.

**Alternatives considered**:
- `word-break: break-all`. It breaks every word at the line end even when a normal break point exists, which makes ordinary hyphenated names ragged.
- `min-width: 0` on every card child. It isn't needed once min-content shrinks, and it risks squeezing inputs and buttons.

## R3: Job header layout

**Decision**:
- `.job-header` gets `flex-wrap: wrap` and a gap.
- The title block gets a new class `job-header-main` with `min-width: 0; overflow-wrap: anywhere`.
- `.job-status-badge` gets `white-space: nowrap`.

**Rationale**: with wrapping allowed, the actions group moves to its own line when title and actions don't fit side by side. The flex line-breaking decision uses each item's max-content size, so this happens before anything overflows. On its own line the title can shrink and break a long word. The badge is about 120px wide, far below 320px, so keeping it on one line can never cause an overflow by itself, and it fixes `AWAITING INPUT` splitting into two lines. On desktop the title and actions fit on one line, so nothing changes.

**Alternatives considered**: a `@media (max-width: 640px)` rule that always stacks the header. That also stacks short titles that would fit beside the actions, and wrapping handles every width without a breakpoint-specific rule.

## R4: How to test a CSS-only fix under the constitution

**Decision**: a Node test reads `web-client/src/index.css` and `web-client/src/pages/JobView.tsx` as text and asserts the declarations the fix relies on:
- `.job-header` wraps
- `.job-header-main` has `min-width: 0` and `overflow-wrap: anywhere`
- the badge is `nowrap`
- the mobile `.data-table tbody td` rule has `overflow-wrap: anywhere` and `text-align: right`
- `JobView` applies `job-header-main`

The behavioral proof is the browser measurement in `quickstart.md`, recorded in the PR.

**Rationale**: Principle III requires a test that fails without the fix, and requires tests to be deterministic and free of network and browser dependencies. Node's test runner has no layout engine. A static assertion is the strongest check that fits those rules.

**Alternatives considered**:
- A jsdom-based test. jsdom doesn't do layout, so `scrollWidth` is always 0 and the test would prove nothing.
- A Playwright/Chrome test. It adds a browser dependency to CI, and the spec lists visual-regression tooling as a non-goal.

## R5: Prompt banner answer field

**Finding**: after the header fix, `/jobs/:id` for an `awaiting_input` job still measures `.content` scrollWidth 325 at a 320px viewport. The offenders are the banner's buttons and the `.prompt-banner-freetext` form, all 293px wide against 256px of available space (320 minus 20px content padding each side, minus 12px banner padding each side). Below the breakpoint the actions column stretches its children, and the form's own minimum width is the `<input>`'s intrinsic width (about 203px, the browser default for a text field), plus the 8px gap and the 82px Submit button. `.prompt-banner-freetext { min-width: 0 }` at the breakpoint (issue #160 follow-up) lets the form shrink, but not the input inside it.

**Decision**: add `min-width: 0` to `.prompt-banner-freetext input`. The input already has `flex: 1`, so it takes whatever the Submit button leaves, and the field and button stay side by side.

**Alternatives considered**: stacking the input above Submit at the breakpoint. It costs a row of height on the screen that holds the most time-sensitive control, and it isn't needed at any supported width.
