/**
 * In-memory LRU answer cache. Identical questions (notably the four suggested ones)
 * are answered once per TTL window instead of once per visitor, stretching the shared
 * free daily quota. Restart-safe to lose: quotas reset daily anyway.
 */

export interface CachedCitation {
  label: string;
  url?: string;
  title?: string;
  excerpt?: string;
  date?: string;
  sourceClass?: 'satoshi-primary' | 'spec' | 'later-commentary' | 'historical-record' | 'news' | 'directory';
}

export interface CachedAnswer {
  text: string;
  mode: 'mcp' | 'corpus' | 'reference';
  citations: CachedCitation[];
  /**
   * Clickable next questions derived from the citations. When a legacy entry has
   * none, the caller recomputes them from `citations` (title and sourceClass).
   */
  followUps?: string[];
}

/**
 * Whether an answer may be stored under, and served from, the question-keyed cache.
 * The key is the question alone. A request that sets depth changes wording, so it
 * bypasses the cache on both the read and the write and leaves the default-depth entry alone.
 */
export function shouldCacheAnswer(input: {
  standalone: boolean;
  hasImage: boolean;
  contested: boolean;
  depth?: string;
}): boolean {
  return input.standalone && !input.hasImage && !input.contested && !input.depth;
}

export class AnswerCache {
  private readonly map = new Map<string, { value: CachedAnswer; ts: number }>();

  constructor(
    private readonly max = 200,
    private readonly ttlMs = 6 * 3_600_000,
  ) {}

  /** Normalise so "What is SPV?" and "what  is  spv" share an entry. */
  static key(question: string): string {
    return question
      .toLowerCase()
      .trim()
      .replace(/[?!.,;:'"’‘“”]/g, '')
      .replace(/\s+/g, ' ');
  }

  get(question: string): CachedAnswer | undefined {
    const key = AnswerCache.key(question);
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // LRU touch.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(question: string, value: CachedAnswer): void {
    const key = AnswerCache.key(question);
    this.map.delete(key);
    this.map.set(key, { value, ts: Date.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
