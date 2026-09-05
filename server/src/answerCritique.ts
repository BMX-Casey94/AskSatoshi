/**
 * Answer critique: an adversarial reviewer pass that checks a drafted answer BEFORE
 * it is shown to the user. Three things can be wrong with an answer in this tool:
 * it can invent facts the evidence does not support (factual), it can recommend
 * technology the persona must never prescribe (forbidden), or it can pick a weaker
 * primitive than the evidence assembles (suboptimal).
 *
 * Everything here is pure and fail-open, mirroring queryUnderstanding.ts: the module
 * never calls a provider — the caller owns the runChain invocation — and a malformed
 * or unactionable reviewer reply is discarded (parse returns undefined) so the caller
 * simply ships the original answer. A deterministic lint (forbiddenTechLint) runs
 * alongside as an observability signal that needs no model at all.
 */

export type CritiqueKind = 'factual' | 'forbidden' | 'suboptimal';

export interface Critique {
  verdict: 'pass' | 'revise';
  kind?: CritiqueKind;
  issues: string[];
  correction?: string;
}

const CRITIQUE_KINDS: readonly CritiqueKind[] = ['factual', 'forbidden', 'suboptimal'];

const MAX_EVIDENCE_CHARS = 6_000;
const MAX_ANSWER_CHARS = 8_000;
const MAX_ISSUES = 5;
const MAX_ISSUE_CHARS = 500;
const MAX_CORRECTION_CHARS = 2_000;

const ANSWER_CRITIQUE_SYSTEM = [
  "You are the adversarial reviewer of a Satoshi-persona Bitcoin knowledge tool grounded in a pinned corpus: Satoshi Nakamoto's 2008–2011 posts and emails, the later essay corpus of Bitcoin's designer, and the BSV protocol record (BRCs, Script opcodes, SDK and academy docs).",
  'You are given the user\'s Question, the EVIDENCE the answer was grounded in, and the draft ANSWER. Check the answer against the evidence, in this order:',
  '1. Factual fidelity: every load-bearing claim in the answer must trace to the EVIDENCE block. Invented facts, invented acronym expansions, or claims absent from the evidence are "factual" issues.',
  '2. Forbidden technology: the answer must NEVER recommend or prescribe Taproot, SegWit, Lightning, BIP-141, BIP-341, BIP-119, sidechains, rollups, drivechains, or claim a fixed ~4–7 TPS base-layer ceiling. These MAY be mentioned only as critique of a different chain. An affirmative recommendation is a "forbidden" issue.',
  '3. Optimality: when the EVIDENCE contains an "IMPLEMENTATION OPTIONS" section listing candidate primitives, the answer must name ONE firm recommendation and address the alternatives. A correct-but-weaker choice, or a failure to address the assembled alternatives, is a "suboptimal" issue. You may ONLY propose an alternative that appears in the evidence — never from your own knowledge.',
  '   Primitive hierarchy: a compiler frontend or SDK (Rúnar, sCrypt, @bsv/sdk) is an implementation OF a primitive, not a rival to it. When the EVIDENCE contains a pinned decision table, its default wins unless the user\'s question states a constraint that outgrows it (e.g. timed releases, staged payouts, on-chain signature collection). Do not flag an answer for choosing the native opcode over a compiler when the question asks for a simple m-of-n, payment, or data anchor.',
  '4. Altitude guard: if the user asked how something works (an explanation), NOT what to build, do NOT flag the answer for failing to recommend something. Only build/recommendation answers can be "suboptimal".',
  'Reply with ONLY a single-line JSON object, no prose, no markdown fences:',
  '{"verdict":"pass"|"revise","kind":"factual"|"forbidden"|"suboptimal","issues":["..."],"correction":"..."}',
  '- "pass" means the answer is accurate, compliant, and optimal given the evidence.',
  '- "revise" requires a non-empty issues array AND a correction string describing precisely what to change.',
].join('\n');

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildCritiqueRequest(
  question: string,
  evidenceText: string,
  answer: string,
): { system: string; userContent: string } {
  const userContent = [
    'Question:',
    question,
    '',
    'EVIDENCE:',
    truncate(evidenceText, MAX_EVIDENCE_CHARS),
    '',
    'ANSWER:',
    truncate(answer, MAX_ANSWER_CHARS),
  ].join('\n');
  return { system: ANSWER_CRITIQUE_SYSTEM, userContent };
}

