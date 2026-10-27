/**
 * Adds pinned CoinGeek news reporting to a grounding when, and only when, the user's
 * own question is about events rather than protocol mechanics or identity.
 *
 * The classifier runs on the ORIGINAL question, never the rewritten retrieval query:
 * the rewrite can add protocol vocabulary that would hide a genuine news question.
 */

import {
  NEWS_PROVENANCE_NOTE,
  looksLikeNewsQuestion,
  newsCitations,
  renderNewsEvidence,
  type CoinGeekNews,
} from './coingeekNews.js';
import type { Grounding } from './orchestrate.js';

export interface NewsGroundingResult {
  grounding: Grounding;
  /** True when news evidence was attached. Such answers are time-sensitive and are never cached. */
  usedNews: boolean;
}

export function withNewsEvidence(
  grounding: Grounding,
  question: string,
  variants: readonly string[] | undefined,
  news: Pick<CoinGeekNews, 'searchAll'> | null,
): NewsGroundingResult {
  if (!news || !looksLikeNewsQuestion(question)) return { grounding, usedNews: false };

  const queries = [...new Set([question, ...(variants ?? [])].map((q) => q.trim()).filter(Boolean))].slice(0, 3);
  const hits = news.searchAll(queries);
  if (hits.length === 0) return { grounding, usedNews: false };

  const block = `NEWS REPORTING (time-sensitive, third party):\n${NEWS_PROVENANCE_NOTE}\n\n${renderNewsEvidence(hits)}`;
  const evidenceText = grounding.evidenceText ? `${grounding.evidenceText}\n\n${block}` : block;
  return {
    usedNews: true,
    grounding: {
      ...grounding,
      // A miss that news can answer is no longer a miss. 'reference' tells the model the
      // evidence is third-party material to weigh and attribute, not Satoshi's own writing.
      mode: grounding.mode === 'none' ? 'reference' : grounding.mode,
      evidenceText,
      citations: [...grounding.citations, ...newsCitations(hits)],
    },
  };
}
