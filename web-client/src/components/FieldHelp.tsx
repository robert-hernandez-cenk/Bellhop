import { useEffect, useId, useRef } from 'react';
import type { FocusEvent, PointerEvent as ReactPointerEvent } from 'react';

// Generic field-label + info-marker disclosure (issue #34). Deliberately has
// no import of any help-text map -- the caller (AdvancedGuestModal today,
// possibly other pages later, per specs/011-advanced-field-help/spec.md's
// "built so those pages can reuse it later" assumption) passes both the
// field name and its explanation text in as props, and owns the open/pinned
// state so at most one explanation is open at a time across a whole modal.
//
// The popover is always rendered, `hidden` while closed, so the button's
// aria-controls always resolves and its aria-describedby lets a screen
// reader read the explanation. tabIndex={-1} on the popover is deliberate:
// clicking inside it (to select text, say) focuses it, which is what lets
// the containment checks below -- the outside-pointerdown listener and the
// pinned-blur-close rule -- treat "moved into the popover" as staying open.

interface FieldHelpProps {
  field: string;
  text: string;
  open: boolean;
  pinned: boolean;
  onHover(open: boolean): void;
  onToggle(): void;
  onClose(): void;
}

// How long a mouse may be outside the field (the ⓘ button, its label and
// its popover) before a hover-opened explanation closes. Covers the small
// gap between the button and the popover, which sits under the whole row.
const HOVER_OUT_DELAY_MS = 150;

export function FieldHelp({ field, text, open, pinned, onHover, onToggle, onClose }: FieldHelpProps) {
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hoverOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The caller may pass fresh callbacks on every render; keep the latest in
  // a ref so the document listeners below are added once per open, not on
  // every render.
  const callbacks = useRef({ onHover, onClose });
  callbacks.current = { onHover, onClose };

  function cancelHoverOut() {
    if (hoverOutTimer.current !== null) {
      clearTimeout(hoverOutTimer.current);
      hoverOutTimer.current = null;
    }
  }

  useEffect(() => cancelHoverOut, []);

  // While open: close on a pointerdown outside both the button and the
  // popover -- both live inside the wrapping <span>, so one containment
  // check against it covers either. Bubble phase, and nothing here calls
  // preventDefault/stopPropagation, so the modal backdrop's own
  // click-to-close still sees the same event when it lands outside this
  // field entirely.
  //
  // Escape is listened for on the document, not the wrapper, because a
  // click doesn't focus a button in Safari on macOS or on touch devices, so
  // focus may never be inside this field. Focus goes back to the button
  // only when it was inside the field, so a keyboard user isn't stranded on
  // a popover that just became hidden.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        callbacks.current.onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const focusInside = wrapperRef.current?.contains(document.activeElement) ?? false;
      callbacks.current.onClose();
      if (focusInside) buttonRef.current?.focus();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Bring a newly opened explanation into view. The Advanced modal scrolls
  // on short (phone) viewports, so a bottom row's explanation can otherwise
  // open below the visible area.
  useEffect(() => {
    if (open) popoverRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  // A pinned explanation closes once focus leaves both the button and the
  // popover -- shared by the button's and the popover's own onBlur below,
  // since either can be the one losing focus (clicking inside the popover
  // moves focus there; tabbing away from it should still close). An
  // unpinned (hover-only) explanation is left alone here -- hover-out
  // already handles that case via onHover.
  function handleBlur(e: FocusEvent) {
    if (!pinned) return;
    const next = e.relatedTarget as Node | null;
    if (wrapperRef.current && next && wrapperRef.current.contains(next)) return;
    onClose();
  }

  // Hover opens from the button only, but hover-out is measured against the
  // whole wrapper (which contains the popover), after a short grace delay,
  // so the mouse can move from the button down onto the explanation.
  function handleWrapperPointerEnter(e: ReactPointerEvent) {
    if (e.pointerType === 'mouse') cancelHoverOut();
  }

  function handleWrapperPointerLeave(e: ReactPointerEvent) {
    if (e.pointerType !== 'mouse') return;
    cancelHoverOut();
    hoverOutTimer.current = setTimeout(() => {
      hoverOutTimer.current = null;
      callbacks.current.onHover(false);
    }, HOVER_OUT_DELAY_MS);
  }

  return (
    <span
      className="field-help"
      ref={wrapperRef}
      onPointerEnter={handleWrapperPointerEnter}
      onPointerLeave={handleWrapperPointerLeave}
    >
      {field}
      <button
        ref={buttonRef}
        type="button"
        className="field-help-button"
        aria-label={`About ${field}`}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={id}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') {
            cancelHoverOut();
            onHover(true);
          }
        }}
        onClick={onToggle}
        onBlur={handleBlur}
      >
        ⓘ
      </button>
      <div
        id={id}
        ref={popoverRef}
        className="field-help-popover"
        tabIndex={-1}
        hidden={!open}
        onBlur={handleBlur}
      >
        {text}
      </div>
    </span>
  );
}
