/**
 * Last-line-of-defence normalisation for source excerpts shown in the citation panel.
 * Excerpts are cleaned at the data layer (server/src/htmlText.ts), but threads persist
 * in localStorage — excerpts saved before that pipeline existed still carry raw archive
 * HTML — and a future source could slip through. When real markup is detected it is
 * converted to markdown formatting (paragraphs, lists, blockquotes, emphasis, links);
 * plain text — including code fragments like `#include <stdio.h>` — passes through
 * untouched. The output is only ever rendered through markdown-it with raw HTML
 * disabled + DOMPurify, so this is a formatting layer, never a trust boundary.
 *
 * Entity table kept in sync with server/src/htmlText.ts.
 */

/** A raw tag from the forum archive or common web markup marks the string as HTML.
 * script/style/iframe are deliberately absent: a plain-text mention of them must never
 * trigger HTML mode (they are still dropped when a document is detected via other tags). */
const RAW_TAG =
  /<\/?(?:a|abbr|acronym|address|article|aside|b|bdi|bdo|big|blockquote|br|center|cite|code|data|dd|del|details|div|dl|dt|em|figcaption|figure|font|footer|h[1-6]|header|hr|i|img|ins|kbd|li|main|mark|nav|nobr|ol|p|pre|q|ruby|s|samp|section|small|span|strike|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|time|tr|tt|u|ul|var|wbr)(?=[\s/>])[^>]*>/i;

/** The same, entity-encoded (&lt;div class=&quot;post&quot;&gt;…) — an escaped HTML document. */
const ENCODED_TAG =
  /&lt;\/?(?:a|b|blockquote|br|code|div|em|h[1-6]|hr|i|img|li|ol|p|pre|span|strong|table|td|th|tr|ul)(?=[\s/&])/gi;

const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const DOCTYPE = /<!doctype[^>]*>/gi;

/** Every tag token, known or not — unknown ones are preserved as literal text so code
 * fragments like `<stdio.h>` survive inside an otherwise-HTML document. */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;

/** Elements whose contents are never prose: dropped whole when a document is HTML. */
const DROP_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'canvas', 'noscript', 'template',
  'head', 'title', 'applet', 'frame', 'frameset', 'audio', 'video', 'picture', 'form',
  'button', 'select', 'textarea', 'option', 'optgroup', 'dialog', 'menu', 'menuitem',
]);

/** Void elements — dropped as a bare tag, never scanned to a closing tag. */
const VOID_DROP = new Set([
  'meta', 'link', 'base', 'area', 'param', 'source', 'track', 'input', 'col', 'keygen',
]);

/** Block-level boundaries read as line breaks. */
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure',
  'figcaption', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'caption', 'colgroup', 'ul', 'ol', 'center', 'address', 'details', 'summary', 'fieldset',
  'legend', 'label',
]);

const EMPHASIS_DOUBLE = new Set(['b', 'strong']);
const EMPHASIS_SINGLE = new Set(['i', 'em', 'cite']);
const CODE_TICK = new Set(['code', 'tt', 'kbd', 'samp', 'var']);

/** Inline tags that carry no formatting worth keeping: the tag vanishes, text stays. */
const VANISH = new Set([
  'abbr', 'acronym', 'big', 'data', 'del', 'ins', 'mark', 'nobr', 'output', 'ruby', 's',
  'small', 'strike', 'sub', 'sup', 'time', 'u', 'font', 'span', 'bdi', 'bdo', 'wbr',
  'body', 'html',
]);

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

