/** Four questions from the curated pool, plus a control that asks one at random. */

import { useEffect, useRef, useState } from 'react';
import {
  SUGGESTION_POOL,
  browserSuggestionStores,
  commitSuggestionDraw,
  pageLoadEntropy,
  planSuggestionDraw,
  surpriseQuestion,
  type SuggestionPlan,
} from '../lib/suggestionPool';

interface Props {
  onPick: (question: string) => void;
  disabled: boolean;
}

export function Suggestions({ onPick, disabled }: Props) {
  const planRef = useRef<SuggestionPlan | null>(null);
  const [questions] = useState(() => {
    const plan = planSuggestionDraw(SUGGESTION_POOL, 4, browserSuggestionStores(), pageLoadEntropy());
    planRef.current = plan;
    return plan.questions;
  });

  useEffect(() => {
    const plan = planRef.current;
    if (!plan) return;
    commitSuggestionDraw(browserSuggestionStores(), plan);
  }, []);

  const handleSurprise = () => {
    const question = surpriseQuestion(SUGGESTION_POOL, questions, Math.random);
    if (question) onPick(question);
  };

  return (
    <div className="suggestions" role="group" aria-label="Suggested questions">
      {questions.map((question) => (
        <button
          key={question}
          type="button"
          className="suggestion-pill"
          onClick={() => onPick(question)}
          disabled={disabled}
        >
          {question}
        </button>
      ))}
      <button
        type="button"
        className="suggestion-pill suggestion-pill--surprise"
        onClick={handleSurprise}
        disabled={disabled}
      >
        Surprise me
      </button>
    </div>
  );
}
