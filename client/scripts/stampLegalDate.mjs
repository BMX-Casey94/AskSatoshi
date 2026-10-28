/**
 * Keeps the Terms & Privacy date in step with the legal copy.
 *
 * The August 2026 baseline is the copy after later edits were undone. Matching
 * that copy shows August. Any other copy, on the next dev server or production
 * build, shows that day's date and keeps it until the copy changes again.
 * Restoring the August copy puts August back.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pagePath = join(root, 'src/components/LegalPage.tsx');
const revPath = join(root, 'src/legalRevision.ts');

const START = '{/* legal-copy:start */}';
const END = '{/* legal-copy:end */}';
const BASELINE_LABEL = 'August 2026';

function field(name, src) {
  const match = new RegExp(`export const ${name} = '([^']*)'`).exec(src);
  if (!match) throw new Error(`legalRevision.ts is missing ${name}`);
  return match[1];
}

function revisionSource(baseline, copy, label) {
  return `/**
 * Date shown on Terms & Privacy. Written by scripts/stampLegalDate.mjs.
 * Do not edit the hashes by hand. Edit the legal copy, then run the client.
 */
export const LEGAL_BASELINE_SHA256 = '${baseline}';
export const LEGAL_COPY_SHA256 = '${copy}';
export const LEGAL_UPDATED_LABEL = '${label}';
`;
}

function todayLabel() {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/London',
  }).format(new Date());
}

export function stampLegalDate() {
  const page = readFileSync(pagePath, 'utf8');
  const start = page.indexOf(START);
  const end = page.indexOf(END);
  if (start < 0 || end < start) throw new Error('Legal page is missing the legal-copy markers');
  const copy = page.slice(start + START.length, end).replace(/\r\n/g, '\n').trim();
  const hash = createHash('sha256').update(copy).digest('hex');

  const current = readFileSync(revPath, 'utf8');
  const baselineField = field('LEGAL_BASELINE_SHA256', current);
  const recorded = field('LEGAL_COPY_SHA256', current);
  const label = field('LEGAL_UPDATED_LABEL', current);
  const baseline = /^[a-f0-9]{64}$/.test(baselineField) ? baselineField : hash;

  let nextLabel = label;
  let nextHash = recorded;
  if (hash === baseline) {
    nextLabel = BASELINE_LABEL;
    nextHash = baseline;
  } else if (hash !== recorded) {
    nextLabel = todayLabel();
    nextHash = hash;
  }

  const next = revisionSource(baseline, nextHash, nextLabel);
  if (next !== current.replace(/\r\n/g, '\n')) {
    writeFileSync(revPath, next);
    return true;
  }
  return false;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) stampLegalDate();