/** fromCodePoint throws on out-of-range input; hostile archives must not crash render. */
function fromCode(code: number): string {
  return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, n: string) => fromCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => fromCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function attrValue(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** Only web-safe link protocols become markdown links — anything else degrades to text. */
function safeHref(attrs: string): string | undefined {
  const href = attrValue(attrs, 'href');
  return href && /^https?:\/\/[^\s\[\]()"'\\]+$/i.test(href) ? href : undefined;
}

function classHas(attrs: string, name: string): boolean {
  return new RegExp(`\\bclass\\s*=\\s*(?:"[^"]*\\b${name}\\b[^"]*"|'[^']*\\b${name}\\b[^']*')`, 'i').test(
    attrs,
  );
}

/** Convert a detected-HTML string to markdown-formatted text. */
function convertHtml(html: string): string {
  const out: string[] = [];
  let quoteDepth = 0;
  const linkStack: (string | undefined)[] = [];
  // Closing </div> tags carry no attributes, so each opener's kind is remembered here.
  const divStack: ('block' | 'quote' | 'code' | 'quoteheader')[] = [];

  /** Line break honouring the blockquote depth — the prefix belongs to the next line. */
  const nl = () => {
    out.push('\n' + '> '.repeat(quoteDepth));
  };

  /** Skip an element dropped with its contents; returns the index after its close tag. */
  const skipElement = (name: string, from: number): number => {
    const re = new RegExp(`<\\/?${name}(?=[\\s/>])[^>]*>`, 'gi');
    re.lastIndex = from;
    let depth = 1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      if (m[0][1] === '/') {
        if (--depth === 0) return re.lastIndex;
      } else if (!m[0].endsWith('/>')) {
        depth++;
      }
    }
    // Unterminated drop-content: fail closed and drop the rest of the excerpt.
    return html.length;
  };

  let last = 0;
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(html)) !== null) {
    out.push(html.slice(last, m.index));
    last = TAG.lastIndex;
    const isClose = m[1] === '/';
    const name = (m[2] ?? '').toLowerCase();
    const attrs = m[3] ?? '';
    const selfClosing = m[0].endsWith('/>');

    if (DROP_CONTENT.has(name)) {
      if (!isClose && !selfClosing) {
        const end = skipElement(name, TAG.lastIndex);
        TAG.lastIndex = end;
        last = end;
      }
      continue;
    }
    if (VOID_DROP.has(name)) {
      continue;
    }
    if (name === 'br') {
      nl();
      continue;
    }
    if (name === 'hr') {
      // Blank lines on both sides — a single newline would read as a setext heading.
      nl();
      nl();
      out.push('---');
      nl();
      nl();
      continue;
    }
    if (name === 'img') {
      if (!isClose) {
        const alt = attrValue(attrs, 'alt')?.trim();
        if (alt) out.push(alt);
      }
      continue;
    }
    if (name === 'a') {
      if (isClose) {
        const href = linkStack.pop();
        if (href) out.push(`](${href})`);
      } else {
        const href = selfClosing ? undefined : safeHref(attrs);
        if (href) out.push('[');
        linkStack.push(href);
      }
      continue;
    }
    if (name === 'blockquote') {
      if (isClose) {
        if (quoteDepth > 0) quoteDepth--;
        // A blank line ends the quote — otherwise the next paragraph is lazily absorbed.
        nl();
        nl();
      } else if (!selfClosing) {
        quoteDepth++;
        nl();
      }
      continue;
    }
    if (name === 'div') {
      if (isClose) {
        const kind = divStack.pop() ?? 'block';
        if (kind === 'quote') {
          if (quoteDepth > 0) quoteDepth--;
          nl();
          nl();
        } else if (kind === 'quoteheader') {
          out.push('*');
          nl();
        } else if (kind === 'code') {
          nl();
          out.push('```');
          nl();
        } else {
          nl();
        }
        continue;
      }
      if (selfClosing) {
        nl();
        continue;
      }
      if (classHas(attrs, 'quoteheader')) {
        // "Quote from: X on …" attribution — kept as an italic line above the quote.
        divStack.push('quoteheader');
        nl();
        out.push('*');
      } else if (classHas(attrs, 'quote')) {
        divStack.push('quote');
        quoteDepth++;
        nl();
      } else if (classHas(attrs, 'code')) {
        divStack.push('code');
        nl();
        out.push('```');
        nl();
      } else {
        divStack.push('block');
        nl();
      }
      continue;
    }
    if (name === 'pre') {
      if (isClose) {
        nl();
        out.push('```');
        nl();
      } else {
        nl();
        out.push('```');
        nl();
      }
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      if (isClose) {
        nl();
      } else {
        nl();
        out.push('### ');
      }
      continue;
    }
    if (name === 'li') {
      if (!isClose) {
        nl();
        out.push('- ');
      }
      continue;
    }
    if (name === 'q') {
      out.push('"');
      continue;
    }
    if (EMPHASIS_DOUBLE.has(name)) {
      out.push('**');
      continue;
    }
    if (EMPHASIS_SINGLE.has(name)) {
      out.push('*');
      continue;
    }
    if (CODE_TICK.has(name)) {
      out.push('`');
      continue;
    }
    if (BLOCK.has(name)) {
      nl();
      continue;
    }
    if (VANISH.has(name)) {
      continue;
    }
    // Unknown angle-bracket text (code fragments, comparisons): preserved as written.
    out.push(m[0]);
  }
  out.push(html.slice(last));
  return out.join('');
}

function tidy(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Return the excerpt as clean markdown-formatted text. Non-HTML input is returned
 * byte-for-byte (entities included — markdown-it decodes those at render time).
 */
export function excerptToMarkdown(text: string): string {
  // Fast path: no tag opener and no entity lead-in means the text is already clean.
  if (!/</.test(text) && !/&[a-z#]/i.test(text)) return text;
  if (RAW_TAG.test(text)) {
    // Decode AFTER tag conversion, so an encoded inline mention can never re-form a tag.
    return tidy(decodeEntities(convertHtml(text.replace(COMMENT, '').replace(DOCTYPE, ''))));
  }
  // An escaped HTML document needs decoding first so its tags materialise. Require at
  // least two known tags: a single "&lt;div&gt;" is someone discussing markup in prose.
  if ((text.match(ENCODED_TAG) ?? []).length >= 2) {
    return tidy(convertHtml(decodeEntities(text).replace(COMMENT, '').replace(DOCTYPE, '')));
  }
  return text;
}
