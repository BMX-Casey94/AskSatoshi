/**
 * Pins Satoshi Nakamoto's forum posts and e-mails from the Nakamoto Institute archive
 * (github.com/NakamotoInstitute/nakamotoinstitute.org) into data/satoshi-corpus.json.
 *
 * Only Satoshi's own words are kept (entries carrying a `satoshi_id`); quoted reply
 * lines and mailing-list chrome are stripped. The upstream commit SHA is recorded so
 * every answer is auditable against a pinned snapshot — the same discipline as the
 * BSV-AIO-MCP corpus. Re-run to refresh; review the diff before committing.
 *
 * Usage: node scripts/fetch-satoshi-corpus.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countPrivateEmails, fetchPrivateEmails } from './privateEmails.mjs';

const REPO = 'NakamotoInstitute/nakamotoinstitute.org';
const RAW = `https://raw.githubusercontent.com/${REPO}/master/server/data`;
const API = `https://api.github.com/repos/${REPO}`;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'satoshi-corpus.json');
const SNI = 'https://satoshi.nakamotoinstitute.org';

const HEADERS = {
  'User-Agent': 'ask-satoshi-corpus-fetch',
  Accept: 'application/vnd.github+json',
};

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Convert the archive's raw HTML post bodies to plain text. Block-level tags become
 * line breaks, inline tags vanish, entities are decoded after stripping so a `&lt;`
 * can never re-form a tag. Keep in sync with server/src/htmlText.ts — this script is
 * standalone (no src/ imports) by design.
 */
// Only known forum tags are stripped (the pinned archive uses exactly: br, div, a,
// span, i, b, img, del, tt, li, ul) — a generic strip would eat decoded C++ fragments
// like `#include <stdio.h>`. The (?=[\s/>]) lookahead keeps <break>/<stdio.h> safe.
const BLOCK_TAGS =
  /<\/?(?:br|div|p|li|ul|ol|tr|td|th|table|thead|tbody|blockquote|pre|code|h[1-6]|hr)(?=[\s/>])[^>]*>/gi;
const INLINE_TAGS = /<\/?(?:a|b|i|u|em|strong|span|font|center|small|sub|sup|img|del|tt)(?=[\s/>])[^>]*>/gi;
const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '\u00AB', raquo: '\u00BB', middot: '\u00B7', bull: '\u2022',
  copy: '\u00A9', deg: '\u00B0', plusmn: '\u00B1', times: '\u00D7', divide: '\u00F7',
};
const fromCode = (n) => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

/**
 * Remove other users' quoted replies (`<div class="quoteheader">…</div><div
 * class="quote">…</div>`, nesting included) so the corpus is Satoshi's voice only.
 * Depth-tracking scan; an unterminated quote drops the tail rather than risking
 * misattribution. Must run on raw HTML, before htmlToText.
 */
const QUOTE_DIV = /^<div\s+class="(?:quote|quoteheader)(?:\s[^"]*)?"[^>]*>/i;
const DIV_OPEN = /^<div(?=[\s/>])/i;
const DIV_CLOSE = /^<\/div\s*>/i;

