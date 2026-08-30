/**
 * Shown from submit until the first token arrives. Cycles through honest status
 * phases (retrieving sources → reading → typing) so the wait feels transparent
 * rather than a bare spinner. When the MCP child is still waking up, the parent
 * pins the label to a warm-up line instead.
 */

import { useEffect, useState } from 'react';

const PHASES = ['Consulting the record', 'Reading the sources', 'Satoshi is typing'] as const;
const PHASE_MS = 2_200;

interface Props {
  phase: 'warming' | 'typing';
}

export function TypingIndicator({ phase }: Props) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (phase === 'warming') return;
    const t = window.setInterval(() => {
      setStep((p) => Math.min(p + 1, PHASES.length - 1));
    }, PHASE_MS);
    return () => window.clearInterval(t);
  }, [phase]);

  const label = phase === 'warming' ? 'Just grabbing my notepad' : PHASES[step];

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
