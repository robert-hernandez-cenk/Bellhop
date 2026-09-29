import { useEffect, useId, useRef } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';

// Generic field-label + info-marker disclosure (issue #34). Deliberately has
// no import of any help-text map -- the caller (AdvancedGuestModal today,
// possibly other pages later, per specs/011-advanced-field-help/spec.md's
// "built so those pages can reuse it later" assumption) passes both the
// field name and its explanation text in as props, and owns the open/pinned
// state so at most one explanation is open at a time across a whole modal.
//
// tabIndex={-1} on the popover is deliberate: clicking inside the popover
// (to select text, say) focuses it, which is what lets the containment
// checks below -- the outside-pointerdown listener (T007) and the
// pinned-blur-close rule (T009) -- treat "moved into the popover" as staying
// open rather than closing.

interface FieldHelpProps {
  field: string;
  text: string;
  open: boolean;
  pinned: boolean;
  onHover(open: boolean): void;
  onToggle(): void;
  onClose(): void;
}

export function FieldHelp({ field, text, open, pinned, onHover, onToggle, onClose }: FieldHelpProps) {
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // T007 (US2): while open, close on a pointerdown outside both the button
  // and the popover -- both live inside the wrapping <span>, so one
  // containment check against it covers either. Bubble phase, and this
  // handler never calls preventDefault/stopPropagation, so the modal
  // backdrop's own click-to-close listener still sees and handles the same
  // event when the tap/click lands outside this field entirely.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open, onClose]);

  // T009 (US3): a pinned explanation closes once focus leaves both the
  // button and the popover -- shared by the button's and the popover's own
  // onBlur below, since either can be the one losing focus (clicking inside
  // the popover moves focus there; tabbing away from it should still close).
  // An unpinned (hover-only) explanation is left alone here -- hover-out
  // already handles that case via onHover.
  function handleBlur(e: FocusEvent) {
    if (!pinned) return;
    const next = e.relatedTarget as Node | null;
    if (wrapperRef.current && next && wrapperRef.current.contains(next)) return;
    onClose();
  }

  // T009 (US3) fix round 1: Escape is handled on the wrapper, not just the
  // button, so it still works once focus has moved into the popover (e.g.
  // after clicking inside it to select text) -- a keydown there bubbles up
  // through this span either way. Closes the explanation, not the modal
  // (research R4, stopPropagation), and explicitly returns focus to the
  // button so a keyboard user isn't stranded on a popover that just
  // unmounted (a no-op when focus was already on the button).
  function handleKeyDown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      buttonRef.current?.focus();
    }
  }

  return (
    <span className="field-help" ref={wrapperRef} onKeyDown={handleKeyDown}>
      {field}
      <button
        ref={buttonRef}
        type="button"
        className="field-help-button"
        aria-label={`About ${field}`}
        aria-expanded={open}
        aria-controls={id}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') onHover(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') onHover(false);
        }}
        onClick={onToggle}
        onBlur={handleBlur}
      >
        ⓘ
      </button>
      {open && (
        <div id={id} className="field-help-popover" tabIndex={-1} onBlur={handleBlur}>
          {text}
        </div>
      )}
    </span>
  );
}
