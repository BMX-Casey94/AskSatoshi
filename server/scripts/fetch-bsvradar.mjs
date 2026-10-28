/**
 * Pins the BSV Radar catalogue into data/bsvradar-apps.json.
 *
 * One documented feed: https://bsvradar.com/llms-full.txt. Robots.txt is fetched
 * first. /api/ is never called (robots disallows it, and this script refuses it
 * even if a later robots.txt allows it). At most one request per second, a hard
 * cap of three requests, and the existing file is left in place if the feed
 * cannot be parsed.
 *
 * The model must not browse the live web. Re-run this script to refresh, then
 * review the diff before committing.
 *
 * Usage:
 *   node scripts/fetch-bsvradar.mjs [--out path] [--timeout-ms 25000]
 */

import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USER_AGENT =
  'AskSatoshi-CatalogueIndexer/1.0 (+https://github.com/BMX-Casey94/AskSatoshi; purpose=directory-snapshot)';

export const FEED_URL = 'https://bsvradar.com/llms-full.txt';

/** Exact sentence carried on every catalogue answer. Keep in sync with server/src/bsvRadar.ts. */
export const CATALOGUE_CAVEAT =
  'BSV Radar is a partial, community catalogue; listing is not endorsement; status may be out of date.';

const ORIGIN = 'https://bsvradar.com';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bsvradar-apps.json');
const MAX_REQUESTS = 3;
const INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_BODY_CHARS = 2_000_000;

const KNOWN_KEYS = new Set([
  'url',
  'category',
  'rating',
  'upvotes',
  'platforms',
  'bsv capabilities',
  'website',
  'last updated',
  'description',
  'languages',
  'maturity',
  'license',
  'maintainer',
  'repo',
  'docs',
  'version',
  'apps',
  'blocks',
]);

class CapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CapError';
    this.code = 'CAP';
  }
}

function positiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function parseArgs(argv) {
  const opts = { out: OUT, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--out' && next) {
      opts.out = next;
      i += 1;
    } else if (arg === '--timeout-ms' && next) {
      opts.timeoutMs = positiveInt(next, DEFAULT_TIMEOUT_MS, 60_000);
      i += 1;
    }
  }
  return opts;
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

/** Live robots rules, plus a hard block on /api/ even if a later robots.txt allows it. */
export function pathAllowed(groups, userAgent, pathname) {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (path === '/api' || path.startsWith('/api/')) return false;
  return robotsAllows(groups, userAgent, path);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostOk(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  return host === 'bsvradar.com' || host === 'www.bsvradar.com';
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

async function request(ctx, url, { ignoreRobots = false } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !hostOk(target.hostname)) {
    throw new Error(`refusing ${url}`);
  }
  if (!ignoreRobots && !pathAllowed(ctx.robots, USER_AGENT, target.pathname)) {
    throw new Error(`robots.txt disallows ${target.pathname}`);
  }
  let lastErr = new Error(`failed ${url}`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await ctx.budget.take();
    try {
      const res = await fetch(target, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/plain, text/plain;q=0.9',
          'Accept-Language': 'en-GB,en;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(ctx.timeoutMs),
      });
      const finalUrl = new URL(res.url || target);
      if (!hostOk(finalUrl.hostname) || (!ignoreRobots && !pathAllowed(ctx.robots, USER_AGENT, finalUrl.pathname))) {
        throw new Error(`redirected to a disallowed URL ${finalUrl.href}`);
      }
      if (res.status === 429 || res.status >= 500) {
        const backoff = Math.min(30_000, parseRetryAfter(res.headers.get('retry-after')) ?? 1000 * 2 ** attempt);
        console.warn(`[directory] HTTP ${res.status} ${target.pathname} — retry in ${backoff}ms`);
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
      console.warn(`[directory] ${lastErr.message} — retry in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/** A calendar day, or '' when the value is not a real YYYY-MM-DD. */
export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10) === value ? value : '';
}

/**
 * Website or repo URL. An existing http:// is kept. A missing scheme gets https://.
 * Any other scheme is dropped.
 */
export function normaliseExternalUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /[\s<>]/.test(raw)) return '';
  if (/^https:\/\//i.test(raw)) return raw;
  if (/^http:\/\//i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  return `https://${raw.replace(/^\/+/, '')}`;
}

function canonicalRadarUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.hostname !== 'bsvradar.com') return null;
    url.hash = '';
    url.search = '';
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const section = parts[0]?.toLowerCase();
    if (section !== 'apps' && section !== 'blocks' && section !== 'orgs') return null;
    let slug = '';
    try {
      slug = decodeURIComponent(parts[1] ?? '').trim().toLowerCase();
    } catch {
      return null;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,180}$/.test(slug)) return null;
    url.pathname = `/${section}/${slug}`;
    return { href: url.toString(), section, slug };
  } catch {
    return null;
  }
}

