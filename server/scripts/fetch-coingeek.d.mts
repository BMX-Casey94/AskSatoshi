export interface FetchNewsItem {
  id: string;
  url: string;
  title: string;
  date: string;
  modified?: string;
  categories?: string[];
  tags?: string[];
  excerpt: string;
}

export interface MergeCoverage {
  from?: string;
  to?: string;
  complete?: boolean;
}

export interface RobotsGroup {
  agents: string[];
  rules: { type: 'allow' | 'disallow'; path: string }[];
  crawlDelay: number;
}

export interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
  categories: string[];
  tags: string[];
}

export function mergeNewsItems(
  existing: readonly FetchNewsItem[],
  incoming: readonly FetchNewsItem[],
  coverage?: MergeCoverage,
): FetchNewsItem[];

export function htmlToPlainText(value: unknown): string;
export function clipExcerpt(value: unknown, max?: number): string;
export function canonicalUrl(value: unknown): string;
export function parseRobots(text: string): RobotsGroup[];
export function robotsAllows(groups: readonly RobotsGroup[], userAgent: string, pathname: string): boolean;
export function pathAllowed(groups: readonly RobotsGroup[], userAgent: string, pathname: string): boolean;
export function metaDescription(html: string): string;
export function parseRssItems(xml: string): RssItem[];
export function termNames(ids: readonly number[], lookup: { get(id: number): string | undefined }, max?: number): string[];
export function rssEntryToItem(
  entry: {
    title?: string;
    link?: string;
    pubDate?: string;
    description?: string;
    categories?: string[];
    tags?: string[];
  },
  cutoffMs?: number,
): FetchNewsItem | null;
