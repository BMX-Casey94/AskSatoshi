/**
 * In-memory LRU answer cache. Identical questions (notably the four suggested ones)
 * are answered once per TTL window instead of once per visitor, stretching the shared
 * free daily quota. Restart-safe to lose: quotas reset daily anyway.
 */

export interface CachedAnswer {
  text: string;
  mode: 'mcp' | 'corpus' | 'reference';
  citations: { label: string; url?: string }[];
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
