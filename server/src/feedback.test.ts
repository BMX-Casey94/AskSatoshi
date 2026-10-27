import { describe, expect, it, vi } from 'vitest';
import {
  FEEDBACK_LIMIT_PER_MIN,
  FEEDBACK_MODES,
  feedbackAdminDecision,
  feedbackBodySchema,
  FeedbackCounters,
  type FeedbackRating,
} from './feedback.js';

describe('feedbackBodySchema', () => {
  it('accepts a rating alone and a rating with a known mode', () => {
    expect(feedbackBodySchema.safeParse({ rating: 'up' }).success).toBe(true);
    expect(feedbackBodySchema.safeParse({ rating: 'down' }).success).toBe(true);
    for (const mode of FEEDBACK_MODES) {
      expect(feedbackBodySchema.safeParse({ rating: 'up', mode }).success).toBe(true);
    }
  });

  it('rejects anything other than the rating and an optional mode', () => {
    expect(feedbackBodySchema.safeParse({}).success).toBe(false);
    expect(feedbackBodySchema.safeParse({ rating: 'yes' }).success).toBe(false);
    expect(feedbackBodySchema.safeParse({ rating: 'UP' }).success).toBe(false);
    expect(feedbackBodySchema.safeParse({ rating: 'up', mode: 'web' }).success).toBe(false);
    expect(feedbackBodySchema.safeParse({ rating: 'up', question: 'who are you?' }).success).toBe(false);
    expect(feedbackBodySchema.safeParse({ rating: 'up', mode: 'none', ip: '203.0.113.4' }).success).toBe(false);
    expect(feedbackBodySchema.safeParse({ rating: 'up', text: 'loved it' }).success).toBe(false);
  });
});

describe('FeedbackCounters', () => {
  it('tallies ratings, and modes only when one was sent', () => {
    const counters = new FeedbackCounters();
    counters.record('up', 'mcp');
    counters.record('up', 'mcp');
    counters.record('down', 'corpus');
    counters.record('down', 'none');
    counters.record('up');
    expect(counters.summary()).toEqual({
      up: 3,
      down: 2,
      byMode: {
        mcp: { up: 2, down: 0 },
        corpus: { up: 0, down: 1 },
        reference: { up: 0, down: 0 },
        none: { up: 0, down: 1 },
      },
    });
  });

  it('returns a copy, so a caller cannot mutate the totals', () => {
    const counters = new FeedbackCounters();
    counters.record('up', 'reference');
    const snap = counters.summary();
    snap.up = 99;
    snap.byMode.reference.up = 99;
    expect(counters.summary().up).toBe(1);
    expect(counters.summary().byMode.reference.up).toBe(1);
  });

  it('ignores a rating outside up and down', () => {
    const counters = new FeedbackCounters();
    counters.record('sideways' as FeedbackRating);
    expect(counters.summary().up).toBe(0);
    expect(counters.summary().down).toBe(0);
  });

  it('logs a one-line aggregate tally and nothing about the vote itself', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const counters = new FeedbackCounters();
      counters.record('up', 'mcp');
      counters.record('down');
      expect(spy).toHaveBeenNthCalledWith(1, '[feedback] up 1, down 0');
      expect(spy).toHaveBeenNthCalledWith(2, '[feedback] up 1, down 1');
      for (const call of spy.mock.calls) {
        const line = String(call[0]);
        expect(line).toMatch(/^\[feedback\] up \d+, down \d+$/);
        expect(line).not.toMatch(/mcp|question|203\.0\.113/);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('feedbackAdminDecision', () => {
  it('treats a missing or blank token as unconfigured', () => {
    expect(feedbackAdminDecision('Bearer secret', undefined)).toBe('unconfigured');
    expect(feedbackAdminDecision('Bearer secret', '')).toBe('unconfigured');
    expect(feedbackAdminDecision('Bearer secret', '   ')).toBe('unconfigured');
  });

  it('accepts the bearer token and rejects a missing, wrong, or different-length one', () => {
    expect(feedbackAdminDecision('Bearer correct-token', 'correct-token')).toBe('ok');
    expect(feedbackAdminDecision('bearer correct-token', 'correct-token')).toBe('ok');
    expect(feedbackAdminDecision('Bearer  correct-token  ', 'correct-token')).toBe('ok');
    expect(feedbackAdminDecision(undefined, 'correct-token')).toBe('denied');
    expect(feedbackAdminDecision('Basic correct-token', 'correct-token')).toBe('denied');
    expect(feedbackAdminDecision('Bearer wrong-token!', 'correct-token')).toBe('denied');
    expect(feedbackAdminDecision('Bearer x', 'correct-token')).toBe('denied');
    expect(feedbackAdminDecision(`Bearer ${'a'.repeat(200)}`, 'correct-token')).toBe('denied');
  });
});

describe('feedback limit', () => {
  it('caps anonymous posts at 30 per minute', () => {
    expect(FEEDBACK_LIMIT_PER_MIN).toBe(30);
  });
});
