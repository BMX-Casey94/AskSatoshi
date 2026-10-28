/**
 * Provenance pill for a finished answer.
 *
 * Classified citations decide the wording. The retrieval mode is used only when
 * no citation carries a source class. "Satoshi's own words" appears only when a
 * satoshi-primary citation is present.
 *
 * Kinds are listed from strongest evidence to weakest: Satoshi's 2008–2011
 * writings, the protocol specification, the later essays, the curated
 * historical record, CoinGeek news, then the BSV Radar app directory. A mix
 * uses short names so the line fits a narrow screen;
 * `title` is the full sentence shown in the tooltip.
 */

import type { GroundingMode, SourceClass } from '../types';

/** Mixed labels stay within this so they fit one line on a narrow phone. */
export const PROVENANCE_LABEL_LIMIT = 52;

const CLASS_ORDER = [
  'satoshi-primary',
  'spec',
  'later-commentary',
  'historical-record',
  'news',
  'directory',
] as const satisfies readonly SourceClass[];

const CLASS_SET: ReadonlySet<string> = new Set(CLASS_ORDER);

export type ProvenanceKind = SourceClass | 'mixed' | 'general' | Exclude<GroundingMode, 'none'>;

export interface Provenance {
  /** Visible pill text. Mixed answers are shortened to one narrow line. */
  label: string;
  /** One factual sentence for the tooltip. */
  title: string;
  kind: ProvenanceKind;
}

export interface ProvenanceInput {
  citations?: readonly { sourceClass?: string | null }[] | null;
  mode?: string | null;
  /** Retrieval found nothing; the answer came from the model's general knowledge. */
  general?: boolean | null;
}

const GENERAL_PROVENANCE: Provenance = {
  kind: 'general',
  label: 'General knowledge, not from the record',
  title:
    "Nothing in the record matched this question, so this answer comes from the language model's general knowledge. Treat it as unverified.",
};

const SINGLE_LABEL: Record<SourceClass, string> = {
  'satoshi-primary': "Answered from Satoshi's own words (2008–2011)",
  spec: 'Answered from the protocol specification (BRCs, Script, SDK)',
  'later-commentary': 'Answered from the later essays and commentary',
  'historical-record': 'Answered from the curated historical record',
  news: 'Answered from CoinGeek news reporting (dated)',
  directory: 'Answered from the app directory',
};

/** Full kind names, in the same order as CLASS_ORDER. No item contains "and". */
const FULL_NAME: Record<SourceClass, string> = {
  'satoshi-primary': "Satoshi's own words (2008–2011)",
  spec: 'the protocol specification',
  'later-commentary': 'the later essays',
  'historical-record': 'the curated historical record',
  news: 'CoinGeek news reporting',
  directory: 'the BSV Radar app directory',
};

/**
 * Compact kind names for the visible mix line. Chosen so any two fit inside
 * PROVENANCE_LABEL_LIMIT; the tooltip expands them.
 */
const SHORT_NAME: Record<SourceClass, string> = {
  'satoshi-primary': 'Satoshi',
  spec: 'the spec',
  'later-commentary': 'essays',
  'historical-record': 'history',
  news: 'news',
  directory: 'directory',
};

const FALLBACK: Record<Exclude<GroundingMode, 'none'>, Provenance> = {
  corpus: {
    kind: 'corpus',
    label: 'Answered from the 2008–2011 corpus',
    title: 'Retrieved from the 2008–2011 writing corpus.',
  },
  mcp: {
    kind: 'mcp',
    label: 'Answered from the indexed record',
    title: 'Retrieved from the indexed record.',
  },
  reference: {
    kind: 'reference',
    label: 'Answered from the curated historical record',
    title: 'Retrieved from the curated historical record.',
  },
};

function isSourceClass(value: unknown): value is SourceClass {
  return typeof value === 'string' && CLASS_SET.has(value);
}

