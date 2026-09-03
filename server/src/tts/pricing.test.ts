import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchBsvUsd,
  quoteSatoshis,
  resetBsvUsdCache,
  satsPerThousand,
} from './pricing.js';

const RATE_BUFFER = 0.9;
const PRICE_USD_PER_1000 = 0.1;

function expectedSats(chars: number, bsvUsd: number): number {
  const billed = Math.max(chars, 100);
  return Math.ceil((billed * (PRICE_USD_PER_1000 / 1000)) / (bsvUsd * RATE_BUFFER) * 1e8);
}

describe('quoteSatoshis', () => {
  it('matches the exact formula at a known rate, applying the 0.9 buffer', () => {
    // 1,000 chars × $0.10 / ($20 × 0.9) × 1e8 = ceil(555555.5…) = 555556
    expect(quoteSatoshis(1000, 20)).toBe(555_556);
    expect(quoteSatoshis(1000, 20)).toBe(expectedSats(1000, 20));
  });

  it('bills texts shorter than MIN_BILLED_CHARS as 100 characters', () => {
    expect(quoteSatoshis(1, 20)).toBe(quoteSatoshis(100, 20));
    expect(quoteSatoshis(50, 20)).toBe(55_556);
    expect(quoteSatoshis(99, 20)).toBe(expectedSats(100, 20));
  });

  it('scales linearly above the minimum and always ceilings to a whole sat', () => {
    expect(quoteSatoshis(2000, 20)).toBe(1_111_112);
    expect(quoteSatoshis(1500, 16.71)).toBe(expectedSats(1500, 16.71));
  });
});

describe('satsPerThousand', () => {
  it('equals the quote for 1,000 characters at the same rate', () => {
    expect(satsPerThousand(20)).toBe(quoteSatoshis(1000, 20));
    expect(satsPerThousand(16.71)).toBe(quoteSatoshis(1000, 16.71));
  });
});

describe('fetchBsvUsd', () => {
  afterEach(() => {
    resetBsvUsdCache();
  });

  it('uses WhatsOnChain first and does not call CoinGecko on success', async () => {
    const calls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('whatsonchain.com') && url.includes('exchangerate')) {
        return new Response(JSON.stringify({ rate: 16.71, time: 1, currency: 'USD' }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const result = await fetchBsvUsd(fetchFn);
    expect(result).toEqual({ rate: 16.71, source: 'whatsonchain' });
    expect(calls).toHaveLength(1);
  });

  it('falls back to CoinGecko when WhatsOnChain fails', async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('whatsonchain.com')) {
        return new Response('nope', { status: 503 });
      }
      if (url.includes('coingecko.com')) {
        return new Response(JSON.stringify({ 'bitcoin-sv': { usd: 16.7 } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    await expect(fetchBsvUsd(fetchFn)).resolves.toEqual({ rate: 16.7, source: 'coingecko' });
  });

  it('serves the in-memory cache within 10 minutes without refetching', async () => {
    let fetches = 0;
    const fetchFn = async () => {
      fetches += 1;
      return new Response(JSON.stringify({ rate: 18, time: 1, currency: 'USD' }), { status: 200 });
    };
    const first = await fetchBsvUsd(fetchFn, 1_000_000);
    const second = await fetchBsvUsd(fetchFn, 1_000_000 + 9 * 60 * 1000);
    expect(first).toEqual({ rate: 18, source: 'whatsonchain' });
    expect(second).toEqual({ rate: 18, source: 'whatsonchain' });
    expect(fetches).toBe(1);
  });

  it('uses last-good cache when both exchanges fail after a prior success', async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('whatsonchain.com') && url.includes('exchangerate')) {
        return new Response(JSON.stringify({ rate: 19, time: 1, currency: 'USD' }), { status: 200 });
      }
      throw new Error('down');
    };
    await fetchBsvUsd(fetchFn, 0);
    const failing = async () => new Response('down', { status: 500 });
    const result = await fetchBsvUsd(failing, 11 * 60 * 1000);
    expect(result).toEqual({ rate: 19, source: 'cache' });
  });

  it('uses BSV_USD_FALLBACK when both exchanges fail and there is no last-good rate', async () => {
    const prev = process.env.BSV_USD_FALLBACK;
    process.env.BSV_USD_FALLBACK = '15';
    try {
      const fetchFn = async () => new Response('down', { status: 500 });
      await expect(fetchBsvUsd(fetchFn)).resolves.toEqual({ rate: 15, source: 'fallback' });
    } finally {
      if (prev === undefined) delete process.env.BSV_USD_FALLBACK;
      else process.env.BSV_USD_FALLBACK = prev;
    }
  });
});
