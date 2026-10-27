/**
 * Pins short excerpts from CoinGeek (coingeek.com) into data/coingeek-news.json.
 *
 * CoinGeek is a BSV-aligned news outlet. Articles go stale: this snapshot stores
 * a title, dates, tags and a short excerpt only — never the article body.
 *
 * The model must not browse the live web. Re-run this script to refresh, then
 * review the diff before committing. Polite by construction: robots.txt is
 * checked, one request per second, backoff on 429/5xx, and a hard request cap.
 *
 * Usage:
 *   node scripts/fetch-coingeek.mjs [--months 36] [--max-requests 250] [--out path]
 */

import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://coingeek.com';
const UA = 'AskSatoshi-NewsIndexer (+https://github.com/BMX-Casey94/AskSatoshi)';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'coingeek-news.json');
const EXCERPT_MAX = 400;

/** Known baseline if robots.txt cannot be fetched. Live rules replace this when the fetch succeeds. */
const BASELINE_ROBOTS = 'User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n';

const BLOCK_TAGS =
  /<\/?(?:br|div|p|li|ul|ol|tr|td|th|table|thead|tbody|blockquote|pre|code|h[1-6]|hr|figure|figcaption|section|article|aside|header|footer|nav)(?=[\s/>])[^>]*>/gi;
const INLINE_TAGS =
  /<\/?(?:a|b|i|u|em|strong|span|font|center|small|sub|sup|img|del|tt|time|mark|cite|q)(?=[\s/>])[^>]*>/gi;
const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '\u00AB', raquo: '\u00BB', middot: '\u00B7', bull: '\u2022',
  copy: '\u00A9', deg: '\u00B0', plusmn: '\u00B1', times: '\u00D7', divide: '\u00F7',
  pound: '\u00A3',
};

class CapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CapError';
    this.code = 'CAP';
  }
}

function fromCode(n) {
  return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/**
 * Plain text for storage. Block tags become spaces, known inline tags vanish,
 * and entities are decoded afterwards so `&lt;` cannot re-form a tag in the
 * same pass. Keep in sync with the spirit of server/src/htmlText.ts — this
 * script is standalone and does not import from src/.
 */
export function htmlToPlainText(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (!/</.test(text) && !/&[a-z#]/i.test(text)) return text.replace(/\s+/g, ' ').trim();
  BLOCK_TAGS.lastIndex = 0;
  INLINE_TAGS.lastIndex = 0;
  const stripped = text
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, ' ')
    .replace(BLOCK_TAGS, '\n')
    .replace(INLINE_TAGS, '');
  return stripped
    .replace(/&#(\d+);/g, (_m, n) => fromCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => fromCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** ≤ max characters, preferring a sentence boundary. */
export function clipExcerpt(value, max = EXCERPT_MAX) {
  const clean = htmlToPlainText(value).replace(/\s+/g, ' ').trim();
  const limit = Math.max(1, max);
  if (clean.length <= limit) return clean;
  let cut = -1;
  const end = Math.min(clean.length, limit);
  for (let i = 0; i < end; i += 1) {
    const ch = clean[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    const prev = i > 0 ? clean[i - 1] : '';
    if (ch === '.' && /\d/.test(prev)) continue;
    const next = i + 1 < clean.length ? clean[i + 1] : ' ';
    if (i + 1 < clean.length && !/\s/.test(next)) continue;
    if (i + 1 > limit) continue;
    cut = i + 1;
  }
  if (cut >= 40) return clean.slice(0, cut).trim();
  const space = clean.lastIndexOf(' ', limit);
  return (space >= 40 ? clean.slice(0, space) : clean.slice(0, limit)).trim();
}

function clipTitle(value) {
  const clean = htmlToPlainText(value).replace(/\s+/g, ' ').trim();
  if (clean.length <= 240) return clean;
  const slice = clean.slice(0, 240);
  const space = slice.lastIndexOf(' ');
  return (space >= 40 ? slice.slice(0, space) : slice).trim();
}

export function canonicalUrl(value) {
  const raw = String(value ?? '').trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.hash = '';
    const kept = [];
    for (const [key, val] of url.searchParams) {
      if (/^utm_/i.test(key) || key === 'fbclid' || key === 'mc_cid' || key === 'mc_eid') continue;
      kept.push([key, val]);
    }
    url.search = '';
    for (const [key, val] of kept) url.searchParams.append(key, val);
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return raw;
  }
}

export function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const rawLine of String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const splitAt = line.indexOf(':');
    if (splitAt < 0) continue;
    const key = line.slice(0, splitAt).trim().toLowerCase();
    const value = line.slice(splitAt + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [], crawlDelay: 0 };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      if (!current) {
        current = { agents: ['*'], rules: [], crawlDelay: 0 };
        groups.push(current);
      }
      current.rules.push({ type: key, path: value });
    } else if (key === 'crawl-delay' && current) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > current.crawlDelay) current.crawlDelay = seconds;
    }
  }
  return groups;
}

