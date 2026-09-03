/**
 * TTS pricing: live BSV/USD (WhatsOnChain, then CoinGecko), cached for 10 minutes,
 * then last-good, then BSV_USD_FALLBACK. User price is 2.5× Resemble cost with a
 * 10% rate buffer so a dip between quote and settlement still covers the bill.
 */

export const COST_USD_PER_1000_CHARS = 0.04;
export const PRICE_MULTIPLIER = 2.5;
export const RATE_BUFFER = 0.9;
export const MIN_BILLED_CHARS = 100;
export const RATE_CACHE_TTL_MS = 10 * 60 * 1000;

const PRICE_USD_PER_1000_CHARS = COST_USD_PER_1000_CHARS * PRICE_MULTIPLIER;

const WOC_RATE_URL = 'https://api.whatsonchain.com/v1/bsv/main/exchangerate';
const COINGECKO_RATE_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-sv&vs_currencies=usd';

export type BsvUsdSource = 'whatsonchain' | 'coingecko' | 'cache' | 'fallback';

export interface BsvUsdQuote {
  rate: number;
  source: BsvUsdSource;
}

interface RateCache {
  rate: number;
  source: Exclude<BsvUsdSource, 'cache' | 'fallback'>;
  fetchedAt: number;
}

let cache: RateCache | null = null;

export function resetBsvUsdCache(): void {
  cache = null;
}

/** Satoshis charged for a character count at the given BSV/USD spot. */
export function quoteSatoshis(chars: number, bsvUsd: number): number {
  const billed = Math.max(chars, MIN_BILLED_CHARS);
  return Math.ceil((billed * (PRICE_USD_PER_1000_CHARS / 1000)) / (bsvUsd * RATE_BUFFER) * 1e8);
}

/** Display helper for GET /status. */
export function satsPerThousand(bsvUsd: number): number {
  return quoteSatoshis(1000, bsvUsd);
}

function fallbackRate(): number {
  const raw = Number(process.env.BSV_USD_FALLBACK);
  return Number.isFinite(raw) && raw > 0 ? raw : 15;
}

async function readJson(
  fetchFn: typeof fetch,
  url: string,
): Promise<unknown | null> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function asPositiveRate(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * WhatsOnChain first, CoinGecko fallback, 10-minute memory cache, last-good on
 * failure, finally BSV_USD_FALLBACK. `now` is injectable so cache TTL is testable.
 */
export async function fetchBsvUsd(
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<BsvUsdQuote> {
  if (cache && now - cache.fetchedAt < RATE_CACHE_TTL_MS) {
    return { rate: cache.rate, source: cache.source };
  }

  const woc = await readJson(fetchFn, WOC_RATE_URL);
  const wocRate = woc && typeof woc === 'object' ? asPositiveRate((woc as { rate?: unknown }).rate) : null;
  if (wocRate !== null) {
    cache = { rate: wocRate, source: 'whatsonchain', fetchedAt: now };
    return { rate: wocRate, source: 'whatsonchain' };
  }

  const cg = await readJson(fetchFn, COINGECKO_RATE_URL);
  const cgRate =
    cg && typeof cg === 'object'
      ? asPositiveRate((cg as { 'bitcoin-sv'?: { usd?: unknown } })['bitcoin-sv']?.usd)
      : null;
  if (cgRate !== null) {
    cache = { rate: cgRate, source: 'coingecko', fetchedAt: now };
    return { rate: cgRate, source: 'coingecko' };
  }

  if (cache) {
    console.warn('[tts] exchange-rate lookup failed; using last-good cache');
    return { rate: cache.rate, source: 'cache' };
  }

  const rate = fallbackRate();
  console.warn(`[tts] exchange-rate lookup failed; using fallback ${rate}`);
  return { rate, source: 'fallback' };
}
