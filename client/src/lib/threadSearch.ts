/**
 * Local history search. Matching is case-insensitive, diacritics-insensitive,
 * and every whitespace-separated term must appear somewhere in the title or
 * the messages (AND). Nothing is sent off the device.
 */

import type { Thread } from '../types';

export interface TextPart {
  text: string;
  /** True when this slice is part of a matched term. */
  hit: boolean;
}

export interface ThreadSearchHit {
  id: string;
  title: TextPart[];
  /** First message that contains any term, windowed around the first hit. */
  snippet: TextPart[] | null;
}

interface Range {
  start: number;
  end: number;
}

interface Folded {
  text: string;
  spans: Array<{ start: number; end: number }>;
}

const SNIPPET_RADIUS = 52;

function foldIndexed(input: string): Folded {
  let text = '';
  const spans: Array<{ start: number; end: number }> = [];
  let index = 0;
  for (const char of input) {
    const start = index;
    index += char.length;
    const folded = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const piece of folded) {
      text += piece;
      spans.push({ start, end: index });
    }
  }
  return { text, spans };
}

function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function termsOf(query: string): string[] {
  const folded = foldIndexed(query).text;
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const part of folded.split(/\s+/)) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    terms.push(part);
  }
  return terms;
}

function locate(folded: string, term: string): Range[] {
  if (!term) return [];
  const ranges: Range[] = [];
  let from = 0;
  while (from <= folded.length - term.length) {
    const at = folded.indexOf(term, from);
    if (at < 0) break;
    ranges.push({ start: at, end: at + term.length });
    from = at + term.length;
  }
  return ranges;
}

function mergeRanges(ranges: readonly Range[]): Range[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) merged.push({ start: range.start, end: range.end });
    else if (range.end > last.end) last.end = range.end;
  }
  return merged;
}

function rangesFor(folded: string, terms: readonly string[]): Range[] {
  const found: Range[] = [];
  for (const term of terms) found.push(...locate(folded, term));
  return mergeRanges(found);
}

function rangesToParts(original: string, folded: Folded, ranges: readonly Range[]): TextPart[] {
  if (ranges.length === 0) return original ? [{ text: original, hit: false }] : [];
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const startSpan = folded.spans[range.start];
    const endSpan = folded.spans[range.end - 1];
    if (!startSpan || !endSpan) continue;
    const start = Math.max(startSpan.start, cursor);
    const end = endSpan.end;
    if (end <= cursor) continue;
    if (start > cursor) parts.push({ text: original.slice(cursor, start), hit: false });
    parts.push({ text: original.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < original.length) parts.push({ text: original.slice(cursor), hit: false });
  return parts.filter((part) => part.text.length > 0);
}

function buildSnippet(flat: string, terms: readonly string[]): TextPart[] | null {
  const folded = foldIndexed(flat);
  const ranges = rangesFor(folded.text, terms);
  const first = ranges[0];
  if (!first) return null;
  const startSpan = folded.spans[first.start];
  const endSpan = folded.spans[first.end - 1];
  if (!startSpan || !endSpan) return [{ text: flat, hit: false }];

  let winStart = Math.max(0, startSpan.start - SNIPPET_RADIUS);
  let winEnd = Math.min(flat.length, endSpan.end + SNIPPET_RADIUS);
  if (winStart > 0) {
    const space = flat.lastIndexOf(' ', startSpan.start);
    if (space >= winStart) winStart = space + 1;
  }
  if (winEnd < flat.length) {
    const space = flat.indexOf(' ', endSpan.end);
    if (space !== -1 && space <= winEnd + 16) winEnd = space;
  }

  const slice = flat.slice(winStart, winEnd);
  const sliceFolded = foldIndexed(slice);
  const parts = rangesToParts(slice, sliceFolded, rangesFor(sliceFolded.text, terms));
  if (winStart > 0) parts.unshift({ text: '… ', hit: false });
  if (winEnd < flat.length) parts.push({ text: ' …', hit: false });
  return parts;
}

/**
 * Filter threads by a query. A blank query returns every thread, in the order
 * given, with no highlights. Callers that want newest-first should sort first.
 */
export function searchThreads(threads: readonly Thread[], query: string): ThreadSearchHit[] {
  const terms = termsOf(query);
  if (terms.length === 0) {
    return threads.map((thread) => ({
      id: thread.id,
      title: [{ text: typeof thread.title === 'string' ? thread.title : '', hit: false }],
      snippet: null,
    }));
  }

  const hits: ThreadSearchHit[] = [];
  for (const thread of threads) {
    const title = typeof thread.title === 'string' ? thread.title : '';
    const titleFlat = flatten(title);
    const titleFolded = foldIndexed(titleFlat);
    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    const bodies = messages.map((message) => {
      const content = typeof message?.content === 'string' ? message.content : '';
      return flatten(content);
    });
    const haystacks = [titleFolded.text, ...bodies.map((body) => foldIndexed(body).text)];
    const matched = terms.every((term) => haystacks.some((haystack) => haystack.includes(term)));
    if (!matched) continue;

    const firstBody = bodies.find((body) => terms.some((term) => foldIndexed(body).text.includes(term)));
    hits.push({
      id: thread.id,
      title: rangesToParts(titleFlat, titleFolded, rangesFor(titleFolded.text, terms)),
      snippet: firstBody ? buildSnippet(firstBody, terms) : null,
    });
  }
  return hits;
}
