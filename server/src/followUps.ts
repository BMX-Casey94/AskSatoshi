/**
 * Clickable follow-up questions, derived from the citations that grounded an answer.
 * Deterministic: no model call. At most three, each a question of at most 90 characters,
 * varied by source class, with duplicates, the user's own question, and living-candidate
 * names left out.
 */

export const MAX_FOLLOW_UPS = 3;
export const MAX_FOLLOW_UP_CHARS = 90;

export type FollowUpSourceClass = 'satoshi-primary' | 'spec' | 'later-commentary' | 'historical-record' | 'news' | 'directory';

export interface FollowUpSource {
  label: string;
  title?: string;
  sourceClass?: FollowUpSourceClass;
}

/**
 * Living people publicly discussed as Satoshi. A chip is a question the product
 * would ask in his voice, so it must not carry their names. Deceased correspondents
 * (Hal Finney, Dave Kleiman) are not in this list.
 */
const LIVING_CANDIDATE =
  /\b(?:craig(?:\s+s\.?|\s+steven)?\s+wright|nick\s+szabo|adam\s+back|dorian(?:\s+prentice)?(?:\s+satoshi)?\s+nakamoto)\b|\bcsw\b|\bc\.?\s*s\.?\s*w\b/i;

/** Titles that would only produce a vague chip. Compared after normalisation. */
const GENERIC_SUBJECTS = new Set([
  'bitcoin',
  'satoshi',
  'satoshi nakamoto',
  'untitled',
  'quoted remark',
  'quote',
  'post',
  'email',
  're',
]);

/**
 * Glue shared by every template and by ordinary questions. Overlap on these words
 * does not mean the chip is the question the user just asked.
 */
const GLUE = new Set([
  'what',
  'did',
  'does',
  'how',
  'why',
  'when',
  'where',
  'who',
  'whom',
  'satoshi',
  'say',
  'said',
  'says',
  'about',
  'the',
  'and',
  'for',
  'are',
  'was',
  'were',
  'work',
  'works',
  'specification',
  'later',
  'commentary',
  'historical',
  'record',
  'show',
  'shows',
  'else',
  'recorded',
  'from',
  'with',
  'that',
  'this',
  'have',
  'has',
  'into',
  'your',
  'you',
]);

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function contentTokens(text: string): string[] {
  return normalise(text)
    .split(' ')
    .filter((token) => token.length >= 3 && !GLUE.has(token));
}

function templateFor(sourceClass: FollowUpSource['sourceClass']): (subject: string) => string {
  switch (sourceClass) {
    case 'satoshi-primary':
      return (subject) => `What did Satoshi say about ${subject}?`;
    case 'spec':
      return (subject) => `What does the specification say about ${subject}?`;
    case 'later-commentary':
      return (subject) => `What does the later commentary say about ${subject}?`;
    case 'historical-record':
      return (subject) => `What does the historical record say about ${subject}?`;
    case 'news':
      return (subject) => `What has been reported about ${subject}?`;
    case 'directory':
      return (subject) => `What else is listed alongside ${subject}?`;
    default:
      return (subject) => `What else is recorded about ${subject}?`;
  }
}

function namesLivingCandidate(text: string): boolean {
  return LIVING_CANDIDATE.test(text);
}

/** Title when it is human-readable; otherwise a label that is not an internal locator. */
function citationSubject(source: FollowUpSource): string | undefined {
  const titled = source.title?.trim();
  const raw = titled ? titled : source.label;
  if (!raw || /:\/\//.test(raw)) return undefined;
  const cleaned = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/^(?:\s*(?:re|fwd|fw):\s*)+/i, '')
    .replace(/^\s*\[(?:patch|ann|bitcoin-dev|ot)\]\s*/i, '')
    .replace(/[?!.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 3) return undefined;
  const key = normalise(cleaned);
  if (key.length < 3 || GENERIC_SUBJECTS.has(key)) return undefined;
  if (namesLivingCandidate(cleaned) || namesLivingCandidate(key)) return undefined;
  return cleaned;
}

/** Shorten the subject on a word boundary so the finished question stays within 90 characters. */
function fitSubject(render: (subject: string) => string, subject: string): string | undefined {
  const full = render(subject);
  if (full.length <= MAX_FOLLOW_UP_CHARS && full.endsWith('?') && !namesLivingCandidate(full)) return full;
  const room = MAX_FOLLOW_UP_CHARS - render('').length;
  if (room < 8) return undefined;
  let cut = subject.slice(0, room).trimEnd();
  const space = cut.lastIndexOf(' ');
  if (space >= 8) cut = cut.slice(0, space).trimEnd();
  cut = cut.replace(/[\s,;:–—-]+$/u, '').trim();
  if (cut.length < 8) return undefined;
  const question = render(cut);
  if (question.length > MAX_FOLLOW_UP_CHARS || !question.endsWith('?')) return undefined;
  if (namesLivingCandidate(question)) return undefined;
  return question;
}

/**
 * True when the chip is the question the user just asked (or that question with the
 * template wrapped around the same subject). Topical adjacency is kept: a chip may
 * share a short token such as "SPV" with the question.
 */
function resembles(userQuestion: string, followUp: string, subject: string): boolean {
  const user = normalise(userQuestion);
  const chip = normalise(followUp);
  const topic = normalise(subject);
  if (!user || !chip) return false;
  if (user === chip || user === topic) return true;
  if (user.length >= 12 && chip.length >= 12 && (user.includes(chip) || chip.includes(user))) return true;
  if (topic.length >= 12 && user.length >= 12 && (user.includes(topic) || topic.includes(user))) return true;
  const userTokens = contentTokens(userQuestion);
  const chipTokens = contentTokens(followUp);
  if (userTokens.length === 0 || chipTokens.length === 0) return false;
  const userSet = new Set(userTokens);
  const overlap = chipTokens.filter((token) => userSet.has(token)).length;
  const denom = Math.max(userTokens.length, chipTokens.length);
  return overlap >= 2 && overlap / denom >= 0.8;
}

export function deriveFollowUps(sources: readonly FollowUpSource[], question: string): string[] {
  const seenSubjects = new Set<string>();
  const seenQuestions = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    if (out.length >= MAX_FOLLOW_UPS) break;
    const subject = citationSubject(source);
    if (!subject) continue;
    const subjectKey = normalise(subject);
    if (seenSubjects.has(subjectKey)) continue;
    seenSubjects.add(subjectKey);
    const questionText = fitSubject(templateFor(source.sourceClass), subject);
    if (!questionText) continue;
    if (resembles(question, questionText, subject)) continue;
    const questionKey = normalise(questionText);
    if (seenQuestions.has(questionKey)) continue;
    seenQuestions.add(questionKey);
    out.push(questionText);
  }
  return out;
}