function splitList(value) {
  const out = [];
  const seen = new Set();
  for (const part of String(value ?? '').split(',')) {
    const name = part.trim();
    if (!name || name.length > 80) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 24) break;
  }
  return out;
}

function cleanLine(value, max) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const space = slice.lastIndexOf(' ');
  return (space >= 40 ? slice.slice(0, space) : slice).trim();
}

function countField(value) {
  if (!/^\d+$/.test(String(value ?? '').trim())) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : undefined;
}

function parseEntry(chunk) {
  const lines = chunk.split('\n');
  const name = cleanLine(lines[0] ?? '', 200);
  if (!name) return null;
  const fields = new Map();
  let key = '';
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      key = '';
      continue;
    }
    const match = /^([A-Za-z][A-Za-z ]{0,40}):\s*(.*)$/.exec(line);
    const candidate = match?.[1]?.toLowerCase() ?? '';
    if (match && KNOWN_KEYS.has(candidate)) {
      fields.set(candidate, match[2].trim());
      key = candidate;
      continue;
    }
    if (key === 'description') {
      fields.set('description', cleanLine(`${fields.get('description') ?? ''} ${line}`, 500));
    }
  }
  return { name, fields };
}

/**
 * Split llms-full.txt into live apps, building blocks and organisations.
 * Ratings and upvotes are dropped. An entry whose URL is not /apps/, /blocks/
 * or /orgs/ is skipped.
 */
