/**
 * Fetch Satoshi-authored private emails from published archives (Malmi, Hearn,
 * Finney, Wei Dai). Recipient replies are discarded — only Satoshi's own words
 * enter the corpus.
 */

const MALMI_URL = 'https://mmalmi.github.io/satoshi/';
const HEARN_THREADS = [1, 2, 3, 4, 5].map(
  (n) => `https://plan99.net/~mike/satoshi-emails/thread${n}.html`,
);
const GITHUB_API = 'https://api.github.com/repos/lugaxker/nakamoto-archive/contents';
const FINNEY_DIR = `${GITHUB_API}/doc/hal-finney`;
const WEIDAI_DIR = `${GITHUB_API}/doc/wei-dai`;

const HEADERS = {
  'User-Agent': 'ask-satoshi-corpus-fetch',
  Accept: 'application/vnd.github+json',
};

const NAMED_ENTITIES = {
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

const BLOCK_TAGS =
  /<\/?(?:br|div|p|li|ul|ol|tr|td|th|table|thead|tbody|blockquote|pre|code|h[1-6]|hr)(?=[\s/>])[^>]*>/gi;
const INLINE_TAGS = /<\/?(?:a|b|i|u|em|strong|span|font|center|small|sub|sup|img|del|tt)(?=[\s/>])[^>]*>/gi;
const fromCode = (n) => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

function decodeEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_m, n) => fromCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => fromCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function htmlToText(text) {
  if (!/</.test(text) && !/&[a-z#]/i.test(text)) return String(text).replace(/\r/g, '').trim();
  return decodeEntities(
    String(text)
      .replace(/\r/g, '')
      .replace(BLOCK_TAGS, '\n')
      .replace(INLINE_TAGS, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Strip quoted parent lines; keep Satoshi's words. */
function cleanText(text) {
  const lines = String(text).split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>')) continue;
    if (/^\[Quoted text hidden\]/i.test(trimmed)) continue;
    kept.push(line);
  }
  return htmlToText(kept.join('\n').replace(/\n{3,}/g, '\n\n').trim());
}

/**
 * Best-effort parse of archive dates to a valid ISO 8601 string.
 * Gmail-style " at " is normalised; a missing timezone is treated as UTC.
 */
export function parseEmailDate(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  s = s.replace(/\s+at\s+/i, ' ');
  s = s.replace(/\s+\([^)]+\)\s*$/, '');
  if (!/(?:[+-]\d{2}:?\d{2}|GMT|UTC|Z|[A-Z]{3,4})\s*$/i.test(s)) s += ' UTC';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isSatoshiFromHeader(from) {
  const s = String(from);
  return /satoshi\s+nakamoto/i.test(s) || /satoshi@/i.test(s) || /satoshin@/i.test(s);
}

function isSatoshiHearnSender(name, email) {
  const n = String(name ?? '');
  const e = String(email ?? '').toLowerCase();
  if (/satoshi/i.test(n)) return true;
  return e.includes('satoshin@gmx') || e.includes('vistomail') || e.includes('anonymousspeech');
}

function toDoc({ id, title, date, url, text }) {
  const iso = parseEmailDate(date);
  const body = cleanText(text);
  if (!iso || body.length < 40) return null;
  return { id, kind: 'email', title: title || 'Untitled', date: iso, url, text: body };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

function headerValue(chunk, name) {
  const re = new RegExp(`<strong>${name}</strong>:\\s*([^<]+)`, 'i');
  const m = chunk.match(re);
  return m ? decodeEntities(m[1].trim()) : '';
}

async function fetchMalmi() {
  console.log('[private-emails] fetching Martti Malmi archive…');
  const html = await fetchText(MALMI_URL);
  const docs = [];
  const openRe = /<div\s+class="message satoshi"\s+id="(email-\d+)"/gi;
  let m;
  while ((m = openRe.exec(html)) !== null) {
    const anchor = m[1];
    const n = anchor.replace(/^email-/, '');
    const next = html.indexOf('<div class="message', m.index + m[0].length);
    const chunk = html.slice(m.index, next === -1 ? undefined : next);
    const pre = chunk.match(/<pre>([\s\S]*?)<\/pre>/i);
    const doc = toDoc({
      id: `email-private-malmi-${n}`,
      title: headerValue(chunk, 'Subject') || 'Untitled',
      date: headerValue(chunk, 'Date'),
      url: `${MALMI_URL}#${anchor}`,
      text: pre ? decodeEntities(pre[1]) : '',
    });
    if (doc) docs.push(doc);
  }
  console.log(`[private-emails] Malmi: ${docs.length} Satoshi messages`);
  return docs;
}

function hearnSubject(html) {
  const title = html.match(/<title>([^<]+)<\/title>/i);
  if (title) {
    const t = decodeEntities(title[1]).replace(/^Gmail\s*-\s*/i, '').trim();
    if (t) return t;
  }
  const heading = html.match(/<b>([^<]+)<\/b>/i);
  return heading ? decodeEntities(heading[1]).trim() : 'Untitled';
}

async function fetchHearn() {
  console.log('[private-emails] fetching Mike Hearn threads…');
  const docs = [];
  for (const url of HEARN_THREADS) {
    const thread = url.match(/thread(\d+)\.html$/i)?.[1] ?? '0';
    let html;
    try {
      html = await fetchText(url);
    } catch (err) {
      console.warn(`[private-emails] Hearn thread ${thread} skipped: ${err.message}`);
      continue;
    }
    const subject = hearnSubject(html);
    const parts = html.split(/<table\b[^>]*class="message"[^>]*>/i);
    let i = 0;
    for (const part of parts.slice(1)) {
      i += 1;
      const from = part.match(/<b>([^<]*)<\/b>\s*&lt;([^&]+)&gt;/i);
      if (!from) continue;
      const name = decodeEntities(from[1]).trim();
      const email = decodeEntities(from[2]).trim();
      if (!isSatoshiHearnSender(name, email)) continue;
      const dateM = part.match(/align\s*=\s*right[^>]*>\s*<font[^>]*>([^<]+)/i);
      const bodyOpen = part.match(
        /<div\s+style="overflow:\s*hidden[^"]*"[^>]*>\s*<font[^>]*>/i,
      );
      let body = '';
      if (bodyOpen) {
        const rest = part.slice(bodyOpen.index + bodyOpen[0].length);
        const end = rest.search(/<\/font>|<\/div>|<\/body>/i);
        body = end === -1 ? rest : rest.slice(0, end);
      }
      const doc = toDoc({
        id: `email-private-hearn-${thread}-${i}`,
        title: subject,
        date: dateM ? dateM[1].trim() : '',
        url,
        text: body,
      });
      if (doc) docs.push(doc);
    }
  }
  console.log(`[private-emails] Hearn: ${docs.length} Satoshi messages`);
  return docs;
}

function stripArchiveFooter(text) {
  return String(text)
    .replace(/\n---\s*\n[\s\S]*?(?:Source files?:|External link)[\s\S]*$/i, '')
    .trim();
}

const MD_HEADER_NAMES = new Set([
  'from',
  'date',
  'sent',
  'subject',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'message-id',
  'return-path',
  'delivered-to',
  'received',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'x-original-to',
  'x-mailer',
  'x-priority',
  'x-bogosity',
  'status',
  'attachments',
]);

function parseMarkdownEmail(raw) {
  const normalised = decodeEntities(
    String(raw)
      .replace(/\r/g, '')
      .replace(/\\>/g, '>')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/&nbsp;/gi, ' '),
  );
  const lines = normalised.split('\n');
  let i = 0;
  let heading = '';
  if (lines[0]?.startsWith('#')) {
    heading = lines[0].replace(/^#+\s*/, '').trim();
    i = 1;
  }

  const headers = {};
  let envelopeDate = '';
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const envelope = line.match(/^From\s+(\S+@\S+)(?:\s+(.*))?$/i);
    if (envelope && !/^From:/i.test(line)) {
      if (headers.from == null) headers.from = envelope[1];
      if (envelope[2]) envelopeDate = envelope[2].trim();
      continue;
    }
    const hm = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (hm && MD_HEADER_NAMES.has(hm[1].toLowerCase())) {
      const key = hm[1].toLowerCase();
      if (headers[key] == null) headers[key] = hm[2].trim();
      continue;
    }
    if (/^\s+\S/.test(line) && Object.keys(headers).length) continue;
    break;
  }

  const body = stripArchiveFooter(lines.slice(i).join('\n'));
  return {
    from: headers.from ?? '',
    date: headers.date || headers.sent || envelopeDate,
    subject: headers.subject || heading || 'Untitled',
    body,
  };
}

async function fetchGithubMarkdownDir(apiUrl, idPrefix, label) {
  console.log(`[private-emails] fetching ${label} archive…`);
  const listing = await fetchJson(apiUrl);
  if (!Array.isArray(listing)) throw new Error(`${label} listing was not an array`);
  const files = listing.filter((f) => f?.type === 'file' && /\.md$/i.test(f.name ?? ''));
  const docs = [];
  for (const file of files) {
    const rawUrl = file.download_url;
    if (!rawUrl) continue;
    let raw;
    try {
      raw = await fetchText(rawUrl);
    } catch (err) {
      console.warn(`[private-emails] ${label} ${file.name} skipped: ${err.message}`);
      continue;
    }
    const parsed = parseMarkdownEmail(raw);
    if (!isSatoshiFromHeader(parsed.from)) continue;
    const stem = String(file.name).replace(/\.md$/i, '');
    const doc = toDoc({
      id: `${idPrefix}-${stem}`,
      title: parsed.subject,
      date: parsed.date,
      url: file.html_url || rawUrl,
      text: parsed.body,
    });
    if (doc) docs.push(doc);
  }
  console.log(`[private-emails] ${label}: ${docs.length} Satoshi messages`);
  return docs;
}

export function countPrivateEmails(documents) {
  const malmi = documents.filter((d) => d.id.startsWith('email-private-malmi-')).length;
  const hearn = documents.filter((d) => d.id.startsWith('email-private-hearn-')).length;
  const finney = documents.filter((d) => d.id.startsWith('email-private-finney-')).length;
  const weidai = documents.filter((d) => d.id.startsWith('email-private-weidai-')).length;
  return { malmi, hearn, finney, weidai, total: malmi + hearn + finney + weidai };
}

export async function fetchPrivateEmails() {
  const malmi = await fetchMalmi();
  const hearn = await fetchHearn();
  const finney = await fetchGithubMarkdownDir(FINNEY_DIR, 'email-private-finney', 'Hal Finney');
  const weidai = await fetchGithubMarkdownDir(WEIDAI_DIR, 'email-private-weidai', 'Wei Dai');
  return [...malmi, ...hearn, ...finney, ...weidai];
}