function ruleMatches(pattern, pathname) {
  if (!pattern) return false;
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') source += '.*';
    else if (ch === '$' && i === pattern.length - 1) source += '$';
    else source += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(source).test(pathname);
}

export function robotsAllows(groups, userAgent, pathname) {
  const agent = String(userAgent ?? '').toLowerCase();
  const specific = groups.filter((group) => group.agents.some((name) => name !== '*' && agent.includes(name)));
  const chosen = specific.length > 0 ? specific : groups.filter((group) => group.agents.includes('*'));
  let winner = null;
  let winnerLen = -1;
  for (const group of chosen) {
    for (const rule of group.rules) {
      if (!rule.path || !ruleMatches(rule.path, pathname)) continue;
      if (rule.path.length > winnerLen || (rule.path.length === winnerLen && rule.type === 'allow')) {
        winner = rule;
        winnerLen = rule.path.length;
      }
    }
  }
  if (!winner) return true;
  return winner.type === 'allow';
}

/** Live robots rules, plus a hard block on /wp-admin/ even if a later robots.txt allows it. */
export function pathAllowed(groups, userAgent, pathname) {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (path === '/wp-admin' || path.startsWith('/wp-admin/')) return false;
  return robotsAllows(groups, userAgent, path);
}

export function crawlDelaySeconds(groups, userAgent) {
  const agent = String(userAgent ?? '').toLowerCase();
  const specific = groups.filter((group) => group.agents.some((name) => name !== '*' && agent.includes(name)));
  const chosen = specific.length > 0 ? specific : groups.filter((group) => group.agents.includes('*'));
  let delay = 0;
  for (const group of chosen) delay = Math.max(delay, group.crawlDelay || 0);
  return delay;
}

function metaAttrs(tag) {
  const attrs = {};
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match;
  while ((match = re.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? '';
  }
  return attrs;
}

/** Document title from the head. Used only when a sitemap URL has no RSS title. */
export function headTitle(html) {
  const source = String(html ?? '');
  const headEnd = source.search(/<\/head>/i);
  const head = headEnd >= 0 ? source.slice(0, headEnd) : source.slice(0, 96_000);
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  return match ? clipTitle(unwrapCdata(match[1])).replace(/\s*[|–—-]\s*CoinGeek\s*$/i, '').trim() : '';
}

/** description, else og:description, from the document head only. */
export function metaDescription(html) {
  const source = String(html ?? '');
  const headEnd = source.search(/<\/head>/i);
  const head = headEnd >= 0 ? source.slice(0, headEnd) : source.slice(0, 96_000);
  const tags = head.match(/<meta\b[^>]*>/gi) ?? [];
  let named = '';
  let og = '';
  for (const tag of tags) {
    const attrs = metaAttrs(tag);
    const content = clipExcerpt(attrs.content ?? '');
    if (!content) continue;
    if ((attrs.name ?? '').toLowerCase() === 'description' && !named) named = content;
    if ((attrs.property ?? '').toLowerCase() === 'og:description' && !og) og = content;
  }
  return named || og;
}

function unwrapCdata(value) {
  return String(value ?? '')
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .trim();
}

function tagText(xml, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const match = re.exec(xml);
  return match ? unwrapCdata(match[1]) : '';
}

export function parseRssItems(xml) {
  const chunks = String(xml ?? '').split(/<item\b/i).slice(1);
  const items = [];
  for (const chunk of chunks) {
    const body = chunk.split(/<\/item>/i)[0] ?? chunk;
    const title = tagText(body, 'title');
    const link = tagText(body, 'link') || tagText(body, 'guid');
    if (!title || !link) continue;
    const categories = [];
    const tags = [];
    const catRe = /<category(\s[^>]*)?>([\s\S]*?)<\/category>/gi;
    let cat;
    while ((cat = catRe.exec(body)) !== null) {
      const name = htmlToPlainText(unwrapCdata(cat[2]));
      if (!name) continue;
      const domain = /domain=["']([^"']+)["']/i.exec(cat[1] ?? '')?.[1] ?? '';
      if (domain.includes('tag')) tags.push(name);
      else categories.push(name);
    }
    items.push({
      title,
      link,
      pubDate: tagText(body, 'pubDate') || tagText(body, 'dc:date'),
      description: tagText(body, 'description'),
      categories,
      tags,
    });
  }
  return items;
}

export function parseSitemapLocs(xml) {
  const blocks = String(xml ?? '').split(/<(?:sitemap|url)\b/i).slice(1);
  const out = [];
  for (const block of blocks) {
    const loc = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s]+)\s*(?:\]\]>)?\s*<\/loc>/i.exec(block);
    if (!loc?.[1]) continue;
    const lastmod = /<lastmod>\s*(?:<!\[CDATA\[)?\s*([^<\s]+)\s*(?:\]\]>)?\s*<\/lastmod>/i.exec(block);
    out.push({
      loc: unwrapCdata(loc[1]).replace(/&amp;/g, '&'),
      lastmod: lastmod?.[1] ? unwrapCdata(lastmod[1]) : '',
    });
  }
  return out;
}