function stripQuotedReplies(html) {
  if (!/<div\s+class="quote/i.test(html)) return html;
  let result = '';
  let cursor = 0;
  let depth = 0;
  const tagRe = /<[^>]+>/g;
  let m;
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

function htmlToText(text) {
  if (!/</.test(text) && !/&[a-z#]/i.test(text)) return text;
  return String(text)
    .replace(/\r/g, '')
    .replace(BLOCK_TAGS, '\n')
    .replace(INLINE_TAGS, '')
    .replace(/&#(\d+);/g, (_m, n) => fromCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => fromCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Strip quoted parent lines, signatures and mailing-list chrome; keep Satoshi's words. */
function cleanText(text) {
  const lines = String(text).split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>')) continue;
    if (/^-{5,}/.test(trimmed)) break; // mailing-list footer marker
    kept.push(line);
  }
  return htmlToText(
    stripQuotedReplies(
      kept
        .join('\n')
        .replace(/Satoshi Nakamoto\s*(https?:\/\/\S+)?\s*$/m, '')
        .replace(/The Cryptography Mailing List[\s\S]*$/m, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    ),
  );
}

function postSource(url) {
  if (/p2pfoundation\.ning\.com/.test(url)) return 'p2pfoundation';
  if (/bitcointalk\.org/.test(url)) return 'bitcointalk';
  return null;
}

async function main() {
  console.log('[fetch] resolving upstream commit…');
  const commit = await fetchJson(`${API}/commits/master`);
  const sha = commit.sha;
  console.log(`[fetch] pinning ${REPO}@${sha.slice(0, 7)}`);

  console.log('[fetch] downloading emails.json…');
  const emails = await fetchJson(`${RAW}/emails.json`);
  console.log('[fetch] downloading forum_posts.json (≈5 MB)…');
  const posts = await fetchJson(`${RAW}/forum_posts.json`);

  const documents = [];

  for (const e of emails) {
    if (e.satoshi_id === undefined || e.satoshi_id === null) continue;
    const text = cleanText(e.text);
    if (text.length < 40) continue;
    documents.push({
      id: `email-${e.source}-${e.satoshi_id}`,
      kind: 'email',
      title: String(e.subject ?? 'Untitled'),
      date: String(e.date ?? ''),
      url: `${SNI}/emails/${e.source}/${e.satoshi_id}/`,
      text,
    });
  }

  console.log('[fetch] fetching private Satoshi-authored emails…');
  const privateEmails = await fetchPrivateEmails();
  documents.push(...privateEmails);
  const privateEmailCounts = countPrivateEmails(privateEmails);

  for (const p of posts) {
    if (p.satoshi_id === undefined || p.satoshi_id === null) continue;
    const text = cleanText(p.text);
    if (text.length < 40) continue;
    const source = postSource(String(p.url ?? ''));
    documents.push({
      id: `post-${source ?? 'unknown'}-${p.satoshi_id}`,
      kind: 'post',
      title: String(p.subject ?? 'Untitled'),
      date: String(p.date ?? ''),
      url: source ? `${SNI}/posts/${source}/${p.satoshi_id}/` : String(p.url ?? ''),
      text,
    });
  }

  // Curated quotes are a bonus source; the shape is mapped defensively and skipped
  // with a warning rather than failing the build if upstream restructures.
  let quoteCount = 0;
  try {
    console.log('[fetch] downloading quotes.json…');
    const quotes = await fetchJson(`${RAW}/quotes.json`);
    if (Array.isArray(quotes)) {
      for (const [i, q] of quotes.entries()) {
        const text = String(q.text ?? q.quote ?? '').trim();
        if (text.length < 40) continue;
        const date = String(q.date ?? '');
        documents.push({
          id: `quote-${i}`,
          kind: 'quote',
          title: String(q.title ?? q.category ?? 'Quoted remark'),
          date,
          url: String(q.url ?? q.link ?? `${SNI}/quotes/`),
          text,
        });
        quoteCount += 1;
      }
    }
  } catch (err) {
    console.warn(`[fetch] quotes.json skipped: ${err.message}`);
  }

  const corpus = {
    pin: {
      repo: REPO,
      commit: sha,
      fetchedAt: new Date().toISOString(),
      counts: {
        emails: documents.filter((d) => d.kind === 'email').length,
        posts: documents.filter((d) => d.kind === 'post').length,
        quotes: quoteCount,
      },
      privateEmails: privateEmailCounts,
    },
    documents,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(corpus, null, 2)}\n`);
  const pe = corpus.pin.privateEmails;
  console.log(
    `[fetch] wrote ${OUT} — ${corpus.pin.counts.posts} posts, ${corpus.pin.counts.emails} emails (${pe.total} private: malmi ${pe.malmi}, hearn ${pe.hearn}, finney ${pe.finney}, weidai ${pe.weidai}), ${corpus.pin.counts.quotes} quotes (${documents.length} documents)`,
  );
}

main().catch((err) => {
  console.error(`[fetch] failed: ${err.message}`);
  process.exit(1);
});
