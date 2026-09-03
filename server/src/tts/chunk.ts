/**
 * Split TTS source text into Resemble-safe chunks. Resemble's hard limit is 3,000
 * characters; CHUNK_MAX_CHARS leaves headroom so a greedy pack never trips it.
 */

export const CHUNK_MAX_CHARS = 2_400;

const SENTENCE_MARK = new Set(['.', '!', '?', '…', ':']);

function isSpaceOrBreak(ch: string | undefined): boolean {
  return ch === undefined || ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

/** True at the end of a sentence (mark + space/newline/end) or on a newline. */
function isBoundary(text: string, i: number): boolean {
  const ch = text[i];
  if (ch === '\n' || ch === '\r') return true;
  if (ch && SENTENCE_MARK.has(ch)) return isSpaceOrBreak(text[i + 1]);
  return false;
}

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!isBoundary(text, i)) continue;
    let end = i + 1;
    // Keep the delimiter's trailing whitespace with this sentence so joins reconstruct.
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
    if (text[i] === '\r' && text[end] === '\n') end++;
    const piece = text.slice(start, end);
    if (piece.length > 0) sentences.push(piece);
    start = end;
    i = end - 1;
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences;
}

/** Split a single oversized sentence at the last space before max; else a hard cut. */
function splitLong(sentence: string, max: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const space = window.lastIndexOf(' ');
    if (space > 0) {
      out.push(rest.slice(0, space));
      rest = rest.slice(space + 1);
    } else {
      out.push(window);
      rest = rest.slice(max);
    }
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

export function chunkText(text: string, max = CHUNK_MAX_CHARS): string[] {
  if (!text.trim()) return [];
  const sentences = splitSentences(text);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };

  for (const raw of sentences) {
    const pieces = raw.length > max ? splitLong(raw, max) : [raw];
    for (const piece of pieces) {
      if (piece.length > max) {
        // splitLong guarantees this cannot happen; belt-and-braces for the type checker.
        flush();
        chunks.push(...splitLong(piece, max));
        continue;
      }
      if (current.length === 0) {
        current = piece;
        continue;
      }
      if (current.length + piece.length <= max) {
        current += piece;
      } else {
        flush();
        current = piece;
      }
    }
  }
  flush();
  return chunks;
}