export function toIso(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const zoned = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const zonedMs = Date.parse(zoned);
  if (!Number.isNaN(zonedMs)) return new Date(zonedMs).toISOString();
  const fallback = Date.parse(raw);
  if (Number.isNaN(fallback)) return '';
  return new Date(fallback).toISOString();
}

function stamp(item) {
  const modified = Date.parse(item.modified || '');
  if (!Number.isNaN(modified)) return modified;
  const date = Date.parse(item.date || '');
  return Number.isNaN(date) ? 0 : date;
}

function copyItem(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id ?? '').trim();
  const urlRaw = String(item.url ?? '').trim();
  const title = String(item.title ?? '').trim();
  const date = String(item.date ?? '').trim();
  const excerpt = String(item.excerpt ?? '').trim();
  if (!id || !urlRaw || !title || !date || !excerpt) return null;
  const copy = { id, url: canonicalUrl(urlRaw), title, date, excerpt };
  if (item.modified) {
    const modified = String(item.modified).trim();
    if (modified) copy.modified = modified;
  }
  if (Array.isArray(item.categories)) {
    const categories = item.categories.map((term) => String(term).trim()).filter(Boolean);
    if (categories.length) copy.categories = categories;
  }
  if (Array.isArray(item.tags)) {
    const tags = item.tags.map((term) => String(term).trim()).filter(Boolean);
    if (tags.length) copy.tags = tags;
  }
  return copy;
}

/**
 * Merge a fresh fetch into the pinned file.
 * Dedupe by id or canonical url. The copy with the later `modified` (else `date`)
 * wins; equal timestamps keep the incoming copy. When `coverage.complete` is set,
 * items inside `[from, to]` that the fresh fetch did not return are dropped —
 * they left the source. Items outside that window are kept, and nothing is
 * dropped when the fetch did not cover the window.
 */
