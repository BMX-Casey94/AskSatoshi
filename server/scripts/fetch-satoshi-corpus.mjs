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
  return kept
    .join('\n')
    .replace(/Satoshi Nakamoto\s*(https?:\/\/\S+)?\s*$/m, '')
    .replace(/The Cryptography Mailing List[\s\S]*$/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    },
    documents,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(corpus, null, 2)}\n`);
  console.log(
    `[fetch] wrote ${OUT} — ${corpus.pin.counts.posts} posts, ${corpus.pin.counts.emails} emails, ${corpus.pin.counts.quotes} quotes (${documents.length} documents)`,
  );
}

main().catch((err) => {
  console.error(`[fetch] failed: ${err.message}`);
  process.exit(1);
});
