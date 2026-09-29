import { useEffect, useId, useRef } from 'react';

// Generic field-label + info-marker disclosure (issue #34). Deliberately has
// no import of any help-text map -- the caller (AdvancedGuestModal today,
// possibly other pages later, per specs/011-advanced-field-help/spec.md's
// "built so those pages can reuse it later" assumption) passes both the
// field name and its explanation text in as props, and owns the open/pinned
// state so at most one explanation is open at a time across a whole modal.
//
// tabIndex={-1} on the popover is deliberate: clicking inside the popover
// (to select text, say) focuses it, which is what lets the outside-pointerdown
// listener below (T007) treat "moved into the popover" as staying open rather
// than closing.

interface FieldHelpProps {
  field: string;
  text: string;
  open: boolean;
  pinned: boolean;
  onHover(open: boolean): void;
  onToggle(): void;
  onClose(): void;
}

export function FieldHelp({ field, text, open, onHover, onToggle, onClose }: FieldHelpProps) {
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);

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

  return (
    <span className="field-help" ref={wrapperRef}>
      {field}
      <button
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
      >
        ⓘ
      </button>
      {open && (
        <div id={id} className="field-help-popover" tabIndex={-1}>
          {text}
        </div>
      )}
    </span>
  );
}
