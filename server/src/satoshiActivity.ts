/**
 * Read-only activity series: Satoshi's forum posts and emails from the pinned
 * corpus, without quotes. The JSON is static, so the parsed payload is cached
 * for the process lifetime.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CorpusDoc, CorpusFile } from './satoshiCorpus.js';

export interface SatoshiActivityPoint {
  date: string;
  kind: 'email' | 'post';
  title: string;
  url: string;
}

export interface SatoshiActivity {
  generatedAt: string;
  total: number;
  byKind: { emails: number; posts: number };
  points: SatoshiActivityPoint[];
}

export function buildSatoshiActivity(
  documents: CorpusDoc[],
  generatedAt = new Date().toISOString(),
): SatoshiActivity {
  let emails = 0;
  let posts = 0;
  const points: SatoshiActivityPoint[] = [];

  for (const doc of documents) {
    if (doc.kind === 'email') emails += 1;
    else if (doc.kind === 'post') posts += 1;
    else continue;

    points.push({
      date: doc.date,
      kind: doc.kind,
      title: doc.title,
      url: doc.url,
    });
  }

  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    generatedAt,
    total: points.length,
    byKind: { emails, posts },
    points,
  };
}

let cached: SatoshiActivity | null = null;

export function getSatoshiActivity(): SatoshiActivity {
  if (cached) return cached;

  const corpusPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'satoshi-corpus.json');
  if (!existsSync(corpusPath)) {
    cached = buildSatoshiActivity([]);
    return cached;
  }

  try {
    const parsed = JSON.parse(readFileSync(corpusPath, 'utf8')) as CorpusFile;
    cached = buildSatoshiActivity(Array.isArray(parsed.documents) ? parsed.documents : []);
    return cached;
  } catch (err) {
    console.warn('[activity] failed to parse corpus file:', err instanceof Error ? err.message : err);
    cached = buildSatoshiActivity([]);
    return cached;
  }
}
