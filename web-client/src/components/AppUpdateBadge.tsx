import { useState } from 'react';
import { FieldHelp } from './FieldHelp';
import { appUpdateView } from '../lib/app-update-display';
import type { AppUpdateResult } from '../api/types';

interface Props {
  result: AppUpdateResult | undefined;
}

// toLocaleString is the one DOM/Intl dependency -- kept out of
// app-update-display.ts (framework-free, clock-free) and injected here
// instead, same separation as the rest of this file's FieldHelp wiring.
function formatCheckedTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

// A prominent "Update available" badge, or a quiet note for every other
// visible outcome (research R11) -- `unsupported`, or no saved result at
// all, renders nothing. The checked time/failure reason sits behind a
// tap/click disclosure (FieldHelp, issue #34's pattern) rather than a
// hover-only `title`, since `title` never shows on touch. Open/pinned state
// is local to this one badge -- unlike AdvancedGuestModal's multi-field
// coordination, there is only ever one field here to toggle.
//
// placement="anchored" (issue #75): the badge sits in a card with no
// positioned ancestor, so the row-style explanation the Advanced modal uses
// laid out against <body> -- full width, below every card -- and scrolled
// the page to reach it. Anchored, it opens beside the ⓘ instead, sized to
// its text, and the page never moves.
export function AppUpdateBadge({ result }: Props) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);

  if (!result) return null;
  const view = appUpdateView(result, formatCheckedTime);
  if (!view) return null;

  return (
    <span className={`app-update-badge app-update-badge-${view.tone}`}>
      <FieldHelp
        field={view.text}
        text={view.details}
        open={open}
        pinned={pinned}
        onHover={(hoverOpen) => {
          if (pinned) return;
          setOpen(hoverOpen);
        }}
        onToggle={() => {
          if (pinned) {
            setOpen(false);
            setPinned(false);
          } else {
            setOpen(true);
            setPinned(true);
          }
        }}
        placement="anchored"
        onClose={() => {
          setOpen(false);
          setPinned(false);
        }}
      />
    </span>
  );
}
