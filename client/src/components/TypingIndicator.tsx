/**
 * Shown from submit until the settled answer arrives. Cycles through honest status
 * phases (retrieving sources → reading → drafting) so the wait feels transparent
 * rather than a bare spinner. Two pinned states interrupt the cycle: the MCP child
 * waking up, and the closed-door review pass that runs before the answer is shown.
 */

import { useEffect, useState } from 'react';

const PHASES = ['Consulting the record', 'Reading the sources', 'Drafting the answer'] as const;
const PHASE_MS = 2_200;

interface Props {
  phase: 'warming' | 'typing' | 'reviewing';
}

export function TypingIndicator({ phase }: Props) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (phase !== 'typing') return;
    const t = window.setInterval(() => {
      setStep((p) => Math.min(p + 1, PHASES.length - 1));
    }, PHASE_MS);
    return () => window.clearInterval(t);
  }, [phase]);

  const label =
    phase === 'warming'
      ? 'Just grabbing my notepad'
      : phase === 'reviewing'
        ? 'Checking the answer against the record'
        : PHASES[step];

  return (
    <div className="typing" role="status" aria-live="polite">
      <span className="typing-label">{label}</span>
      <span className="typing-dots" aria-hidden="true">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </span>
    </div>
  );
}
