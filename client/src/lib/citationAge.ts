/**
 * Age of a news citation, for the source panel.
 * Calendar months are UTC, matching server/src/coingeekNews.ts so the 18-month
 * line falls in the same place as the 'dated' bucket.
 */

export const OLDER_REPORTING_NOTE = 'Older reporting — circumstances may have changed';

/** The panel note appears only after this many whole months, not on the ageing boundary. */
export const OLDER_REPORTING_AFTER_MONTHS = 18;

/** Whole calendar months between an ISO date and `now`. Null when the date is missing or invalid. */
export function citationAgeMonths(iso: string | null | undefined, now: Date): number | null {
  if (!iso?.trim()) return null;
  const ms = Date.parse(iso.trim());
  if (Number.isNaN(ms)) return null;
  const published = new Date(ms);
  let months =
    (now.getUTCFullYear() - published.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - published.getUTCMonth());
  if (now.getUTCDate() < published.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * Note for a CoinGeek citation older than 18 months.
 * Other source classes are historical by design and do not get this warning.
 */
export function olderReportingNote(
  citation: { sourceClass?: string | null; date?: string | null },
  now: Date = new Date(),
): string | null {
  if (citation.sourceClass !== 'news') return null;
  const age = citationAgeMonths(citation.date, now);
  if (age === null || age <= OLDER_REPORTING_AFTER_MONTHS) return null;
  return OLDER_REPORTING_NOTE;
}
