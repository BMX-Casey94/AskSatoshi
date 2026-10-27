/**
 * Up to three suggested next questions under the latest finished answer.
 */

import '../answerActions.css';

interface Props {
  questions: string[];
  onAsk?: (question: string) => void;
}

export function FollowUps({ questions, onAsk }: Props) {
  const items = questions.map((question) => question.trim()).filter(Boolean).slice(0, 3);
  if (items.length === 0) return null;

  return (
    <div className="follow-ups" role="group" aria-label="Suggested follow-up questions">
      {items.map((question, index) => (
        <button
          key={`${index}-${question}`}
          type="button"
          className="follow-up-chip"
          onClick={() => onAsk?.(question)}
        >
          {question}
        </button>
      ))}
    </div>
  );
}
