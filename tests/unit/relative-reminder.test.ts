import { describe, expect, it } from 'vitest';
import {
  computeRelativeReminderAt,
  resolveRelativeReminderMutation,
} from '@/lib/tasks/relative-reminder';

const current = {
  dueDate: '2026-07-28',
  reminderAt: null,
  reminderRelative: null,
  reminderDueTime: null,
};

describe('relative task reminders', () => {
  it.each([
    ['1_hour_before', '2026-07-28T12:00:00.000Z'],
    ['1_day_before', '2026-07-27T13:00:00.000Z'],
    ['3_days_before', '2026-07-25T13:00:00.000Z'],
    ['1_week_before', '2026-07-21T13:00:00.000Z'],
  ] as const)('computes %s from local due time', (rule, reminderAt) => {
    expect(computeRelativeReminderAt({
      dueDate: current.dueDate,
      dueTime: '09:00',
      timezone: 'America/New_York',
      rule,
    })).toEqual({ success: true, reminderAt });
  });

  it('rejects a nonexistent daylight-saving wall time', () => {
    expect(computeRelativeReminderAt({
      dueDate: '2026-03-08',
      dueTime: '02:30',
      timezone: 'America/New_York',
      rule: '1_hour_before',
    })).toMatchObject({ success: false, code: 'INVALID_LOCAL_TIME' });
  });

  it('keeps day and week reminders at the same wall time across DST', () => {
    expect(computeRelativeReminderAt({
      dueDate: '2026-03-09',
      dueTime: '09:00',
      timezone: 'America/New_York',
      rule: '1_week_before',
    })).toEqual({
      success: true,
      reminderAt: '2026-03-02T14:00:00.000Z',
    });
  });

  it('stores intent and recomputes atomically when the due date changes', () => {
    const created = resolveRelativeReminderMutation({
      current,
      input: { reminderRelative: '1_day_before', reminderDueTime: '09:00' },
      timezone: 'America/New_York',
      now: new Date('2026-07-01T00:00:00.000Z'),
    });
    expect(created).toEqual({
      success: true,
      updates: {
        reminderAt: '2026-07-27T13:00:00.000Z',
        reminderRelative: '1_day_before',
        reminderDueTime: '09:00',
      },
    });

    expect(resolveRelativeReminderMutation({
      current: { ...current, ...(created.success ? created.updates : {}) },
      input: { dueDate: '2026-07-30' },
      timezone: 'America/New_York',
      now: new Date('2026-07-01T00:00:00.000Z'),
    })).toMatchObject({
      success: true,
      updates: { reminderAt: '2026-07-29T13:00:00.000Z' },
    });
  });

  it('requires an explicit resolution before removing the due date', () => {
    const relative = {
      ...current,
      reminderAt: '2026-07-27T13:00:00.000Z',
      reminderRelative: '1_day_before',
      reminderDueTime: '09:00',
    };
    expect(resolveRelativeReminderMutation({
      current: relative,
      input: { dueDate: null },
      timezone: 'America/New_York',
    })).toMatchObject({
      success: false,
      code: 'RELATIVE_REMINDER_DUE_DATE_REQUIRED',
    });

    it('requires a due date when creating relative intent', () => {
      expect(resolveRelativeReminderMutation({
        current: { ...current, dueDate: null },
        input: { reminderRelative: '1_day_before', reminderDueTime: '09:00' },
        timezone: 'America/New_York',
      })).toMatchObject({
        success: false,
        status: 400,
        code: 'RELATIVE_REMINDER_DUE_DATE_REQUIRED',
        error: 'Set a due date before choosing a relative reminder',
      });
    });
    expect(resolveRelativeReminderMutation({
      current: relative,
      input: { dueDate: null, relativeReminderDueDateResolution: 'convert_to_absolute' },
      timezone: 'America/New_York',
    })).toEqual({
      success: true,
      updates: {
        reminderAt: relative.reminderAt,
        reminderRelative: null,
        reminderDueTime: null,
      },
    });
    expect(resolveRelativeReminderMutation({
      current: relative,
      input: { dueDate: null, relativeReminderDueDateResolution: 'remove' },
      timezone: 'America/New_York',
    })).toEqual({
      success: true,
      updates: { reminderAt: null, reminderRelative: null, reminderDueTime: null },
    });
  });

  it('rejects a relative firing time in the past', () => {
    expect(resolveRelativeReminderMutation({
      current,
      input: { reminderRelative: '1_day_before', reminderDueTime: '09:00' },
      timezone: 'America/New_York',
      now: new Date('2026-07-28T00:00:00.000Z'),
    })).toMatchObject({ success: false, code: 'RELATIVE_REMINDER_IN_PAST' });
  });

  it('clears relative intent when an absolute reminder is selected', () => {
    expect(resolveRelativeReminderMutation({
      current: {
        ...current,
        reminderAt: '2026-07-27T13:00:00.000Z',
        reminderRelative: '1_day_before',
        reminderDueTime: '09:00',
      },
      input: { reminderAt: '2026-07-20T12:00:00.000Z' },
      timezone: 'America/New_York',
    })).toEqual({
      success: true,
      updates: {
        reminderAt: '2026-07-20T12:00:00.000Z',
        reminderRelative: null,
        reminderDueTime: null,
      },
    });
  });
});
