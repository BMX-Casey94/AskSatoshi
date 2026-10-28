export const USER_AGENT: string;
export const FEED_URL: string;
export const CATALOGUE_CAVEAT: string;

export interface RobotsGroup {
  agents: string[];
  rules: { type: 'allow' | 'disallow'; path: string }[];
  crawlDelay: number;
}

export interface ParsedApp {
  id: string;
  name: string;
  category: string;
  summary: string;
  url?: string;
  radarUrl: string;
  platform?: string;
  tags: string[];
  lastUpdated?: string;
}

export interface ParsedBlock {
  id: string;
  name: string;
  category: string;
  summary: string;
  url?: string;
  radarUrl: string;
  tags: string[];
  docs?: string;
  maturity?: string;
  license?: string;
  maintainer?: string;
  version?: string;
  lastUpdated?: string;
}

export interface ParsedOrg {
  id: string;
  name: string;
  radarUrl: string;
  apps?: number;
  blocks?: number;
}

export interface ParsedCatalogue {
  sourceFileDate: string;
  items: ParsedApp[];
  blocks: ParsedBlock[];
  organisations: ParsedOrg[];
  skipped: number;
}

export interface SeenRow {
  id: string;
  firstSeen?: string;
}

export interface SnapshotFile {
  pin: {
    source: string;
    sourceClass: 'directory';
    fetchedAt: string;
    sourceFileDate: string | null;
    method: 'llms-full';
    counts: { apps: number; categories: number; blocks: number; organisations: number };
    caveat: string;
  };
  items: Array<ParsedApp & { firstSeen: string }>;
  blocks: Array<ParsedBlock & { firstSeen: string }>;
  organisations: Array<ParsedOrg & { firstSeen: string }>;
}

export function parseRobots(text: string): RobotsGroup[];
export function robotsAllows(groups: readonly RobotsGroup[], userAgent: string, pathname: string): boolean;
export function pathAllowed(groups: readonly RobotsGroup[], userAgent: string, pathname: string): boolean;
export function validDay(value: unknown): string;
export function normaliseExternalUrl(value: unknown): string;
export function parseLlmsFull(text: string): ParsedCatalogue;
export function applyFirstSeen<T extends { id: string }>(
  rows: readonly T[],
  previous: readonly unknown[] | undefined,
  day: string,
): Array<T & { firstSeen: string }>;
export function buildSnapshot(
  parsed: ParsedCatalogue,
  options?: { fetchedAt?: string; previous?: { items?: unknown[]; blocks?: unknown[]; organisations?: unknown[] } | null },
): SnapshotFile;
