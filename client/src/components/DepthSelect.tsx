/**
 * Compact answer-depth control. A native select so it stays keyboard operable
 * and picks up the page colour scheme.
 */

import { useId } from 'react';
import type { Depth } from '../types';

const OPTIONS: readonly { value: Depth; label: string; description: string }[] = [
  { value: 'default', label: 'Standard', description: 'A direct answer, grounded in the sources.' },
  { value: 'beginner', label: 'Beginner', description: 'Plain language, with the jargon unpacked.' },
  { value: 'developer', label: 'Developer', description: 'Implementation detail for people building on Bitcoin SV.' },
  { value: 'historian', label: 'Historian', description: 'Tied to the dated writings and what they actually said.' },
];

interface Props {
  value: Depth;
  onChange: (depth: Depth) => void;
}

export function DepthSelect({ value, onChange }: Props) {
  const selectId = useId();
  const hintId = useId();
  const current = OPTIONS.find((option) => option.value === value) ?? OPTIONS[0];

  return (
    <div className="depth">
      <label className="depth-label" htmlFor={selectId}>
        Answer depth
      </label>
      <select
        id={selectId}
        className="depth-select"
        value={value}
        aria-describedby={hintId}
        onChange={(event) => {
          const next = OPTIONS.find((option) => option.value === event.target.value);
          if (next) onChange(next.value);
        }}
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {current && (
        <span id={hintId} className="depth-hint">
          {current.description}
        </span>
      )}
    </div>
  );
}
