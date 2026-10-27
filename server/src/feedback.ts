/**
 * Anonymous answer ratings. In-memory totals only: a thumbs value and, when the
 * client sends one, the retrieval mode. No IP, no question, no answer text.
 * Restart-safe to lose. The admin summary is a separate route gated by
 * FEEDBACK_ADMIN_TOKEN; this module decides that gate and holds the counters.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const FEEDBACK_LIMIT_PER_MIN = 30;

export const FEEDBACK_MODES = ['mcp', 'corpus', 'reference', 'none'] as const;

export const feedbackBodySchema = z.strictObject({
  rating: z.enum(['up', 'down']),
  mode: z.enum(FEEDBACK_MODES).optional(),
});

export type FeedbackRating = 'up' | 'down';
export type FeedbackMode = (typeof FEEDBACK_MODES)[number];

export interface FeedbackSummary {
  up: number;
  down: number;
  byMode: Record<FeedbackMode, { up: number; down: number }>;
}

/** Body express-rate-limit sends when the per-IP feedback ceiling is hit. */
export const FEEDBACK_RATE_LIMITED = {
  error: {
    code: 'RATE_LIMITED' as const,
    message: 'Easy there — that is a lot of ratings in one minute. Give it a moment.',
  },
};

export type FeedbackAdminDecision = 'ok' | 'unconfigured' | 'denied';

function emptyModeCounts(): Record<FeedbackMode, { up: number; down: number }> {
  return {
    mcp: { up: 0, down: 0 },
    corpus: { up: 0, down: 0 },
    reference: { up: 0, down: 0 },
    none: { up: 0, down: 0 },
  };
}

export class FeedbackCounters {
  private up = 0;
  private down = 0;
  private readonly byMode = emptyModeCounts();

  record(rating: FeedbackRating, mode?: FeedbackMode): void {
    if (rating !== 'up' && rating !== 'down') return;
    if (rating === 'up') this.up += 1;
    else this.down += 1;
    if (mode) this.byMode[mode][rating] += 1;
    const tally = this.summary();
    console.info(`[feedback] up ${tally.up}, down ${tally.down}`);
  }

  summary(): FeedbackSummary {
    const byMode = emptyModeCounts();
    for (const mode of FEEDBACK_MODES) {
      byMode[mode] = { up: this.byMode[mode].up, down: this.byMode[mode].down };
    }
    return { up: this.up, down: this.down, byMode };
  }
}

function bearerToken(header: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1]?.trim() ?? '';
}

/**
 * Compare two tokens without a length early-out. SHA-256 digests are fixed width,
 * so timingSafeEqual always runs over the same number of bytes.
 */
function tokenEquals(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Gate for GET /api/feedback/summary. An unset or blank token is `unconfigured`
 * (the route responds 404). A wrong or missing bearer is `denied` (401).
 */
export function feedbackAdminDecision(
  authorization: string | undefined,
  expectedToken: string | undefined,
): FeedbackAdminDecision {
  const expected = expectedToken?.trim() ?? '';
  if (!expected) return 'unconfigured';
  return tokenEquals(bearerToken(authorization), expected) ? 'ok' : 'denied';
}
