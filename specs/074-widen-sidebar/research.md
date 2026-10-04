# Research: Widen the desktop sidebar (#74)

## R1 — Why the label wraps

- **Finding**: Measured in the demo instance (system-ui, 16px): "Deploy VPN Gateway" is 150px of text. The 200px sidebar, minus 24px padding, a 1px border and 16px link padding, leaves 159px. It fits with no scroll bar. A classic Windows scroll bar takes about 15px, leaving about 144px, so the label wraps as soon as the nav overflows vertically. A real deployment shows Users, Permissions and the impersonation picker on top of the demo's nav, so it overflows at ordinary heights. The wrapped line adds about 24px of height, which makes the overflow worse.
- **Decision**: Fix the width so the widest label fits even with a scroll bar, and forbid wrapping outright.

## R2 — Width

- **Decision**: 220px.
- **Rationale**: 150 (text) + 16 (link padding) + 24 (sidebar padding) + 1 (border) + about 15 (scroll bar) ≈ 206px, leaving about 14px of headroom for font differences. 220px stays narrower than the 240px mobile drawer and costs the content area only 20px.
- **Alternatives considered**: `width: max-content` (column follows its widest child) was rejected because the warning and impersonation banners and the picker `<select>` would also drive the width, so a long group name could make the sidebar arbitrarily wide. `scrollbar-gutter: stable` alone reserves the scroll bar's width at all times but still leaves only about 144px, so the label would always wrap at 200px.

## R3 — Never wrap

- **Decision**: `.sidebar a { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }` together with `flex-shrink: 0` on `.sidebar`.
- **Rationale**: `nowrap` guarantees one line per link; the ellipsis keeps a future longer label (or a large browser text size) from overflowing the column. `flex-shrink: 0` keeps the flex row from squeezing the sidebar below 220px when the content area has wide content (tables). The rule applies to the sign-out link too, which is short.
- **Alternatives considered**: a smaller font for links, rejected as a visual change the issue didn't ask for.

## R4 — Mobile drawer

- **Finding**: Inside `@media (max-width: 640px)`, `.sidebar` sets `width: 240px; max-width: 80vw`, which overrides the desktop width. `nowrap` + ellipsis also applies there; at 240px every current label fits, and on a very narrow phone (80vw) a long label truncates instead of wrapping.
- **Decision**: No change to the media query.

## R5 — Vertical fit at 1920x1080

- **Finding**: Demo nav content measured about 737px tall. A real admin deployment adds Users and Permissions (about 66px) and the impersonation picker (about 100px), about 900px total, inside a 1920x1080 window's roughly 950px of viewport. With no wrapped line, it fits; the old wrap pushed it to the edge.
- **Decision**: No spacing change (a non-goal); verify in the browser with the admin nav simulated.
