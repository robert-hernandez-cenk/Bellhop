import { useState } from 'react';
import type { HostEntry, GuestEntry } from '../api/types';
import { MID_MIN, MID_MAX, vmidForMid } from '../lib/mid';

interface Props {
  value: string;
  onChange: (value: string) => void;
  host: HostEntry | undefined;
  guests: GuestEntry[];
}

export function MidInput({ value, onChange, host, guests }: Props) {
  const [collision, setCollision] = useState<GuestEntry | null>(null);

  const checkCollision = () => {
    const vmid = vmidForMid(host, Number(value));
    if (vmid === null) {
      setCollision(null);
      return;
    }
    setCollision(guests.find((g) => g.host === host!.name && g.vmid === vmid) ?? null);
  };

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
        onBlur={checkCollision}
      />
      {collision && (
        <div className="warning-banner">
          MID {value} is already used by {collision.name} (vmid {collision.vmid}) on {host!.name}.
        </div>
      )}
    </>
  );
}
