// Placement for an anchored FieldHelp explanation (issue #75). Framework-free
// so it's tested with plain `node --test`: the caller measures the ⓘ
// button's viewport rectangle, the popover's rendered size and the viewport,
// and this decides where the popover goes. Everything is in viewport (CSS
// pixel) coordinates, matching the popover's `position: fixed`.

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  side: 'below' | 'above';
}

// Space between the button and the popover -- the row popover's own
// margin-top, so both placements look alike.
export const POPOVER_GAP = 2;
// Minimum distance kept from the viewport's left and right edges, the same
// 16px side gutter the page itself uses on a phone.
export const POPOVER_GUTTER = 16;
// Widest the explanation grows before its text wraps.
export const POPOVER_MAX_WIDTH = 320;

export function popoverMaxWidth(viewportWidth: number): number {
  return Math.max(0, Math.min(POPOVER_MAX_WIDTH, viewportWidth - 2 * POPOVER_GUTTER));
}

// Below the anchor unless it doesn't fit there and there is more room above.
// When neither side fits, the roomier side wins, so as much as possible of
// the explanation stays visible.
export function placePopover(anchor: AnchorRect, size: PopoverSize, viewport: Viewport): Placement {
  const spaceBelow = viewport.height - anchor.bottom - POPOVER_GAP;
  const spaceAbove = anchor.top - POPOVER_GAP;
  const side = spaceBelow >= size.height || spaceBelow >= spaceAbove ? 'below' : 'above';
  const top = side === 'below' ? anchor.bottom + POPOVER_GAP : anchor.top - POPOVER_GAP - size.height;

  const maxLeft = viewport.width - POPOVER_GUTTER - size.width;
  const left = maxLeft < POPOVER_GUTTER ? POPOVER_GUTTER : Math.min(Math.max(anchor.left, POPOVER_GUTTER), maxLeft);

  return { top, left, side };
}
