import { describe, expect, it } from 'vitest';
import { classifyProviderError, retryAfterMs, witty, WittyException } from './errors.js';

describe('classifyProviderError', () => {
  it('maps 401/403 to auth', () => {
    expect(classifyProviderError({ status: 401, message: 'invalid api key' })).toBe('auth');
    expect(classifyProviderError({ status: 403, message: 'forbidden' })).toBe('auth');
  });

  it('maps daily-quota 429s to day', () => {
    expect(
      classifyProviderError({ status: 429, message: 'Quota exceeded: requests per day (RPD) limit reached' }),
    ).toBe('day');
    expect(
      classifyProviderError({ status: 429, message: 'You have exceeded your daily quota for this model' }),
    ).toBe('day');
  });

  it('maps per-minute 429s to minute', () => {
    expect(classifyProviderError({ status: 429, message: 'Rate limit reached: 30 requests per minute' })).toBe(
      'minute',
    );
  });

  it('maps transient statuses and network failures', () => {
    expect(classifyProviderError({ status: 503, message: 'service unavailable' })).toBe('transient');
    expect(classifyProviderError({ status: 529, message: 'overloaded' })).toBe('transient');
    expect(classifyProviderError(new Error('fetch failed'))).toBe('transient');
    expect(classifyProviderError(new Error('IDLE_TIMEOUT'))).toBe('transient');
    expect(classifyProviderError(new Error('socket hang up'))).toBe('transient');
  });

  it('maps 400/404/422 to bad-request', () => {
    expect(classifyProviderError({ status: 400, message: 'model not found' })).toBe('bad-request');
    expect(classifyProviderError({ status: 404, message: 'The model does not exist' })).toBe('bad-request');
  });

  it('treats unknown errors as transient so tiers are never wrongly marked dead', () => {
    expect(classifyProviderError(new Error('something entirely novel'))).toBe('transient');
  });
});

describe('retryAfterMs', () => {
  it('reads retry-after delta seconds', () => {
    const ms = retryAfterMs({ headers: { 'retry-after': '30' } });
    expect(ms).toBe(30_000);
  });

  it('returns undefined without headers', () => {
    expect(retryAfterMs(new Error('nope'))).toBeUndefined();
  });
});

describe('witty', () => {
  it('attaches retryAfter only when provided', () => {
    expect(witty('EXHAUSTED').retryAfter).toBeUndefined();
    expect(witty('EXHAUSTED', '2026-08-31T07:00:00Z').retryAfter).toBe('2026-08-31T07:00:00Z');
  });

  it('WittyException carries the typed error', () => {
    const err = new WittyException(witty('TIMEOUT'));
    expect(err).toBeInstanceOf(Error);
    expect(err.wittyError.code).toBe('TIMEOUT');
  });
});
