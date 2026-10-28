/**
 * Adds the pinned BSV Radar catalogue to a grounding when, and only when, the user's
 * own question is asking what exists in the directory.
 *
 * The classifier runs on the ORIGINAL question, never the rewritten retrieval query:
 * a rewrite can add build vocabulary that would hide a genuine catalogue question,
 * or the other way round.
 */

import {
  CATALOGUE_CAVEAT,
  DIRECTORY_EVIDENCE_HEADER,
  DIRECTORY_PROVENANCE_NOTE,
  directoryCitations,
  looksLikeAppDirectoryQuestion,
  renderDirectoryEvidence,
  type DirectorySource,
} from './bsvRadar.js';
import type { Grounding } from './orchestrate.js';

export interface DirectoryGroundingResult {
  grounding: Grounding;
  /** True when catalogue evidence was attached. Such answers go stale and are never cached. */
  usedDirectory: boolean;
}

export function withDirectoryEvidence(
  grounding: Grounding,
  question: string,
  variants: readonly string[] | undefined,
  directory: DirectorySource | null,
): DirectoryGroundingResult {
  if (!directory || !looksLikeAppDirectoryQuestion(question)) return { grounding, usedDirectory: false };

  const queries = [...new Set([question, ...(variants ?? [])].map((q) => q.trim()).filter(Boolean))].slice(0, 3);
  const hits = directory.searchAll(queries);
  if (hits.length === 0) return { grounding, usedDirectory: false };

  const body = renderDirectoryEvidence(hits, directory.meta, directory.now());
  const block = `${DIRECTORY_EVIDENCE_HEADER}\n${CATALOGUE_CAVEAT}\n${DIRECTORY_PROVENANCE_NOTE}\n\n${body}`;
  // The catalogue leads. Evidence is trimmed from the tail on free tiers, and the model
  // weighs the head most, so a listing question must not bury its answer behind essays.
  const evidenceText = grounding.evidenceText ? `${block}\n\n${grounding.evidenceText}` : block;
  return {
    usedDirectory: true,
    grounding: {
      ...grounding,
      // A miss that the catalogue can answer is no longer a miss. 'reference' tells the
      // model the evidence is a third-party list to weigh and attribute, not Satoshi's own writing.
      mode: grounding.mode === 'none' ? 'reference' : grounding.mode,
      evidenceText,
      // A lead angle tells the model not to survey sources; here the list IS the answer.
      leadAngle: undefined,
      citations: [...grounding.citations, ...directoryCitations(hits)],
    },
  };
}
