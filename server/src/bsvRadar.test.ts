import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyFirstSeen,
  buildSnapshot,
  CATALOGUE_CAVEAT as FETCH_CAVEAT,
  normaliseExternalUrl,
  parseLlmsFull,
  parseRobots,
  pathAllowed,
  USER_AGENT,
  validDay,
} from '../scripts/fetch-bsvradar.mjs';
import {
  BsvRadarDirectory,
  CATALOGUE_CAVEAT,
  directoryFetchedAt,
  loadBsvRadar,
  looksLikeAppDirectoryQuestion,
  type DirectoryHit,
} from './bsvRadar.js';

/**
 * Entries copied from llms-full.txt (fetched 28 October 2026), including the
 * preamble date line. Ratings and upvotes are in the source and must not be stored.
 */
const FIXTURE = `# BSV Radar — Complete Directory

> The authoritative directory for the Bitcoin SV (BSV) ecosystem. Indexes 181 live apps across 13 categories, 205 building blocks (SDKs / libraries / contract frameworks / dev tooling), and 42 organisations.

Last updated: 2026-10-28
Source: https://bsvradar.com
Sitemap: https://bsvradar.com/sitemap.xml

## About BSV Radar

BSV Radar is a public discovery directory for the Bitcoin SV ecosystem. It surfaces three distinct kinds of listing: end-user applications (Apps), developer-shaped primitives (Building Blocks), and the organisations behind them.

## Block explorers (11 apps)

### Bitails
URL: https://bsvradar.com/apps/bitails
Category: Block explorers
Rating: 5.0/5 from 2 reviews
Upvotes: 5
Platforms: Web
BSV capabilities: Developer tool, Professional
Website: bitails.io
Last updated: 2026-05-09
Description: Unlock BSV blockchain insights

### Nora
URL: https://bsvradar.com/apps/nora
Category: Block explorers
Rating: no reviews yet
Upvotes: 2
Platforms: Web
BSV capabilities: Time-sealing, Professional
Website: github.com/justin-case-studio/nora
Last updated: 2026-05-12
Description: Register files on the BSV blockchain

## Collectibles (10 apps)

### bitcoinisbsv(dot)com
URL: https://bsvradar.com/apps/bitcoinisbsvcom
Category: Collectibles
Rating: no reviews yet
Upvotes: 1
Platforms: Web
BSV capabilities: Accepts BSV, Professional
Website: http://www.bitcoinisbsv.com
Last updated: 2026-06-18

## Education (20 apps)

### SLictionary
URL: https://bsvradar.com/apps/slictionary
Category: Education
Rating: no reviews yet
Platforms: Web
Website: https://www.slictionary.com/
Last updated: 2026-06-12
Description: A crowd-sourced dictionary which algorithmically improves with time and usage, via ranking useful efficient definitions

## Wallets (25 apps)

### HandCash
URL: https://bsvradar.com/apps/handcash
Category: Wallets
Rating: 4.4/5 from 9 reviews
Upvotes: 19
Platforms: Web
BSV capabilities: Accepts BSV, Developer tool
Website: https://handcash.io
Last updated: 2026-05-29
Description: A user-friendly BSV wallet with social features

# Building Blocks (205 total)

Developer-shaped primitives — SDKs, libraries, smart-contract frameworks, wallet kits, indexers, and other components other builders compose into their stack. Each lists its languages, maturity, license, maintainer, and source repo.

## Core SDKs (24 blocks)

### SwiftBSV
URL: https://bsvradar.com/blocks/swiftbsv
Category: Core SDKs > BSV SDKs
Languages: Swift, Native Bitcoin Script
Maturity: production
License: MIT
Maintainer: Henry Hudson
Repo: https://github.com/henryhudson/SwiftBSV
Docs: https://github.com/henryhudson/SwiftBSV/blob/main/Documentation/swiftbsv.pdf
Upvotes: 3
Description: A pure‑Swift SDK for Bitcoin SV providing keys, addresses, HD wallets, transactions, scripts, signatures, encryption and SPV verification.

## Wallets & Identity (47 blocks)

### AGiD
URL: https://bsvradar.com/blocks/agid
Category: Wallets & Identity > Identity & Certifiers
Languages: TypeScript
Maturity: production
Description: Agentic Identity Framework for AI agents on BSV

# Organisations (42 total)

Studios, dev teams, and companies that maintain BSV apps and building blocks. Each org page surfaces verified members and the projects they contribute.

### BSV Association
URL: https://bsvradar.com/orgs/bsva
Apps: 5
Blocks: 102

### bOpen
URL: https://bsvradar.com/orgs/bopen
Blocks: 29

### ForgeChainOS
URL: https://bsvradar.com/orgs/forgechainos
`;

