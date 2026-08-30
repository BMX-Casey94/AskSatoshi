/**
 * Convert the Nakamoto Institute archive's HTML post bodies to clean plain text.
 * The pinned forum_posts.json stores raw HTML (`<div class="post">…<br/>…`), and the
 * client renders excerpts as markdown with raw HTML disabled — so tags must be removed
 * at the data layer, never trusted to the UI. Block-level tags become line breaks,
 * inline tags vanish, and named/numeric entities are decoded AFTER tag stripping so a
 * `&lt;` can never re-form a tag. Idempotent on already-clean text.
 *
 * Keep in sync with the copy in scripts/fetch-satoshi-corpus.mjs (that script is
 * standalone by design and cannot import from src/).
 */

/**
 * Tags whose boundaries read as line breaks in the rendered post. Only KNOWN forum
 * tags are stripped (the pinned archive uses exactly: br, div, a, span, i, b, img,
 * del, tt, li, ul) — a generic `<[^>]*>` strip would eat decoded C++ fragments like
 * `#include <stdio.h>` on a second pass, so unknown angle-bracket text is preserved.
 * The `(?=[\s/>])` lookahead keeps `<break>` or `<stdio.h>` from matching `br`/`i`.
 */
const BLOCK_TAGS =
  /<\/?(?:br|div|p|li|ul|ol|tr|td|th|table|thead|tbody|blockquote|pre|code|h[1-6]|hr)(?=[\s/>])[^>]*>/gi;

/** Inline tags carry no text of their own; anchors keep their link text. */
const INLINE_TAGS = /<\/?(?:a|b|i|u|em|strong|span|font|center|small|sub|sup|img|del|tt)(?=[\s/>])[^>]*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  laquo: '\u00AB',
  raquo: '\u00BB',
  middot: '\u00B7',
  bull: '\u2022',
  copy: '\u00A9',
  deg: '\u00B0',
  plusmn: '\u00B1',
  times: '\u00D7',
  divide: '\u00F7',
};

/** fromCodePoint throws on out-of-range input; hostile archives must not crash ingest. */
function fromCode(code: number): string {
  return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, n: string) => fromCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => fromCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

export function htmlToText(text: string): string {
  // Fast path: no tag opener and no entity lead-in means the text is already clean.
  if (!/</.test(text) && !/&[a-z#]/i.test(text)) return text;
  return decodeEntities(text.replace(/\r/g, '').replace(BLOCK_TAGS, '\n').replace(INLINE_TAGS, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const QUOTE_DIV = /^<div\s+class="(?:quote|quoteheader)(?:\s[^"]*)?"[^>]*>/i;
const DIV_OPEN = /^<div(?=[\s/>])/i;
const DIV_CLOSE = /^<\/div\s*>/i;

/**
 * Remove other users' quoted replies from a Satoshi post. Bitcointalk quotes arrive as
 * `<div class="quoteheader">Quote from: X…</div><div class="quote">…</div>` blocks, and
 * quotes nest (a quoted post can itself contain quotes and the quoter's commentary —
 * all of it the other user's words). The corpus is Satoshi's voice ONLY, so quote
 * blocks are cut with a depth-tracking scan while his own prose before and after is
 * kept. An unterminated quote drops the rest of the post: malformed markup must never
 * risk attributing another user's words to him. Runs on raw HTML, BEFORE htmlToText
 * (which erases the class information the detection needs).
 */
export function stripQuotedReplies(html: string): string {
  if (!/<div\s+class="quote/i.test(html)) return html;
  let result = '';
  let cursor = 0; // text before cursor is already committed to result
  let depth = 0; // > 0 while inside a quote block being skipped
  const tagRe = /<[^>]+>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (depth === 0) {
      if (QUOTE_DIV.test(m[0])) {
        result += html.slice(cursor, m.index);
        depth = 1;
      }
    } else if (DIV_OPEN.test(m[0])) {
      depth++;
    } else if (DIV_CLOSE.test(m[0]) && --depth === 0) {
      cursor = tagRe.lastIndex;
    }
  }
  if (depth === 0) result += html.slice(cursor);
  return result;
}
