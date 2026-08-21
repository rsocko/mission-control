import { describe, expect, it } from 'vitest';
import { getCompletionAnchoredDueDate } from '@/lib/utils/recurrence';

describe('completion-anchored recurrence dates', () => {
  it('anchors date-only recurrence to the local completion date', () => {
    expect(getCompletionAnchoredDueDate(
      '2026-08-21T23:30:00.000Z',
      'every 3 days',
      'America/New_York',
      false,
    )).toBe('2026-08-24');
  });

  it('preserves completion wall-clock time across daylight saving changes', () => {
    expect(getCompletionAnchoredDueDate(
      '2026-03-07T15:00:00.000Z',
      'daily',
      'America/New_York',
      true,
    )).toBe('2026-03-08T14:00:00.000Z');
  });

  it('uses the next selected weekday after completion', () => {
    expect(getCompletionAnchoredDueDate(
      '2026-08-21T16:00:00.000Z',
      'weekly (monday, wednesday)',
      'America/New_York',
      false,
    )).toBe('2026-08-24');
  });
});