export function parseLlmsFull(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const first = source.search(/^### /m);
  const preamble = first >= 0 ? source.slice(0, first) : source;
  const body = first >= 0 ? source.slice(first) : '';
  const dateMatch = /(?:^|\n)Last updated:\s*(\d{4}-\d{2}-\d{2})\b/.exec(preamble);
  const sourceFileDate = validDay(dateMatch?.[1] ?? '') || '';
  const items = [];
  const blocks = [];
  const organisations = [];
  const seen = { apps: new Set(), blocks: new Set(), orgs: new Set() };
  let skipped = 0;

  for (const chunk of body.split(/^### /m)) {
    if (!chunk.trim()) continue;
    const entry = parseEntry(chunk);
    if (!entry) {
      skipped += 1;
      continue;
    }
    const radar = canonicalRadarUrl(entry.fields.get('url') ?? '');
    if (!radar) {
      skipped += 1;
      continue;
    }
    const summary = cleanLine(entry.fields.get('description') ?? '', 500);
    const lastUpdated = validDay(entry.fields.get('last updated') ?? '');
    if (radar.section === 'apps') {
      if (seen.apps.has(radar.slug)) continue;
      seen.apps.add(radar.slug);
      const item = {
        id: radar.slug,
        name: entry.name,
        category: cleanLine(entry.fields.get('category') ?? '', 80),
        summary,
        radarUrl: radar.href,
        tags: splitList(entry.fields.get('bsv capabilities') ?? ''),
      };
      const url = normaliseExternalUrl(entry.fields.get('website') ?? '');
      if (url) item.url = url;
      const platform = cleanLine(entry.fields.get('platforms') ?? '', 40);
      if (platform) item.platform = platform;
      if (lastUpdated) item.lastUpdated = lastUpdated;
      items.push(item);
      continue;
    }
    if (radar.section === 'blocks') {
      if (seen.blocks.has(radar.slug)) continue;
      seen.blocks.add(radar.slug);
      const block = {
        id: radar.slug,
        name: entry.name,
        category: cleanLine(entry.fields.get('category') ?? '', 120),
        summary,
        radarUrl: radar.href,
        tags: splitList(entry.fields.get('languages') ?? ''),
      };
      const url = normaliseExternalUrl(entry.fields.get('repo') ?? '');
      if (url) block.url = url;
      const docs = normaliseExternalUrl(entry.fields.get('docs') ?? '');
      if (docs) block.docs = docs;
      const maturity = cleanLine(entry.fields.get('maturity') ?? '', 40);
      if (maturity) block.maturity = maturity;
      const license = cleanLine(entry.fields.get('license') ?? '', 80);
      if (license) block.license = license;
      const maintainer = cleanLine(entry.fields.get('maintainer') ?? '', 120);
      if (maintainer) block.maintainer = maintainer;
      const version = cleanLine(entry.fields.get('version') ?? '', 40);
      if (version) block.version = version;
      if (lastUpdated) block.lastUpdated = lastUpdated;
      blocks.push(block);
      continue;
    }
    if (seen.orgs.has(radar.slug)) continue;
    seen.orgs.add(radar.slug);
    const org = { id: radar.slug, name: entry.name, radarUrl: radar.href };
    const apps = countField(entry.fields.get('apps'));
    const blockCount = countField(entry.fields.get('blocks'));
    if (apps !== undefined) org.apps = apps;
    if (blockCount !== undefined) org.blocks = blockCount;
    organisations.push(org);
  }

  return { sourceFileDate, items, blocks, organisations, skipped };
}

/** Keep firstSeen for an id that is still listed. New ids use `day`. Ids that left the feed are dropped. */
export function applyFirstSeen(rows, previous, day) {
  const today = validDay(day);
  const kept = new Map();
  for (const row of previous ?? []) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const first = validDay(row.firstSeen);
    if (!id || !first) continue;
    if (today && first > today) continue;
    kept.set(id, first);
  }
  return (rows ?? []).map((row) => ({ ...row, firstSeen: kept.get(row.id) || today || day }));
}

export function buildSnapshot(parsed, { fetchedAt, previous } = {}) {
  const fetched = typeof fetchedAt === 'string' && !Number.isNaN(Date.parse(fetchedAt))
    ? new Date(fetchedAt).toISOString()
    : new Date().toISOString();
  const day = fetched.slice(0, 10);
  const categories = new Set((parsed?.items ?? []).map((item) => item.category).filter(Boolean));
  const prior = previous && typeof previous === 'object' ? previous : {};
  return {
    pin: {
      source: FEED_URL,
      sourceClass: 'directory',
      fetchedAt: fetched,
      sourceFileDate: parsed?.sourceFileDate || null,
      method: 'llms-full',
      counts: {
        apps: parsed?.items?.length ?? 0,
        categories: categories.size,
        blocks: parsed?.blocks?.length ?? 0,
        organisations: parsed?.organisations?.length ?? 0,
      },
      caveat: CATALOGUE_CAVEAT,
    },
    items: applyFirstSeen(parsed?.items ?? [], prior.items, day),
    blocks: applyFirstSeen(parsed?.blocks ?? [], prior.blocks, day),
    organisations: applyFirstSeen(parsed?.organisations ?? [], prior.organisations, day),
  };
}

function headerCounts(text) {
  const match = /Indexes\s+(\d+)\s+live apps[\s\S]*?(\d+)\s+building blocks[\s\S]*?(\d+)\s+organisations/i.exec(
    String(text ?? '').slice(0, 2500),
  );
  if (!match) return null;
  return { apps: Number(match[1]), blocks: Number(match[2]), organisations: Number(match[3]) };
}

function readPrevious(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      items: Array.isArray(parsed?.items) ? parsed.items : [],
      blocks: Array.isArray(parsed?.blocks) ? parsed.blocks : [],
      organisations: Array.isArray(parsed?.organisations) ? parsed.organisations : [],
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { items: [], blocks: [], organisations: [] };
    console.warn(
      `[directory] existing file could not be read (${err instanceof Error ? err.message : err}); first-seen dates start again`,
    );
    return { items: [], blocks: [], organisations: [] };
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

async function readBody(res) {
  const text = await res.text();
  if (text.length > MAX_BODY_CHARS) throw new Error(`response exceeded ${MAX_BODY_CHARS} characters`);
  return text;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const budget = new Budget(MAX_REQUESTS, INTERVAL_MS);
  const ctx = { robots: [], budget, timeoutMs: opts.timeoutMs };

  let robotsText = '';
  try {
    const res = await request(ctx, `${ORIGIN}/robots.txt`, { ignoreRobots: true });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    robotsText = await readBody(res);
    ctx.robots = parseRobots(robotsText);
  } catch (err) {
    console.error(`[directory] robots.txt unavailable (${err instanceof Error ? err.message : err}); not fetching the catalogue`);
    process.exit(1);
  }

  const disallowed = ctx.robots.flatMap((group) =>
    group.rules.filter((rule) => rule.type === 'disallow' && rule.path).map((rule) => rule.path),
  );
  console.log(`[directory] robots.txt disallow: ${[...new Set(disallowed)].join(', ') || '(none)'}`);
  if (!pathAllowed(ctx.robots, USER_AGENT, '/llms-full.txt')) {
    console.error('[directory] robots.txt disallows /llms-full.txt; leaving any existing file untouched');
    process.exit(1);
  }

  let feed = '';
  try {
    const res = await request(ctx, FEED_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    feed = await readBody(res);
  } catch (err) {
    console.error(`[directory] catalogue fetch failed (${err instanceof Error ? err.message : err}); leaving any existing file untouched`);
    process.exit(1);
  }

  if (!feed.includes('### ') || !feed.includes('bsvradar.com/apps/')) {
    console.error('[directory] response was not the llms-full.txt catalogue; leaving any existing file untouched');
    process.exit(1);
  }

  const parsed = parseLlmsFull(feed);
  if (parsed.items.length === 0) {
    console.error('[directory] parsed no live apps; leaving any existing file untouched');
    process.exit(1);
  }
  const expected = headerCounts(feed);
  if (expected && (
    expected.apps !== parsed.items.length
    || expected.blocks !== parsed.blocks.length
    || expected.organisations !== parsed.organisations.length
  )) {
    console.warn(
      `[directory] header says ${expected.apps} apps, ${expected.blocks} blocks, ${expected.organisations} organisations; parsed ${parsed.items.length}, ${parsed.blocks.length}, ${parsed.organisations.length}`,
    );
  }
  if (parsed.skipped > 0) {
    console.warn(`[directory] skipped ${parsed.skipped} entries that were not a clean app, block or organisation`);
  }

  const fetchedAt = new Date().toISOString();
  const file = buildSnapshot(parsed, { fetchedAt, previous: readPrevious(opts.out) });
  writeSnapshot(opts.out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(
    `[directory] wrote ${opts.out} — ${file.pin.counts.apps} apps, ${file.pin.counts.categories} categories, ${file.pin.counts.blocks} blocks, ${file.pin.counts.organisations} organisations, file date ${file.pin.sourceFileDate ?? 'unknown'}, ${ctx.budget.count} requests`,
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
    console.error(`[directory] failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