function isFallbackMode(value: string): value is Exclude<GroundingMode, 'none'> {
  return value === 'corpus' || value === 'mcp' || value === 'reference';
}

function presentCitations(
  citations: ProvenanceInput['citations'],
): readonly { sourceClass?: string | null }[] {
  if (!Array.isArray(citations)) return [];
  return citations.filter((item): item is { sourceClass?: string | null } => !!item && typeof item === 'object');
}

function classesInWeightOrder(citations: readonly { sourceClass?: string | null }[]): SourceClass[] {
  const found = new Set<SourceClass>();
  for (const citation of citations) {
    if (isSourceClass(citation.sourceClass)) found.add(citation.sourceClass);
  }
  return CLASS_ORDER.filter((sourceClass) => found.has(sourceClass));
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  const last = items[items.length - 1] ?? '';
  if (items.length === 2) return `${items[0] ?? ''} and ${last}`;
  return `${items.slice(0, -1).join(', ')} and ${last}`;
}

function singleTitle(sourceClass: SourceClass, someUnclassified: boolean): string {
  const who = someUnclassified ? 'The citations with a known kind of source are' : 'The cited sources are';
  switch (sourceClass) {
    case 'satoshi-primary':
      return `${who} Satoshi Nakamoto's own writings from 2008 to 2011.`;
    case 'spec':
      return `${who} from the protocol specification (BRCs, Script, SDK).`;
    case 'later-commentary':
      return `${who} the later essays and commentary.`;
    case 'historical-record':
      return `${who} from the curated historical record.`;
    case 'news':
      return `${who} CoinGeek news reporting, and the articles are dated.`;
    case 'directory':
      return `${who} the BSV Radar app directory, a partial community catalogue and not an endorsement.`;
    default: {
      const unexpected: never = sourceClass;
      return unexpected;
    }
  }
}

/** Shorten a mix at a kind boundary so the visible line stays within the limit. */
function mixedLabel(classes: readonly SourceClass[]): string {
  const stem = `Drawn from ${classes.length} kinds of source`;
  const names = classes.map((sourceClass) => SHORT_NAME[sourceClass]);
  const full = `${stem}: ${formatList(names)}`;
  if (full.length <= PROVENANCE_LABEL_LIMIT) return full;
  for (let take = names.length - 1; take >= 1; take -= 1) {
    const partial = `${stem}: ${formatList(names.slice(0, take))}…`;
    if (partial.length <= PROVENANCE_LABEL_LIMIT) return partial;
  }
  const stemOnly = `${stem}…`;
  if (stemOnly.length <= PROVENANCE_LABEL_LIMIT) return stemOnly;
  const budget = Math.max(0, PROVENANCE_LABEL_LIMIT - 1);
  return `${stem.slice(0, budget).trimEnd()}…`;
}

function mixedTitle(classes: readonly SourceClass[]): string {
  const names = classes.map((sourceClass) => FULL_NAME[sourceClass]);
  return `Drawn from ${classes.length} kinds of source, in order of evidentiary weight: ${formatList(names)}.`;
}

export function answerProvenance(input: ProvenanceInput): Provenance | null {
  if (input.general === true) return GENERAL_PROVENANCE;
  const citations = presentCitations(input.citations);
  const classes = classesInWeightOrder(citations);
  if (classes.length === 1) {
    const sourceClass = classes[0];
    if (!sourceClass) return null;
    const someUnclassified = citations.some((citation) => !isSourceClass(citation.sourceClass));
    return {
      kind: sourceClass,
      label: SINGLE_LABEL[sourceClass],
      title: singleTitle(sourceClass, someUnclassified),
    };
  }
  if (classes.length > 1) {
    return {
      kind: 'mixed',
      label: mixedLabel(classes),
      title: mixedTitle(classes),
    };
  }
  const mode = typeof input.mode === 'string' ? input.mode : '';
  if (!isFallbackMode(mode)) return null;
  return FALLBACK[mode];
}
