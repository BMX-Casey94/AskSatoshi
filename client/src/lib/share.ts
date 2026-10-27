/**
 * Plain-text sharing helpers. Clipboard, tweet text and reference lists are built
 * here so the UI never has to assemble them ad hoc, and so they can be tested
 * without a browser. Nothing in this module builds a link to a stored chat —
 * threads live only on the device.
 */

export const TWEET_TEXT_LIMIT = 240;
export const COPIED_NOTICE_MS = 1600;

const UK_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** A citation reduced to the fields a copied reference list needs. */
export interface ShareCitation {
  label: string;
  title?: string;
  url?: string;
  date?: string;
}

interface Ymd {
  year: number;
  month: number;
  day: number;
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * Calendar day used for display and the activity link. A bare YYYY-MM-DD is that
 * day; any other parseable ISO string uses its UTC date, matching the citation
 * panel's previous formatting.
 */
export function citationYmd(iso: string): Ymd | null {
  const trimmed = iso.trim();
  if (!trimmed) return null;
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dayOnly) {
    const year = Number(dayOnly[1]);
    const month = Number(dayOnly[2]);
    const day = Number(dayOnly[3]);
    if (!isValidYmd(year, month, day)) return null;
    return { year, month, day };
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getUTCFullYear();
  const month = parsed.getUTCMonth() + 1;
  const day = parsed.getUTCDate();
  if (!isValidYmd(year, month, day)) return null;
  return { year, month, day };
}

/** UK long date, e.g. 31 October 2008. Null when the input is not a real date. */
export function formatUkDate(iso: string): string | null {
  const ymd = citationYmd(iso);
  if (!ymd) return null;
  const monthName = UK_MONTHS[ymd.month - 1];
  if (!monthName) return null;
  return `${ymd.day} ${monthName} ${ymd.year}`;
}

/** Activity page. Adds ?date=YYYY-MM-DD when the citation date is a real day. */
export function timelineHref(date?: string): string {
  const ymd = date ? citationYmd(date) : null;
  if (!ymd) return '/satoshi-activity';
  const month = String(ymd.month).padStart(2, '0');
  const day = String(ymd.day).padStart(2, '0');
  return `/satoshi-activity?date=${encodeURIComponent(`${ymd.year}-${month}-${day}`)}`;
}

function tidyProse(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripCitationMarkers(text: string): string {
  return text
    .replace(/[ \t]*\[(?:\^)?\d{1,3}(?:[ \t]*,[ \t]*\d{1,3})*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1');
}

function inlineMarkdown(line: string): string {
  const codes: string[] = [];
  let text = line.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(code);
    return `\u0000IC${codes.length - 1}\u0000`;
  });
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, '$1');
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1$2');
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1$2');
  text = text.replace(/~~(.+?)~~/g, '$1');
  text = stripCitationMarkers(text);
  text = text.replace(/\u0000IC(\d+)\u0000/g, (_match, index: string) => codes[Number(index)] ?? '');
  return text;
}

/**
 * Markdown to plain text for the clipboard: paragraphs and list items stay on
 * their own lines, emphasis and links become words, and [n] citation markers
 * are dropped. Fenced code is kept as text without the fence.
 */
export function markdownToPlainText(markdown: string): string {
  const codeBlocks: string[] = [];
  const source = markdown.replace(/\r\n/g, '\n').replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, code: string) => {
    codeBlocks.push(code.replace(/\n$/, ''));
    return `\n\n\u0000CB${codeBlocks.length - 1}\u0000\n\n`;
  });

  const lines = source.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const fence = /^\u0000CB(\d+)\u0000$/.exec(line.trim());
    if (fence) {
      out.push(`\u0000CB${fence[1] ?? ''}\u0000`);
      continue;
    }
    if (/^\s{0,3}([-*_])\1{2,}\s*$/.test(line)) {
      out.push('');
      continue;
    }
    let body = line.replace(/^\s{0,3}>\s?/, '');
    body = body.replace(/^\s{0,3}#{1,6}\s+/, '');
    const ordered = /^(\s*)(\d+[.)])\s+/.exec(body);
    if (ordered) {
      const marker = ordered[2] ?? '';
      const item = inlineMarkdown(body.slice(ordered[0].length)).trim();
      out.push(item ? `${marker} ${item}` : marker);
      continue;
    }
    const unordered = /^(\s*)[-*+]\s+/.exec(body);
    if (unordered) {
      const item = inlineMarkdown(body.slice(unordered[0].length)).trim();
      out.push(item ? `• ${item}` : '•');
      continue;
    }
    out.push(inlineMarkdown(body).replace(/[ \t]+$/g, ''));
  }

  const tidied = tidyProse(out.join('\n'));
  return tidied
    .replace(/\u0000CB(\d+)\u0000/g, (_match, index: string) => codeBlocks[Number(index)] ?? '')
    .replace(/^\n+|\n+$/g, '');
}

function referenceTitle(citation: ShareCitation): string {
  const raw = (citation.title ?? citation.label).replace(/\s+/g, ' ').trim();
  return raw || 'Untitled source';
}

/** One numbered source line: "1. Title — URL (31 October 2008)". */
export function formatReferenceLine(index: number, citation: ShareCitation): string {
  let line = `${index}. ${referenceTitle(citation)}`;
  const url = citation.url?.replace(/[\r\n\t]/g, '').trim();
  if (url) line += ` \u2014 ${url}`;
  if (citation.date) {
    const date = formatUkDate(citation.date);
    if (date) line += ` (${date})`;
  }
  return line;
}

