import { describe, expect, it } from 'vitest';
import { citationAgeMonths, olderReportingNote, OLDER_REPORTING_NOTE } from './citationAge';

const NOW = new Date('2025-10-14T00:00:00.000Z');

describe('olderReportingNote', () => {
  it('warns only for news citations more than 18 months old', () => {
    expect(citationAgeMonths('2024-04-14T00:00:00.000Z', NOW)).toBe(18);
    expect(citationAgeMonths('2024-03-14T00:00:00.000Z', NOW)).toBe(19);
    expect(
      olderReportingNote({ sourceClass: 'news', date: '2024-04-14T00:00:00.000Z' }, NOW),
    ).toBeNull();
    expect(
      olderReportingNote({ sourceClass: 'news', date: '2025-08-14T00:00:00.000Z' }, NOW),
    ).toBeNull();
    expect(olderReportingNote({ sourceClass: 'news', date: '2024-03-14T00:00:00.000Z' }, NOW)).toBe(
      OLDER_REPORTING_NOTE,
    );
    expect(OLDER_REPORTING_NOTE).toBe('Older reporting — circumstances may have changed');
  });

  it('does not warn on primary sources, missing dates or unparseable dates', () => {
    expect(
      olderReportingNote({ sourceClass: 'satoshi-primary', date: '2009-01-03T00:00:00.000Z' }, NOW),
    ).toBeNull();
    expect(olderReportingNote({ sourceClass: 'news' }, NOW)).toBeNull();
    expect(olderReportingNote({ sourceClass: 'news', date: 'not-a-date' }, NOW)).toBeNull();
  });
});
