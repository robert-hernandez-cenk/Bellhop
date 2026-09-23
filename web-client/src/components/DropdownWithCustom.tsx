import { useEffect, useState } from 'react';

interface Props {
  options: string[];
  value: string;
  onChange: (value: string) => void;
}

const CUSTOM = '__custom__';

export function DropdownWithCustom({ options, value, onChange }: Props) {
  const [customMode, setCustomMode] = useState(!options.includes(value) && value !== '');

  // A value can also arrive from outside (e.g. install-app prefilling Cores/
  // Memory/Disk from a script's own defaults) rather than through this
  // component's own onChange below — if that value isn't one of the listed
  // options, switch into custom mode so it's still shown instead of silently
  // mismatching the select.
  useEffect(() => {
    if (!options.includes(value) && value !== '') setCustomMode(true);
  }, [value, options]);

  if (customMode) {
    return (
      <input
        className="field-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (value === '') setCustomMode(false);
        }}
      />
    );
  }

  return (
    <select
      className="field-input"
      value={value}
      onChange={(e) => {
        if (e.target.value === CUSTOM) {
          setCustomMode(true);
          onChange('');
        } else {
          onChange(e.target.value);
        }
      }}
    >
      <option value="" disabled>
        Select…
      </option>
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
      <option value={CUSTOM}>Custom value…</option>
    </select>
  );
}
