/**
 * Read-only activity series: forum posts and emails from pinned corpora,
 * without quotes. Each subject's JSON is static, so the parsed payload is
 * cached per subject for the process lifetime.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CorpusDoc, CorpusFile } from './satoshiCorpus.js';

export type SubjectId = 'satoshi' | 'wright' | 'kleiman';

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

export interface SubjectActivity {
  id: SubjectId;
  label: string;
  total: number;
  byKind: { emails: number; posts: number };
  points: SatoshiActivityPoint[];
}

export interface ActivityResponse {
  generatedAt: string;
  subjects: SubjectActivity[];
}

const SUBJECTS: readonly { id: SubjectId; label: string; file: string }[] = [
  { id: 'satoshi', label: 'Satoshi Nakamoto', file: 'satoshi-corpus.json' },
  { id: 'wright', label: 'Craig Wright', file: 'wright-activity.json' },
  { id: 'kleiman', label: 'Dave Kleiman', file: 'kleiman-activity.json' },
];

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

interface CachedSubject {
  activity: SatoshiActivity;
  subject: SubjectActivity;
}

const cache = new Map<SubjectId, CachedSubject>();

function dataDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
}

function readActivityFile(fileName: string): SatoshiActivity {
  const corpusPath = join(dataDir(), fileName);
  if (!existsSync(corpusPath)) {
    return buildSatoshiActivity([]);
  }

  try {
    const parsed = JSON.parse(readFileSync(corpusPath, 'utf8')) as CorpusFile;
    return buildSatoshiActivity(Array.isArray(parsed.documents) ? parsed.documents : []);
  } catch (err) {
    console.warn('[activity] failed to parse corpus file:', err instanceof Error ? err.message : err);
    return buildSatoshiActivity([]);
  }
}

function loadSubject(id: SubjectId): CachedSubject {
  const hit = cache.get(id);
  if (hit) return hit;

  const meta = SUBJECTS.find((s) => s.id === id);
  if (!meta) {
    throw new Error(`Unknown activity subject: ${id}`);
  }

  const activity = readActivityFile(meta.file);
  const subject: SubjectActivity = {
    id: meta.id,
    label: meta.label,
    total: activity.total,
    byKind: activity.byKind,
    points: activity.points,
  };
  const entry = { activity, subject };
  cache.set(id, entry);
  return entry;
}

/** Backward-compatible: Satoshi's activity only, same shape as before. */
export function getSatoshiActivity(): SatoshiActivity {
  return loadSubject('satoshi').activity;
}

export function getActivity(): ActivityResponse {
  return {
    generatedAt: new Date().toISOString(),
    subjects: SUBJECTS.map((s) => loadSubject(s.id).subject),
  };
}
