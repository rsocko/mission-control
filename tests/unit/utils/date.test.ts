import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatDateInLocalTimezone,
  getLocalDateBoundsISO,
  isTimestampWithinBounds,
  parseStoredTimestamp,
} from '@/lib/utils/date';

vi.mock('@/lib/mode', () => ({
  getTimezone: () => 'America/New_York',
}));

describe('configured timezone date helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats UTC timestamps as dates in the configured timezone', () => {
    expect(formatDateInLocalTimezone(new Date('2026-07-31T02:00:00.000Z'))).toBe('2026-07-30');
  });

  it('returns DST-aware UTC boundaries for a local date', () => {
    expect(getLocalDateBoundsISO('2026-03-08')).toEqual({
      dayStart: '2026-03-08T05:00:00.000Z',
      nextDayStart: '2026-03-09T04:00:00.000Z',
    });
  });

  it('treats connector timestamps without an offset as UTC', () => {
    expect(parseStoredTimestamp('2026-08-05T16:30:00.0000000')).toBe(
      Date.parse('2026-08-05T16:30:00.000Z'),
    );
    expect(isTimestampWithinBounds(
      '2026-08-05T16:30:00.0000000',
      '2026-08-05T04:00:00.000Z',
      '2026-08-06T04:00:00.000Z',
    )).toBe(true);
  });
});