/**
 * Parse the reviewer's reply into a Critique. Returns undefined on any deviation —
 * unparseable JSON, an unknown verdict or kind, or a "revise" verdict without
 * actionable content — so the caller fails open and ships the original answer.
 */
export function parseCritique(reply: string): Critique | undefined {
  const match = /\{[\s\S]*\}/.exec(reply);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    // Models sometimes emit raw newlines/tabs inside JSON strings, which strict
    // JSON.parse rejects. They are insignificant between tokens and safely become
    // spaces inside string values.
    parsed = JSON.parse(match[0].replace(/[\r\n\t]+/g, ' '));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;

  if (obj.verdict !== 'pass' && obj.verdict !== 'revise') return undefined;
  const verdict = obj.verdict;

  let kind: CritiqueKind | undefined;
  if (obj.kind !== undefined) {
    if (typeof obj.kind !== 'string' || !CRITIQUE_KINDS.includes(obj.kind as CritiqueKind)) {
      return undefined;
    }
    kind = obj.kind as CritiqueKind;
  }

  if (!Array.isArray(obj.issues)) return undefined;
  const issues: string[] = [];
  for (const raw of obj.issues) {
    const clean = (typeof raw === 'string' ? raw : String(raw)).replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    issues.push(clean.length > MAX_ISSUE_CHARS ? clean.slice(0, MAX_ISSUE_CHARS) : clean);
    if (issues.length >= MAX_ISSUES) break;
  }

  let correction: string | undefined;
  if (obj.correction !== undefined) {
    if (typeof obj.correction !== 'string') return undefined;
    const clean = obj.correction.replace(/\s+/g, ' ').trim();
    correction = clean.length > MAX_CORRECTION_CHARS ? clean.slice(0, MAX_CORRECTION_CHARS) : clean;
  }

  // A revise without actionable content is useless — fail open.
  if (verdict === 'revise' && (issues.length === 0 || !correction)) return undefined;

  return { verdict, kind, issues, correction };
}

const MAX_REVISION_ANSWER_CHARS = 8_000;

/**
 * Build the revision request's user content: the question, the draft answer, and the
 * reviewer's findings, with strict rewrite instructions. The caller supplies the SAME
 * system prompt the answer was generated with (persona + evidence) — the module only
 * wraps the correction brief. Output is instructed to be the bare revised answer so it
 * can replace the streamed text wholesale.
 */
export function buildRevisionRequest(
  question: string,
  answer: string,
  critique: Critique,
): { userContent: string } {
  const findings = critique.issues.map((i) => `- ${i}`).join('\n');
  const userContent = [
    'Question:',
    question,
    '',
    'DRAFT ANSWER (already streamed to the user; you are refining it):',
    truncate(answer, MAX_REVISION_ANSWER_CHARS),
    '',
    'REVIEWER FINDINGS — apply every one:',
    findings,
    ...(critique.correction ? [`Required correction: ${critique.correction}`] : []),
    '',
    'Rewrite the answer applying the corrections. Keep the same voice, structure and approximate length. Preserve every [n] citation marker that still supports its claim, and do not introduce new markers or any fact not present in the EVIDENCE. Output ONLY the revised answer text.',
  ].join('\n');
  return { userContent };
}

/**
 * Forbidden-technology detector. Canonical label first, then every spelling that
 * should map to it. All patterns use word boundaries so substrings inside unrelated
 * words ("highlighting") never match. This is an observability signal, so recall
 * matters more than precision.
 */
const FORBIDDEN_TERMS: [string, RegExp][] = [
  ['Taproot', /\btaproot\b/i],
  ['SegWit', /\bsegwit\b|\bsegregated\s+witness\b/i],
  ['Lightning', /\blightning\b/i],
  ['BIP-141', /\bBIP-?141\b/i],
  ['BIP-341', /\bBIP-?341\b/i],
  ['BIP-119', /\bBIP-?119\b/i],
  ['Sidechain', /\bside[\s-]?chains?\b/i],
  ['Rollup', /\brollups?\b/i],
  ['Drivechain', /\bdrive[\s-]?chains?\b/i],
];

/** Returns the deduplicated canonical labels of every forbidden term in the answer. */
export function forbiddenTechLint(answer: string): string[] {
  const found: string[] = [];
  for (const [label, pattern] of FORBIDDEN_TERMS) {
    if (pattern.test(answer)) found.push(label);
  }
  return found;
}
