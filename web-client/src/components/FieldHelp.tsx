import { useId } from 'react';

// Generic field-label + info-marker disclosure (issue #34). Deliberately has
// no import of any help-text map -- the caller (AdvancedGuestModal today,
// possibly other pages later, per specs/011-advanced-field-help/spec.md's
// "built so those pages can reuse it later" assumption) passes both the
// field name and its explanation text in as props, and owns the open/pinned
// state so at most one explanation is open at a time across a whole modal.
//
// tabIndex={-1} on the popover is deliberate ahead of a later task (US2)
// that adds a document pointerdown listener closing the popover on an
// outside click/tap -- a click landing inside the popover (to select text,
// say) needs the popover itself to be a legitimate focus/event target
// (relatedTarget) for that later blur-close rule to distinguish "moved into
// the popover" from "moved elsewhere".

interface FieldHelpProps {
  field: string;
  text: string;
  open: boolean;
  pinned: boolean;
  onHover(open: boolean): void;
  onToggle(): void;
  onClose(): void;
}

export function FieldHelp({ field, text, open, onHover, onToggle }: FieldHelpProps) {
  const id = useId();

  return (
    <span className="field-help">
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
