import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({
  default: {
    update: vi.fn(),
  },
}));

vi.mock('@/lib/connectors/microsoft-todo/graph-client', () => ({
  GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0',
  SUBSTRATE_BASE_URL: 'https://outlook.office.com',
  createGraphClient: vi.fn(),
}));

import { buildMicrosoftRecurrencePattern } from '@/lib/connectors/microsoft-todo';
import { parseRecurrencePattern, parseSubstrateRecurrence } from '@/lib/connectors/microsoft-todo/task-transformer';

describe('Microsoft To Do recurrence serialization', () => {
  it('serializes custom day intervals', () => {
    expect(buildMicrosoftRecurrencePattern('every 3 days', '2026-08-03')).toEqual({
      range: { type: 'noEnd', startDate: '2026-08-03' },
      pattern: { type: 'daily', interval: 3 },
    });
  });

  it('serializes selected weekdays', () => {
    expect(
      buildMicrosoftRecurrencePattern(
        'weekly (monday, wednesday, friday)',
        '2026-08-03',
      ),
    ).toEqual({
      range: { type: 'noEnd', startDate: '2026-08-03' },
      pattern: {
        type: 'weekly',
        interval: 1,
        daysOfWeek: ['monday', 'wednesday', 'friday'],
      },
    });
  });

  it('uses date-only values without timezone shifts', () => {
    expect(buildMicrosoftRecurrencePattern('monthly', '2026-08-03')).toEqual({
      range: { type: 'noEnd', startDate: '2026-08-03' },
      pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 3 },
    });
    expect(buildMicrosoftRecurrencePattern('weekly', '2026-08-03')).toEqual({
      range: { type: 'noEnd', startDate: '2026-08-03' },
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] },
    });
  });

  it('round-trips custom weekly and yearly intervals', () => {
    expect(parseRecurrencePattern({
      pattern: {
        type: 'weekly',
        interval: 2,
        daysOfWeek: ['monday', 'wednesday'],
      },
      range: { type: 'noEnd', startDate: '2026-08-03' },
    })).toBe('every 2 weeks (monday, wednesday)');
    expect(parseRecurrencePattern({
      pattern: {
        type: 'absoluteYearly',
        interval: 3,
        dayOfMonth: 3,
        month: 8,
      },
      range: { type: 'noEnd', startDate: '2026-08-03' },
    })).toBe('every 3 years');
  });

  it('preserves recurrence metadata for tasks fetched through Substrate', () => {
    expect(parseSubstrateRecurrence({
      Pattern: { Type: 'daily', Interval: 2 },
      Range: { Type: 'noEnd', StartDate: '2026-08-02' },
    })).toBe('every 2 days');
  });
});
