import { describe, expect, it } from 'vitest';
import { formatShortDate, parseLocalDate } from '@/lib/utils/date-format';

describe('parseLocalDate', () => {
  it('preserves date-only calendar fields in local time', () => {
    const parsed = parseLocalDate('2026-10-01');

    expect(parsed).not.toBeNull();
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(9);
    expect(parsed?.getDate()).toBe(1);
  });
});

describe('formatShortDate', () => {
  const now = new Date(2026, 7, 22);

  it('omits the year for dates in the current year', () => {
    expect(formatShortDate('2026-09-04', now)).toBe('Sep 4');
  });

  it.each([
    ['2025-09-04', 'Sep 4, 2025'],
    ['2027-09-04', 'Sep 4, 2027'],
  ])('includes the year for date %s outside the current year', (date, expected) => {
    expect(formatShortDate(date, now)).toBe(expected);
  });
});
