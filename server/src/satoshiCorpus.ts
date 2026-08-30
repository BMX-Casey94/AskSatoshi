/**
 * Fallback knowledge: Satoshi Nakamoto's actual forum posts and e-mails, pinned at
 * build time from the Nakamoto Institute archive into data/satoshi-corpus.json.
 * Retrieval is local BM25 (minisearch) — no network access at runtime.
 */

import { existsSync, readFileSync } from 'node:fs';
import MiniSearch from 'minisearch';

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
  };
  documents: CorpusDoc[];
}

/** Minimum BM25 score to treat a hit as relevant; below this we fail closed. */
const MIN_SCORE = 2;

export class SatoshiCorpus {
  private readonly mini: MiniSearch<CorpusDoc>;

  constructor(documents: CorpusDoc[]) {
    this.mini = new MiniSearch<CorpusDoc>({
      fields: ['title', 'text'],
      storeFields: ['id', 'kind', 'title', 'date', 'url', 'text'],
      searchOptions: {
        boost: { title: 2 },
        prefix: true,
        fuzzy: 0.1,
      },
    });
    this.mini.addAll(documents);
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

/** Load the pinned corpus; returns null (fail-open to MCP-only) when it has not been built. */
export function loadCorpus(path: string): SatoshiCorpus | null {
  if (!existsSync(path)) {
    console.warn(`[corpus] ${path} not found — run \`npm run fetch-corpus\`. Quote fallback disabled.`);
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CorpusFile;
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