export function mergeNewsItems(existing, incoming, coverage = {}) {
  const items = [];
  const byId = new Map();
  const byUrl = new Map();

  function remember(item, index) {
    byId.set(item.id, index);
    byUrl.set(item.url, index);
  }

  function forget(item) {
    if (byId.get(item.id) !== undefined) byId.delete(item.id);
    if (byUrl.get(item.url) !== undefined) byUrl.delete(item.url);
  }

  function findIndex(item) {
    if (byId.has(item.id)) return byId.get(item.id);
    if (byUrl.has(item.url)) return byUrl.get(item.url);
    return undefined;
  }

  function replace(index, item) {
    const prev = items[index];
    forget(prev);
    items[index] = item;
    remember(item, index);
  }

  function keptTerms(winner, other) {
    const categories = winner.categories?.length ? winner.categories : other.categories;
    const tags = winner.tags?.length ? winner.tags : other.tags;
    if (categories === winner.categories && tags === winner.tags) return winner;
    return articleItem({ ...winner, categories, tags });
  }

  function upsert(item, incomingWinsTies) {
    const index = findIndex(item);
    if (index === undefined) {
      const at = items.length;
      items.push(item);
      remember(item, at);
      return;
    }
    const current = items[index];
    const currentStamp = stamp(current);
    const nextStamp = stamp(item);
    if (nextStamp > currentStamp || (nextStamp === currentStamp && incomingWinsTies)) {
      replace(index, keptTerms(item, current));
    }
  }

  for (const raw of existing ?? []) {
    const copy = copyItem(raw);
    if (copy) upsert(copy, false);
  }

  const seenIds = new Set();
  const seenUrls = new Set();
  for (const raw of incoming ?? []) {
    const copy = copyItem(raw);
    if (!copy) continue;
    seenIds.add(copy.id);
    seenUrls.add(copy.url);
    upsert(copy, true);
  }

  const from = Date.parse(coverage.from ?? '');
  const to = Date.parse(coverage.to ?? '');
  const canDrop = coverage.complete === true && !Number.isNaN(from) && !Number.isNaN(to);
  const filtered = canDrop
    ? items.filter((item) => {
        if (seenIds.has(item.id) || seenUrls.has(item.url)) return true;
        const when = Date.parse(item.date || '');
        const inRange = !Number.isNaN(when) && when >= from && when <= to;
        return !inRange;
      })
    : items.slice();

  filtered.sort((a, b) => {
    const da = Date.parse(a.date);
    const db = Date.parse(b.date);
    const aOk = !Number.isNaN(da);
    const bOk = !Number.isNaN(db);
    if (aOk && bOk && da !== db) return db - da;
    if (aOk !== bOk) return aOk ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return filtered;
}

function positiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function parseArgs(argv) {
  const opts = { months: 36, maxRequests: 250, out: OUT, timeoutMs: 25_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--months' && next) {
      opts.months = positiveInt(next, 36, 240);
      i += 1;
    } else if (arg.startsWith('--months=')) {
      opts.months = positiveInt(arg.slice('--months='.length), 36, 240);
    } else if (arg === '--max-requests' && next) {
      opts.maxRequests = positiveInt(next, 250, 2000);
      i += 1;
    } else if (arg.startsWith('--max-requests=')) {
      opts.maxRequests = positiveInt(arg.slice('--max-requests='.length), 250, 2000);
    } else if (arg === '--out' && next) {
      opts.out = next;
      i += 1;
    } else if (arg === '--timeout-ms' && next) {
      opts.timeoutMs = positiveInt(next, 25_000, 60_000);
      i += 1;
    }
  }
  return opts;
}

function monthsAgo(months, now = new Date()) {
  const date = new Date(now.getTime());
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostOk(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  return host === 'coingeek.com' || host === 'www.coingeek.com';
}

class Budget {
  constructor(max, intervalMs) {
    this.max = max;
    this.intervalMs = intervalMs;
    this.count = 0;
    this.nextAt = 0;
  }

  async take() {
    if (this.count >= this.max) throw new CapError(`request cap ${this.max} reached`);
    const wait = this.nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    this.count += 1;
    this.nextAt = Date.now() + this.intervalMs;
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

async function request(ctx, url, accept, { ignoreRobots = false } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !hostOk(target.hostname)) {
    throw new Error(`refusing ${url}`);
  }
  if (!ignoreRobots && !pathAllowed(ctx.robots, UA, target.pathname)) {
    throw new Error(`robots.txt disallows ${target.pathname}`);
  }
  let lastErr = new Error(`failed ${url}`);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await ctx.budget.take();
    try {
      const res = await fetch(target, {
        headers: {
          'User-Agent': UA,
          Accept: accept,
          'Accept-Language': 'en-GB,en;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(ctx.timeoutMs),
      });
      const finalUrl = new URL(res.url || target);
      if (!hostOk(finalUrl.hostname) || (!ignoreRobots && !pathAllowed(ctx.robots, UA, finalUrl.pathname))) {
        throw new Error(`redirected to a disallowed URL ${finalUrl.href}`);
      }
      if (res.status === 429 || res.status >= 500) {
        const backoff = Math.min(30_000, parseRetryAfter(res.headers.get('retry-after')) ?? 1000 * 2 ** attempt);
        console.warn(`[news] HTTP ${res.status} ${target.pathname} — retry in ${backoff}ms`);
        await sleep(backoff);
        lastErr = new Error(`HTTP ${res.status} ${target.pathname}`);
        continue;
      }
      return res;
    } catch (err) {
      if (err instanceof CapError || err?.code === 'CAP') throw err;
      if (err?.message?.startsWith('redirected') || err?.message?.startsWith('refusing') || err?.message?.startsWith('robots.txt')) {
        throw err;
      }
      lastErr = err instanceof Error ? err : new Error(String(err));
      const backoff = Math.min(30_000, 1000 * 2 ** attempt);
      console.warn(`[news] ${lastErr.message} — retry in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function cleanTerms(list, max = 24) {
  const out = [];
  const seen = new Set();
  for (const raw of list ?? []) {
    const name = htmlToPlainText(raw).replace(/\s+/g, ' ').trim();
    if (!name || name.length > 80 || /^uncategorized$/i.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const raw of value) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) ids.push(id);
  }
  return ids;
}

/** Category and tag names for numeric ids. Unknown ids and "Uncategorized" are dropped. */
export function termNames(ids, lookup, max = 24) {
  const raw = [];
  for (const id of ids ?? []) {
    const name = lookup?.get?.(Number(id));
    if (typeof name === 'string' && name.trim()) raw.push(name);
  }
  return cleanTerms(raw, max);
}

function rendered(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.rendered === 'string') return value.rendered;
  return '';
}

function termsFrom(post) {
  const groups = post?._embedded?.['wp:term'];
  const categories = [];
  const tags = [];
  if (!Array.isArray(groups)) return { categories, tags };
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const term of group) {
      const name = term?.name;
      if (!name) continue;
      if (term.taxonomy === 'category') categories.push(name);
      else if (term.taxonomy === 'post_tag') tags.push(name);
    }
  }
  return { categories: cleanTerms(categories, 12), tags: cleanTerms(tags, 24) };
}

function slugFromUrl(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return (path.split('/').filter(Boolean).pop() ?? '').slice(0, 180);
  } catch {
    return '';
  }
}

function articleItem({ id, url, title, date, modified, categories, tags, excerpt }) {
  const item = { id, url, title, date, excerpt };
  if (modified) item.modified = modified;
  if (categories?.length) item.categories = categories;
  if (tags?.length) item.tags = tags;
  return item;
}

function postToItem(post, cutoffMs) {
  if (post?.id === undefined || post?.id === null) return null;
  const url = canonicalUrl(String(post.link ?? ''));
  if (!url.startsWith('https://coingeek.com/')) return null;
  const date = toIso(post.date_gmt || post.date);
  if (!date || Date.parse(date) < cutoffMs) return null;
  const title = clipTitle(rendered(post.title));
  const excerpt = clipExcerpt(rendered(post.excerpt));
  if (!title || !excerpt) return null;
  const modified = toIso(post.modified_gmt || post.modified);
  const embedded = termsFrom(post);
  return {
    item: articleItem({
      id: `coingeek-${post.id}`,
      url,
      title,
      date,
      modified,
      categories: embedded.categories,
      tags: embedded.tags,
      excerpt,
    }),
    // Names already in the payload (RSS-style embed) need no second lookup.
    categoryIds: embedded.categories.length ? [] : idList(post.categories),
    tagIds: embedded.tags.length ? [] : idList(post.tags),
  };
}

export function rssEntryToItem(entry, cutoffMs) {
  const url = canonicalUrl(entry?.link ?? '');
  if (!url.startsWith('https://coingeek.com/')) return null;
  const date = toIso(entry.pubDate);
  if (!date || (cutoffMs !== undefined && Date.parse(date) < cutoffMs)) return null;
  const title = clipTitle(entry.title);
  const excerpt = clipExcerpt(entry.description);
  if (!title || !excerpt) return null;
  const slug = slugFromUrl(url);
  return articleItem({
    id: `coingeek-${slug || 'item'}`,
    url,
    title,
    date,
    categories: cleanTerms(entry.categories, 12),
    tags: cleanTerms(entry.tags, 24),
    excerpt,
  });
}

async function readHead(res, maxBytes = 96_000) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(text)) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The body is already closed.
    }
  }
  return text;
}

function readExisting(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    console.warn(`[news] existing file could not be read (${err instanceof Error ? err.message : err}); merging onto nothing`);
    return [];
  }
}

function writeSnapshot(out, body) {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, body);
  try {
    renameSync(tmp, out);
  } catch {
    try {
      unlinkSync(out);
    } catch {
      // First snapshot.
    }
    try {
      renameSync(tmp, out);
    } catch {
      writeFileSync(out, body);
      try {
        unlinkSync(tmp);
      } catch {
        // The temp file is a duplicate of what was just written.
      }
    }
  }
}

async function readJsonList(res) {
  const rows = JSON.parse(await res.text());
  return Array.isArray(rows) ? rows : null;
}

async function lookupCategories(ctx) {
  const names = new Map();
  const path = '/wp-json/wp/v2/categories';
  if (!pathAllowed(ctx.robots, UA, path)) return names;
  let page = 1;
  for (;;) {
    const url = new URL(path, ORIGIN);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    url.searchParams.set('_fields', 'id,name');
    let res;
    try {
      res = await request(ctx, url, 'application/json');
    } catch (err) {
      if (!(err instanceof CapError)) console.warn(`[news] category names stopped: ${err.message}`);
      return names;
    }
    if (!res.ok) return names;
    const rows = await readJsonList(res);
    if (!rows?.length) return names;
    for (const row of rows) {
      if (row?.id && row?.name) names.set(Number(row.id), String(row.name));
    }
    const pages = Number(res.headers.get('x-wp-totalpages'));
    if (!Number.isFinite(pages) || page >= pages) return names;
    page += 1;
  }
}

async function lookupTags(ctx, ids) {
  const names = new Map();
  const path = '/wp-json/wp/v2/tags';
  if (!pathAllowed(ctx.robots, UA, path)) return names;
  const pending = [...ids];
  for (let i = 0; i < pending.length; i += 100) {
    const url = new URL(path, ORIGIN);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('include', pending.slice(i, i + 100).join(','));
    url.searchParams.set('_fields', 'id,name');
    try {
      const res = await request(ctx, url, 'application/json');
      if (!res.ok) continue;
      const rows = await readJsonList(res);
      if (!rows) continue;
      for (const row of rows) {
        if (row?.id && row?.name) names.set(Number(row.id), String(row.name));
      }
    } catch (err) {
      if (!(err instanceof CapError)) console.warn(`[news] tag names stopped: ${err.message}`);
      return names;
    }
  }
  return names;
}

async function withTermNames(ctx, rows) {
  const categoryIds = new Set();
  const tagIds = new Set();
  for (const row of rows) {
    for (const id of row.categoryIds) categoryIds.add(id);
    for (const id of row.tagIds) tagIds.add(id);
  }
  if (categoryIds.size || tagIds.size) {
    console.log(`[news] resolving ${categoryIds.size} categories and ${tagIds.size} tags`);
  }
  const categories = categoryIds.size ? await lookupCategories(ctx) : new Map();
  const tags = tagIds.size ? await lookupTags(ctx, tagIds) : new Map();
  return rows.map((row) => {
    const categoriesNamed = row.item.categories?.length
      ? row.item.categories
      : termNames(row.categoryIds, categories, 12);
    const tagsNamed = row.item.tags?.length ? row.item.tags : termNames(row.tagIds, tags, 24);
    return articleItem({ ...row.item, categories: categoriesNamed, tags: tagsNamed });
  });
}

async function fetchRest(ctx, cutoff) {
  const rows = [];
  const cutoffMs = cutoff.getTime();
  let totalPages = Infinity;
  let lastFirstId;
  async function finish(complete) {
    return { items: await withTermNames(ctx, rows), complete };
  }
  for (let page = 1; page <= totalPages; page += 1) {
    const url = new URL('/wp-json/wp/v2/posts', ORIGIN);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    url.searchParams.set('orderby', 'date');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('after', new Date(cutoffMs - 24 * 60 * 60 * 1000).toISOString());
    // Ids only. Embedding terms also pulls _links, which made each page several times slower.
    url.searchParams.set('_fields', 'id,date,date_gmt,modified,modified_gmt,link,title,excerpt,slug,categories,tags');
    let res;
    try {
      res = await request(ctx, url, 'application/json');
    } catch (err) {
      if (page === 1) throw err;
      console.warn(`[news] REST stopped at page ${page}: ${err.message}`);
      return finish(false);
    }
    if (res.status === 400) {
      if (page === 1) throw new Error('REST rejected the first page');
      return finish(true);
    }
    if (!res.ok) {
      if (page === 1) throw new Error(`REST HTTP ${res.status}`);
      return finish(false);
    }
    const headerPages = Number(res.headers.get('x-wp-totalpages'));
    if (Number.isFinite(headerPages) && headerPages > 0) totalPages = headerPages;
    let posts;
    try {
      posts = JSON.parse(await res.text());
    } catch {
      if (page === 1) throw new Error('REST did not return JSON');
      return finish(false);
    }
    if (!Array.isArray(posts)) {
      if (page === 1) throw new Error('REST payload was not a list');
      return finish(false);
    }
    if (posts.length === 0) return finish(true);
    const firstId = posts[0]?.id;
    if (firstId !== undefined && firstId === lastFirstId) return finish(false);
    lastFirstId = firstId;
    for (const post of posts) {
      const built = postToItem(post, cutoffMs);
      if (built) rows.push(built);
    }
    const totalLabel = Number.isFinite(totalPages) ? totalPages : '?';
    console.log(`[news] REST page ${page}/${totalLabel} — ${rows.length} articles`);
  }
  return finish(true);
}

async function fetchFallback(ctx, cutoff) {
  const items = [];
  const seen = new Set();
  const cutoffMs = cutoff.getTime();
  let complete = true;

  function push(item) {
    if (!item || seen.has(item.url)) return;
    seen.add(item.url);
    items.push(item);
  }

  if (pathAllowed(ctx.robots, UA, '/feed/')) {
    try {
      const res = await request(ctx, `${ORIGIN}/feed/`, 'application/rss+xml, application/xml, text/xml;q=0.9');
      if (res.ok) {
        for (const entry of parseRssItems(await res.text())) push(rssEntryToItem(entry, cutoffMs));
        console.log(`[news] RSS contributed ${items.length} articles`);
      } else {
        complete = false;
      }
    } catch (err) {
      if (err instanceof CapError) return { items, complete: false };
      console.warn(`[news] RSS failed: ${err.message}`);
      complete = false;
    }
  }

  if (!pathAllowed(ctx.robots, UA, '/sitemap_index.xml')) return { items, complete: false };
  let children = [];
  try {
    const indexRes = await request(ctx, `${ORIGIN}/sitemap_index.xml`, 'application/xml, text/xml');
    if (!indexRes.ok) return { items, complete: false };
    children = parseSitemapLocs(await indexRes.text()).filter((entry) => /post-sitemap/i.test(entry.loc));
  } catch (err) {
    if (err instanceof CapError) return { items, complete: false };
    console.warn(`[news] sitemap index failed: ${err.message}`);
    return { items, complete: false };
  }

  for (const child of children) {
    if (child.lastmod && !Number.isNaN(Date.parse(child.lastmod)) && Date.parse(child.lastmod) < cutoffMs) continue;
    let urls = [];
    try {
      const childRes = await request(ctx, child.loc, 'application/xml, text/xml');
      if (!childRes.ok) {
        complete = false;
        continue;
      }
      urls = parseSitemapLocs(await childRes.text());
    } catch (err) {
      if (err instanceof CapError) return { items, complete: false };
      complete = false;
      continue;
    }
    for (const entry of urls) {
      const when = Date.parse(entry.lastmod || '');
      if (!entry.lastmod || Number.isNaN(when) || when < cutoffMs) continue;
      const url = canonicalUrl(entry.loc);
      if (seen.has(url) || !url.startsWith('https://coingeek.com/')) continue;
      let path = '/';
      try {
        path = new URL(url).pathname;
      } catch {
        continue;
      }
      if (/^\/(?:category|tag|author|page)\//i.test(path)) continue;
      if (!pathAllowed(ctx.robots, UA, path)) continue;
      try {
        const pageRes = await request(ctx, url, 'text/html');
        if (!pageRes.ok) {
          complete = false;
          continue;
        }
        const head = await readHead(pageRes);
        const description = metaDescription(head);
        push(rssEntryToItem({
          title: headTitle(head) || slugFromUrl(url).replace(/-/g, ' '),
          link: url,
          pubDate: entry.lastmod,
          description,
          categories: [],
          tags: [],
        }, cutoffMs));
      } catch (err) {
        if (err instanceof CapError) return { items, complete: false };
        complete = false;
      }
    }
  }
  return { items, complete };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cutoff = monthsAgo(opts.months);
  console.log(`[news] fetching CoinGeek back to ${cutoff.toISOString()} (${opts.months} months)`);

  const probeBudget = new Budget(opts.maxRequests, 1000);
  let robots = parseRobots(BASELINE_ROBOTS);
  try {
    const res = await request(
      { robots, budget: probeBudget, timeoutMs: opts.timeoutMs },
      `${ORIGIN}/robots.txt`,
      'text/plain',
      { ignoreRobots: true },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    robots = parseRobots(await res.text());
    const disallowed = robots.flatMap((group) => group.rules.filter((rule) => rule.type === 'disallow' && rule.path).map((rule) => rule.path));
    console.log(`[news] robots.txt disallow: ${disallowed.join(', ') || '(none)'}`);
  } catch (err) {
    console.warn(`[news] robots.txt unavailable (${err.message}); using Disallow: /wp-admin/`);
    robots = parseRobots(BASELINE_ROBOTS);
  }

  const intervalMs = Math.max(1000, Math.min(15_000, (crawlDelaySeconds(robots, UA) || 1) * 1000));
  const ctx = { robots, budget: probeBudget, timeoutMs: opts.timeoutMs };
  ctx.budget.intervalMs = intervalMs;

  let method = 'wp-rest';
  let result;
  if (!pathAllowed(robots, UA, '/wp-json/wp/v2/posts')) {
    console.warn('[news] robots.txt disallows the REST API; using RSS and the sitemap');
    method = 'rss-sitemap';
    result = await fetchFallback(ctx, cutoff);
  } else {
    try {
      result = await fetchRest(ctx, cutoff);
    } catch (err) {
      console.warn(`[news] REST unavailable (${err.message}). Falling back to RSS and the sitemap.`);
      method = 'rss-sitemap';
      result = await fetchFallback(ctx, cutoff);
    }
  }

  if (!result.items.length && method === 'wp-rest') {
    console.warn('[news] REST returned no articles in range. Falling back to RSS and the sitemap.');
    method = 'rss-sitemap';
    result = await fetchFallback(ctx, cutoff);
  }
  if (!result.items.length) {
    console.error('[news] fetched no articles; leaving any existing file untouched');
    process.exit(1);
  }

  const newestMs = result.items.reduce((max, item) => Math.max(max, Date.parse(item.date) || 0), Date.now());
  const merged = mergeNewsItems(readExisting(opts.out), result.items, {
    from: cutoff.toISOString(),
    to: new Date(newestMs).toISOString(),
    complete: result.complete,
  });
  const dates = merged.map((item) => item.date).filter((date) => !Number.isNaN(Date.parse(date))).sort();
  const file = {
    pin: {
      source: `${ORIGIN}/`,
      fetchedAt: new Date().toISOString(),
      counts: { items: merged.length, fetched: result.items.length },
      oldest: dates[0] ?? null,
      newest: dates[dates.length - 1] ?? null,
      method,
      months: opts.months,
      complete: result.complete,
      requests: ctx.budget.count,
    },
    items: merged,
  };
  writeSnapshot(opts.out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(
    `[news] wrote ${opts.out} — ${merged.length} articles (${result.items.length} fetched, ${method}, ${result.complete ? 'complete' : 'partial'}), ${dates[0] ?? '?'} → ${dates[dates.length - 1] ?? '?'}, ${ctx.budget.count} requests`,
  );
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(`[news] failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