export function formatReferenceList(citations: readonly ShareCitation[]): string {
  return citations.map((citation, index) => formatReferenceLine(index + 1, citation)).join('\n');
}

/**
 * Answer plus a numbered reference list and a "Via Ask Satoshi" line.
 * `origin` is the site origin (window.location.origin), not a chat address.
 */
export function formatAnswerWithSources(
  answerMarkdown: string,
  citations: readonly ShareCitation[],
  origin: string,
): string {
  const blocks: string[] = [];
  const answer = markdownToPlainText(answerMarkdown);
  if (answer) blocks.push(answer);
  const references = formatReferenceList(citations);
  if (references) blocks.push(references);
  const site = origin.trim();
  blocks.push(site ? `Via Ask Satoshi\n${site}` : 'Via Ask Satoshi');
  return blocks.join('\n\n');
}

function safeSlice(text: string, end: number): string {
  if (end >= text.length) return text;
  if (end <= 0) return '';
  let slice = text.slice(0, end);
  const last = slice.charCodeAt(slice.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1);
  return slice;
}

/** Cut at a sentence boundary when one sits in the latter half, otherwise at a word. */
export function truncateAtBoundary(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (limit < 1) return '';
  if (clean.length <= limit) return clean;
  if (limit === 1) return '\u2026';

  const budget = limit - 1;
  const slice = safeSlice(clean, budget);
  const min = Math.max(1, Math.floor(budget * 0.5));
  let cut = -1;
  for (let i = slice.length - 1; i >= min; i -= 1) {
    const ch = slice[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    const next = slice[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    const prev = i > 0 ? slice[i - 1] : undefined;
    const after = next;
    if (ch === '.' && prev && after && /\d/.test(prev) && /\d/.test(after)) continue;
    cut = i + 1;
    break;
  }
  if (cut < 0) {
    const space = slice.lastIndexOf(' ');
    cut = space > 0 ? space : slice.length;
  }

  let body = safeSlice(slice, cut).trimEnd();
  if (body.endsWith('.')) body = body.slice(0, -1).trimEnd();
  if (!body) body = slice.trimEnd();
  const withMark = `${body}\u2026`;
  if (withMark.length <= limit) return withMark;
  return `${safeSlice(body, limit - 1).trimEnd()}\u2026`;
}

/**
 * Tweet body of at most `limit` characters. The question is included when the
 * question and the answer both fit, or when the question leaves room for a
 * useful stretch of the answer. Whitespace is collapsed; the ellipsis is a
 * single character so the limit is a real character count.
 */
export function buildTweetExcerpt(question: string, answerPlain: string, limit = TWEET_TEXT_LIMIT): string {
  const q = question.replace(/\s+/g, ' ').trim();
  const a = answerPlain.replace(/\s+/g, ' ').trim();
  if (!q && !a) return '';
  if (!a) return truncateAtBoundary(q, limit);
  if (!q) return truncateAtBoundary(a, limit);

  const combined = `${q}\n\n${a}`;
  if (combined.length <= limit) return combined;

  // Leave a useful stretch of the answer. At the default limit this is 80 characters.
  const minAnswer = Math.min(80, Math.max(24, Math.floor(limit * 0.45)));
  const roomForQuestion = limit - 2 - minAnswer;
  if (roomForQuestion >= 12 && q.length <= roomForQuestion) {
    return `${q}\n\n${truncateAtBoundary(a, limit - q.length - 2)}`;
  }
  return truncateAtBoundary(a, limit);
}

const SHARE_SHEET_LIMIT = 4000;

/** Text for navigator.share. Keeps paragraph breaks unless the text is huge. */
export function shareSheetText(question: string, answerPlain: string): string {
  const q = question.trim();
  const a = answerPlain.trim();
  const text = q && a ? `${q}\n\n${a}` : a || q;
  if (text.length <= SHARE_SHEET_LIMIT) return text;
  return truncateAtBoundary(text, SHARE_SHEET_LIMIT);
}

/** https://twitter.com/intent/tweet with both text and url encoded. */
export function xIntentUrl(text: string, pageUrl: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl)}`;
}

function legacyCopy(text: string): boolean {
  const doc = globalThis.document;
  if (!doc?.body || typeof doc.execCommand !== 'function' || typeof doc.createElement !== 'function') {
    return false;
  }
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.tabIndex = -1;
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.width = '1px';
  area.style.height = '1px';
  area.style.padding = '0';
  area.style.border = 'none';
  area.style.outline = 'none';
  area.style.boxShadow = 'none';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  doc.body.appendChild(area);

  const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null;
  const saved: Range[] = [];
  try {
    if (selection && selection.rangeCount > 0) {
      for (let i = 0; i < selection.rangeCount; i += 1) saved.push(selection.getRangeAt(i).cloneRange());
    }
  } catch {
    saved.length = 0;
  }

  try {
    area.focus();
    area.select();
    if (typeof area.setSelectionRange === 'function') area.setSelectionRange(0, area.value.length);
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    try {
      area.remove();
    } catch {
      // The node may already have been detached.
    }
    try {
      if (selection) {
        selection.removeAllRanges();
        for (const range of saved) selection.addRange(range);
      }
    } catch {
      // Restoring the previous selection is best-effort.
    }
  }
}

/**
 * Copy text to the clipboard. Uses the async Clipboard API and falls back to a
 * hidden textarea for http, older Safari and webviews. Never throws.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      try {
        await clipboard.writeText(text);
        return true;
      } catch {
        // Permission, insecure context, or a webview that only pretends to implement it.
      }
    }
    return legacyCopy(text);
  } catch {
    return false;
  }
}
