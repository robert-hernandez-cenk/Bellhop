import { useState } from 'react';
import type { HostEntry, GuestEntry } from '../api/types';
import { MID_MIN, MID_MAX, midCollisionMessage } from '../lib/mid';

interface Props {
  value: string;
  onChange: (value: string) => void;
  host: HostEntry | undefined;
  // Visible guests, used only to name the holder of an occupied MID.
  guests: GuestEntry[];
  // The host's occupied MIDs from the full inventory (issue #54), so a MID
  // held by a guest this user can't see still warns; undefined while unknown.
  usedMids: number[] | undefined;
}

export function MidInput({ value, onChange, host, guests, usedMids }: Props) {
  const [collision, setCollision] = useState<string | null>(null);

  return (
    <>
      <input
        className="field-input"
        type="number"
        min={MID_MIN}
        max={MID_MAX}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCollision(null);
        }}
        onBlur={() => setCollision(midCollisionMessage(host, value, usedMids, guests))}
      />
      {collision && <div className="warning-banner">{collision}</div>}
    </>
  );
}
