/** The four suggested-question pills under the composer on the landing page. */

export const SUGGESTED_QUESTIONS = [
  'Was the block size always meant to be small?',
  'What is SPV (Simplified Payment Verification)?',
  'Why do people insist on running home nodes?',
  'Was Bitcoin hijacked from its original vision?',
];

interface Props {
  onPick: (question: string) => void;
  disabled: boolean;
}

export function Suggestions({ onPick, disabled }: Props) {
  return (
    <div className="suggestions">
      {SUGGESTED_QUESTIONS.map((q) => (
        <button
          key={q}
          type="button"
          className="suggestion-pill"
          onClick={() => onPick(q)}
          disabled={disabled}
        >
          {q}
        </button>
      ))}
    </div>
  );
}