const ROBOTS = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin/
Disallow: /auth/
Disallow: /dashboard/
Disallow: /og
Disallow: /_next/
`;

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bsvradar-'));
  dirs.push(dir);
  return dir;
}

describe('parseLlmsFull', () => {
  const parsed = parseLlmsFull(FIXTURE);

  it('reads the catalogue date and keeps live apps, blocks and organisations apart', () => {
    expect(parsed.sourceFileDate).toBe('2026-10-28');
    expect(parsed.skipped).toBe(0);
    expect(parsed.items.map((item) => item.id)).toEqual([
      'bitails',
      'nora',
      'bitcoinisbsvcom',
      'slictionary',
      'handcash',
    ]);
    expect(parsed.blocks.map((item) => item.id)).toEqual(['swiftbsv', 'agid']);
    expect(parsed.organisations.map((item) => item.id)).toEqual(['bsva', 'bopen', 'forgechainos']);
    expect(parsed.items.some((item) => item.name.includes('public discovery directory'))).toBe(false);
  });

  it('keeps HandCash, a bare website, http://, and a missing description', () => {
    expect(parsed.items.find((item) => item.id === 'handcash')).toEqual({
      id: 'handcash',
      name: 'HandCash',
      category: 'Wallets',
      summary: 'A user-friendly BSV wallet with social features',
      url: 'https://handcash.io',
      radarUrl: 'https://bsvradar.com/apps/handcash',
      platform: 'Web',
      tags: ['Accepts BSV', 'Developer tool'],
      lastUpdated: '2026-05-29',
    });
    expect(parsed.items.find((item) => item.id === 'bitails')?.url).toBe('https://bitails.io');
    expect(parsed.items.find((item) => item.id === 'nora')?.url).toBe('https://github.com/justin-case-studio/nora');
    const bare = parsed.items.find((item) => item.id === 'bitcoinisbsvcom');
    expect(bare?.url).toBe('http://www.bitcoinisbsv.com');
    expect(bare?.summary).toBe('');
    expect(bare?.name).toBe('bitcoinisbsv(dot)com');
    const dictionary = parsed.items.find((item) => item.id === 'slictionary');
    expect(dictionary?.name).toBe('SLictionary');
    expect(dictionary?.tags).toEqual([]);
    expect(dictionary?.category).toBe('Education');
  });

  it('does not copy ratings or upvotes, and parses blocks and organisations that lack optional lines', () => {
    for (const row of [...parsed.items, ...parsed.blocks, ...parsed.organisations]) {
      expect(row).not.toHaveProperty('rating');
      expect(row).not.toHaveProperty('upvotes');
    }
    const swift = parsed.blocks.find((item) => item.id === 'swiftbsv');
    expect(swift?.url).toBe('https://github.com/henryhudson/SwiftBSV');
    expect(swift?.docs).toBe('https://github.com/henryhudson/SwiftBSV/blob/main/Documentation/swiftbsv.pdf');
    expect(swift?.maturity).toBe('production');
    expect(swift?.license).toBe('MIT');
    expect(swift?.maintainer).toBe('Henry Hudson');
    expect(swift?.tags).toEqual(['Swift', 'Native Bitcoin Script']);
    expect(swift?.summary).toContain('Swift SDK');
    expect(swift?.summary).toContain('SPV verification');
    const agid = parsed.blocks.find((item) => item.id === 'agid');
    expect(agid?.summary).toBe('Agentic Identity Framework for AI agents on BSV');
    expect(agid).not.toHaveProperty('url');
    expect(agid).not.toHaveProperty('license');
    expect(parsed.organisations.find((item) => item.id === 'bsva')).toMatchObject({ apps: 5, blocks: 102 });
    expect(parsed.organisations.find((item) => item.id === 'bopen')).toEqual({
      id: 'bopen',
      name: 'bOpen',
      radarUrl: 'https://bsvradar.com/orgs/bopen',
      blocks: 29,
    });
    expect(parsed.organisations.find((item) => item.id === 'forgechainos')).toEqual({
      id: 'forgechainos',
      name: 'ForgeChainOS',
      radarUrl: 'https://bsvradar.com/orgs/forgechainos',
    });
  });

  it('preserves firstSeen for an id that is still listed and drops ids that left', () => {
    const snapshot = buildSnapshot(parsed, {
      fetchedAt: '2026-10-28T15:00:00.000Z',
      previous: {
        items: [
          { id: 'handcash', firstSeen: '2026-10-01' },
          { id: 'removed-app', firstSeen: '2026-04-01' },
          { id: 'bitails', firstSeen: '2026-99-99' },
        ],
      },
    });
    expect(snapshot.pin).toMatchObject({
      source: 'https://bsvradar.com/llms-full.txt',
      sourceClass: 'directory',
      fetchedAt: '2026-10-28T15:00:00.000Z',
      sourceFileDate: '2026-10-28',
      caveat: CATALOGUE_CAVEAT,
      counts: { apps: 5, categories: 4, blocks: 2, organisations: 3 },
    });
    expect(snapshot.pin.caveat).toBe(FETCH_CAVEAT);
    expect(snapshot.items.find((item) => item.id === 'handcash')?.firstSeen).toBe('2026-10-01');
    expect(snapshot.items.find((item) => item.id === 'bitails')?.firstSeen).toBe('2026-10-28');
    expect(snapshot.items.map((item) => item.id)).not.toContain('removed-app');
    expect(applyFirstSeen([{ id: 'nora' }], [{ id: 'nora', firstSeen: '2026-02-31' }], '2026-10-28')[0]?.firstSeen).toBe(
      '2026-10-28',
    );
    expect(validDay('2026-02-31')).toBe('');
  });
});

describe('robots and urls', () => {
  it('uses the catalogue indexer user agent and respects robots, including a hard block on /api/', () => {
    expect(USER_AGENT).toBe(
      'AskSatoshi-CatalogueIndexer/1.0 (+https://github.com/BMX-Casey94/AskSatoshi; purpose=directory-snapshot)',
    );
    const robots = parseRobots(ROBOTS);
    expect(pathAllowed(robots, USER_AGENT, '/llms-full.txt')).toBe(true);
    expect(pathAllowed(robots, USER_AGENT, '/apps/handcash')).toBe(true);
    expect(pathAllowed(robots, USER_AGENT, '/api/')).toBe(false);
    expect(pathAllowed(robots, USER_AGENT, '/api/mcp')).toBe(false);
    expect(pathAllowed(robots, USER_AGENT, '/api/health')).toBe(false);
    expect(pathAllowed(robots, USER_AGENT, '/_next/static/chunk.js')).toBe(false);
    expect(pathAllowed(parseRobots('User-agent: *\nAllow: /\n'), USER_AGENT, '/api/mcp')).toBe(false);
    expect(normaliseExternalUrl('bitails.io')).toBe('https://bitails.io');
    expect(normaliseExternalUrl('github.com/justin-case-studio/nora')).toBe(
      'https://github.com/justin-case-studio/nora',
    );
    expect(normaliseExternalUrl('http://www.bitcoinisbsv.com')).toBe('http://www.bitcoinisbsv.com');
    expect(normaliseExternalUrl('https://anvil.sendbsv.com/app/Foundry ')).toBe('https://anvil.sendbsv.com/app/Foundry');
  });
});

describe('looksLikeAppDirectoryQuestion', () => {
  it('matches catalogue questions and refuses how-to-build questions', () => {
    const cases: readonly [string, boolean][] = [
      ['What wallets exist on BSV?', true],
      ['Is there an app for splitting bills?', true],
      ['List BSV apps', true],
      ['What does BSV Radar list under games?', true],
      ['What marketplaces exist on Bitcoin SV?', true],
      ['How do I build an app?', false],
      ['How do I create a wallet with the SDK?', false],
      ['What is an opcode?', false],
      ['What is the latest BSV partnership news?', false],
      ['Who is Satoshi Nakamoto?', false],
      ['What games are on Bitcoin SV?', true],
      ['Are there any BSV explorers?', true],
      ['What SDKs exist for BSV?', true],
      ['How do I build an app and submit it to BSV Radar?', false],
      ['What did Satoshi say about wallets?', false],
      ['Explain BRC-62', false],
      ['How does a Merkle branch show inclusion?', false],
      ['Is there an exchange of value in the white paper?', false],
    ];
    for (const [question, expected] of cases) {
      expect(looksLikeAppDirectoryQuestion(question), question).toBe(expected);
    }
  });
});

describe('BsvRadarDirectory search', () => {
  const clock = () => new Date('2026-10-28T12:00:00.000Z');
  const directory = new BsvRadarDirectory(
    buildSnapshot(parseLlmsFull(FIXTURE), { fetchedAt: '2026-10-28T12:00:00.000Z' }),
    clock,
  );

  it('browses a category instead of searching the word "wallets"', () => {
    const hits = directory.search('What wallets exist on BSV?');
    expect(hits.map((hit) => hit.id)).toEqual(['handcash']);
    expect(hits.every((hit) => hit.category === 'Wallets' && hit.kind === 'app')).toBe(true);
  });

  it('finds an app from its description and a block from an SDK question', () => {
    expect(directory.search('Is there an app for blockchain insights?')[0]?.id).toBe('bitails');
    const sdks = directory.search('What SDKs exist for BSV?');
    expect(sdks.map((hit) => hit.id)).toEqual(expect.arrayContaining(['swiftbsv', 'agid']));
    expect(sdks.every((hit) => hit.kind === 'block')).toBe(true);
  });

  it('spreads a bare app list across categories', () => {
    const hits = directory.search('List BSV apps');
    const categories = new Set(hits.map((hit) => hit.category));
    expect(categories.size).toBeGreaterThan(1);
    expect(hits.every((hit) => hit.kind === 'app')).toBe(true);
  });
});

describe('loadBsvRadar', () => {
  it('fails open on a missing, corrupt or empty file', () => {
    const dir = tempDir();
    expect(loadBsvRadar(join(dir, 'missing.json'))).toBeNull();
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{');
    expect(loadBsvRadar(corrupt)).toBeNull();
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ pin: { fetchedAt: '2026-10-28T00:00:00.000Z' }, items: [] }));
    expect(loadBsvRadar(empty)).toBeNull();
    const useless = join(dir, 'useless.json');
    writeFileSync(useless, JSON.stringify({ items: [{ name: 'HandCash' }] }));
    expect(loadBsvRadar(useless)).toBeNull();
    expect(directoryFetchedAt(join(dir, 'missing.json'))).toBeUndefined();
  });

  it('reads a small snapshot and pin.fetchedAt from the head of the file', () => {
    const dir = tempDir();
    const path = join(dir, 'bsvradar-apps.json');
    const snapshot = buildSnapshot(parseLlmsFull(FIXTURE), { fetchedAt: '2026-10-28T12:00:00.000Z' });
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    expect(directoryFetchedAt(path)).toBe('2026-10-28T12:00:00.000Z');
    const loaded = loadBsvRadar(path, () => new Date('2026-10-28T12:00:00.000Z'));
    expect(loaded?.search('HandCash').some((hit: DirectoryHit) => hit.id === 'handcash')).toBe(true);
  });
});

describe('pinned bsvradar-apps.json', () => {
  it('matches the pin counts and keeps ratings out of the snapshot', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bsvradar-apps.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      pin: {
        source: string;
        fetchedAt: string;
        sourceFileDate: string;
        caveat: string;
        counts: { apps: number; categories: number; blocks: number; organisations: number };
      };
      items: Array<Record<string, unknown>>;
      blocks: Array<Record<string, unknown>>;
      organisations: Array<Record<string, unknown>>;
    };
    expect(file.pin.source).toBe('https://bsvradar.com/llms-full.txt');
    expect(file.pin.caveat).toBe(CATALOGUE_CAVEAT);
    expect(file.pin.sourceFileDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(file.pin.counts.apps).toBe(file.items.length);
    expect(file.pin.counts.blocks).toBe(file.blocks.length);
    expect(file.pin.counts.organisations).toBe(file.organisations.length);
    expect(file.items.length).toBeGreaterThan(100);
    expect(file.blocks.length).toBeGreaterThan(100);
    expect(file.organisations.length).toBeGreaterThan(20);
    expect(new Set(file.items.map((item) => item.category)).size).toBe(file.pin.counts.categories);
    for (const item of file.items) {
      expect(item.radarUrl).toBe(`https://bsvradar.com/apps/${item.id}`);
      expect(item).not.toHaveProperty('rating');
      expect(item).not.toHaveProperty('upvotes');
    }
    const loaded = loadBsvRadar(path, () => new Date('2026-10-28T12:00:00.000Z'));
    expect(loaded?.search('What wallets exist on BSV?').some((hit) => hit.id === 'handcash')).toBe(true);
    expect(directoryFetchedAt(path)).toBe(file.pin.fetchedAt);
  });
});
