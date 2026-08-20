import { describe, expect, it } from 'vitest';
import { normalizeWorkTodoReminderAt } from '@/lib/connectors/work-todo/service';

describe('Microsoft To Do reminder timezone normalization', () => {
  it('converts a Windows timezone local datetime to a UTC instant', () => {
    expect(normalizeWorkTodoReminderAt({
      dateTime: '2026-07-15T12:00:00',
      timeZone: 'Pacific Standard Time',
    })).toBe('2026-07-15T19:00:00.000Z');
  });

  it('preserves the instant when the source already includes an offset', () => {
    expect(normalizeWorkTodoReminderAt({
      dateTime: '2026-07-15T12:00:00-07:00',
      timeZone: 'Pacific Standard Time',
    })).toBe('2026-07-15T19:00:00.000Z');
  });

  it('quarantines unknown timezones instead of using the server-local time', () => {
    expect(normalizeWorkTodoReminderAt({
      dateTime: '2026-07-15T12:00:00',
      timeZone: 'Unknown Custom Time',
    })).toBe('invalid-timezone:Unknown%20Custom%20Time:2026-07-15T12:00:00');
  });
});
