/**
 * Shown from submit until the first token arrives. Cycles through honest status
 * phases (retrieving sources → reading → typing) so the wait feels transparent
 * rather than a bare spinner.
 */

import { useEffect, useState } from 'react';

const PHASES = ['Consulting the record', 'Reading the sources', 'Satoshi is typing'] as const;
const PHASE_MS = 2_200;

export function TypingIndicator() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => {
      setPhase((p) => Math.min(p + 1, PHASES.length - 1));
    }, PHASE_MS);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="typing" role="status" aria-live="polite">
      <span className="typing-label">{PHASES[phase]}</span>
      <span className="typing-dots" aria-hidden="true">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </span>
    </div>
  );
}
