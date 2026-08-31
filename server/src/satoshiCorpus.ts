/**
 * Fallback knowledge: Satoshi Nakamoto's actual forum posts and e-mails, pinned at
 * build time from the Nakamoto Institute archive into data/satoshi-corpus.json.
 * Retrieval is local BM25 (minisearch) — no network access at runtime.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import MiniSearch from 'minisearch';
import { htmlToText, stripQuotedReplies } from './htmlText.js';

export interface CorpusDoc {
  id: string;
  kind: 'email' | 'post' | 'quote';
  title: string;
  date: string;
  url: string;
  text: string;
}

export interface CorpusFile {
  pin: {
    repo: string;
    commit: string;
    fetchedAt: string;
    counts: { emails: number; posts: number; quotes: number };
    privateEmails?: {
      malmi: number;
      hearn: number;
      finney: number;
      weidai: number;
      total: number;
    };
  };
  documents: CorpusDoc[];
}

/** Minimum BM25 score to treat a hit as relevant; below this we fail closed. */
const MIN_SCORE = 2;

/**
 * Terms that carry no retrieval signal for this corpus. Without filtering, a natural
 * question like "Was the block size always meant to be small?" scores mostly on
 * "was"/"the"/"always" — every post matches, scores compress, and a thread titled
 * "Always pay transaction fee?" outranks the actual block-size-limit thread. Standard
 * English stop words plus question-frame words (always/meant/intended…) that describe
 * the asker's phrasing rather than the subject matter.
 */
const STOP_WORDS = new Set(
  (
    'a,an,and,are,as,at,be,been,but,by,for,from,had,has,have,he,her,his,how,i,if,in,into,is,it,its,' +
    'me,my,not,of,on,or,so,that,the,their,them,they,this,to,was,we,were,what,when,which,who,why,will,' +
    'with,you,your,do,does,did,can,could,should,would,there,here,than,then,too,very,just,about,again,' +
    'once,such,no,nor,only,own,same,some,any,all,each,other,more,most,much,many,up,down,out,off,am,' +
    'always,meant,mean,means,intended,intend,supposed,really,actually,original,originally,ever,never,' +
    'still,even,say,said,tell,told,know,known,want,wanted,like,may,might,must,shall,thing,things,way,' +
    'make,made,take,get,got'
  ).split(','),
);

/** Lowercase (MiniSearch's default) plus stop-word and stray-single-letter removal. */
function processTerm(term: string): string | null {
  const t = term.toLowerCase();
  if (STOP_WORDS.has(t)) return null;
  if (t.length === 1 && !/\d/.test(t)) return null;
  return t;
}

export class SatoshiCorpus {
  private readonly mini: MiniSearch<CorpusDoc>;

  constructor(documents: CorpusDoc[]) {
    // Normalise at ingest: the pinned archive stores posts as raw HTML, which would
    // otherwise pollute the index with tag tokens and leak into excerpts shown to
    // the user (the client renders markdown with raw HTML disabled). Quoted replies
    // are cut first — the corpus is Satoshi's voice only, and other users' words must
    // neither be indexed as his nor shown as his in citations.
    const cleaned = documents.map((d) => ({
      ...d,
      title: htmlToText(d.title),
      text: htmlToText(stripQuotedReplies(d.text)),
    }));
    this.mini = new MiniSearch<CorpusDoc>({
      fields: ['title', 'text'],
      storeFields: ['id', 'kind', 'title', 'date', 'url', 'text'],
      processTerm,
      searchOptions: {
        // The corpus's strongest signal is the thread title; body text is noisy.
        boost: { title: 3 },
        prefix: true,
        fuzzy: 0.1,
      },
    });
    this.mini.addAll(cleaned);
  }

  search(question: string, limit = 3): CorpusDoc[] {
    const hits = this.mini.search(question);
    const top = hits[0]?.score ?? 0;
    return hits
      .filter((h) => h.score >= Math.max(MIN_SCORE, top * 0.25))
      .slice(0, limit)
      .map((h) => ({
        id: String(h.id),
        kind: h.kind as CorpusDoc['kind'],
        title: String(h.title),
        date: String(h.date),
        url: String(h.url),
        text: String(h.text),
      }));
  }
}

/**
 * Load the pinned corpus; returns null (fail-open to MCP-only) when it has not been built.
 * The default branch reads via a const assigned from a literal join() relative to this
 * module — the one pattern Vercel's file tracer (@vercel/nft) can resolve statically,
 * so the corpus JSON is bundled into the serverless function.
 */
export function loadCorpus(path?: string): SatoshiCorpus | null {
  let corpusPath: string;
  let raw: string;
  if (path) {
    corpusPath = path;
    if (!existsSync(corpusPath)) {
      console.warn(`[corpus] ${corpusPath} not found — run \`npm run fetch-corpus\`. Quote fallback disabled.`);
      return null;
    }
    raw = readFileSync(corpusPath, 'utf8');
  } else {
    corpusPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'satoshi-corpus.json');
    if (!existsSync(corpusPath)) {
      console.warn(`[corpus] ${corpusPath} not found — run \`npm run fetch-corpus\`. Quote fallback disabled.`);
      return null;
    }
    raw = readFileSync(corpusPath, 'utf8');
  }
  try {
    const parsed = JSON.parse(raw) as CorpusFile;
    if (!Array.isArray(parsed.documents) || parsed.documents.length === 0) {
      console.warn('[corpus] corpus file has no documents — quote fallback disabled.');
      return null;
    }
    console.log(
      `[corpus] loaded ${parsed.documents.length} documents (pin ${parsed.pin?.commit?.slice(0, 7) ?? 'unknown'})`,
    );
    return new SatoshiCorpus(parsed.documents);
  } catch (err) {
    console.warn('[corpus] failed to parse corpus file:', err instanceof Error ? err.message : err);
    return null;
  }
}
