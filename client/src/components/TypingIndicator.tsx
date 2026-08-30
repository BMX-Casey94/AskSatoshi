/** Shown from submit until the first token arrives. */

export function TypingIndicator() {
  return (
    <div className="typing" role="status" aria-live="polite">
      <span className="typing-label">Satoshi is typing</span>
      <span className="typing-dots" aria-hidden="true">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </span>
    </div>
  );
}
