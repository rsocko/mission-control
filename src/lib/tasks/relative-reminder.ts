import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

export const REMINDER_RELATIVE_RULE_VALUES = [
  '1_hour_before',
  '1_day_before',
  '3_days_before',
  '1_week_before',
] as const;

export type ReminderRelativeRule = typeof REMINDER_RELATIVE_RULE_VALUES[number];

export const REMINDER_RELATIVE_RULES = {
  '1_hour_before': { label: '1 hour before', hours: 1, calendarDays: 0 },
  '1_day_before': { label: '1 day before', hours: 0, calendarDays: 1 },
  '3_days_before': { label: '3 days before', hours: 0, calendarDays: 3 },
  '1_week_before': { label: '1 week before', hours: 0, calendarDays: 7 },
} as const satisfies Record<
  ReminderRelativeRule,
  { label: string; hours: number; calendarDays: number }
>;

export interface RelativeReminderInput {
  dueDate: string;
  dueTime: string;
  timezone: string;
  rule: ReminderRelativeRule;
}

export type RelativeReminderComputation =
  | { success: true; reminderAt: string }
  | {
      success: false;
      code: 'INVALID_DUE_DATE' | 'INVALID_DUE_TIME' | 'INVALID_TIMEZONE' | 'INVALID_LOCAL_TIME';
      error: string;
    };

export function computeRelativeReminderAt(
  input: RelativeReminderInput,
): RelativeReminderComputation {
  const dueDate = input.dueDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return { success: false, code: 'INVALID_DUE_DATE', error: 'A valid due date is required' };
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.dueTime)) {
    return { success: false, code: 'INVALID_DUE_TIME', error: 'A valid due time is required' };
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: input.timezone });
  } catch {
    return { success: false, code: 'INVALID_TIMEZONE', error: 'A valid IANA timezone is required' };
  }

  const localDueDateTime = `${dueDate}T${input.dueTime}`;
  const dueInstant = fromZonedTime(localDueDateTime, input.timezone);
  if (
    Number.isNaN(dueInstant.getTime())
    || formatInTimeZone(dueInstant, input.timezone, "yyyy-MM-dd'T'HH:mm") !== localDueDateTime
  ) {
    return {
      success: false,
      code: 'INVALID_LOCAL_TIME',
      error: 'The due time does not exist in the configured timezone because of daylight saving time',
    };
  }

  const rule = REMINDER_RELATIVE_RULES[input.rule];
  // Hour rules are elapsed time; day/week rules preserve the configured local wall time.
  if (rule.hours > 0) {
    return {
      success: true,
      reminderAt: new Date(dueInstant.getTime() - rule.hours * 60 * 60 * 1000).toISOString(),
    };
  }

  const reminderDate = new Date(`${dueDate}T12:00:00.000Z`);
  reminderDate.setUTCDate(reminderDate.getUTCDate() - rule.calendarDays);
  const localReminderDateTime = `${reminderDate.toISOString().slice(0, 10)}T${input.dueTime}`;
  const reminderInstant = fromZonedTime(localReminderDateTime, input.timezone);
  if (
    Number.isNaN(reminderInstant.getTime())
    || formatInTimeZone(reminderInstant, input.timezone, "yyyy-MM-dd'T'HH:mm") !== localReminderDateTime
  ) {
    return {
      success: false,
      code: 'INVALID_LOCAL_TIME',
      error: 'The reminder time does not exist in the configured timezone because of daylight saving time',
    };
  }
  return { success: true, reminderAt: reminderInstant.toISOString() };
}

export function isReminderRelativeRule(value: string): value is ReminderRelativeRule {
  return Object.prototype.hasOwnProperty.call(REMINDER_RELATIVE_RULES, value);
}

interface RelativeReminderState {
  dueDate: string | null;
  reminderAt: string | null;
  reminderRelative: string | null;
  reminderDueTime: string | null;
}

interface RelativeReminderMutationInput {
  dueDate?: string | null;
  reminderAt?: string | null;
  reminderRelative?: ReminderRelativeRule | null;
  reminderDueTime?: string | null;
  relativeReminderDueDateResolution?: 'remove' | 'convert_to_absolute';
}

export type RelativeReminderMutationResult =
  | {
      success: true;
      updates: {
        reminderAt?: string | null;
        reminderRelative?: ReminderRelativeRule | null;
        reminderDueTime?: string | null;
      };
    }
  | {
      success: false;
      status: 400 | 409;
      code:
        | 'INVALID_DUE_DATE'
        | 'INVALID_DUE_TIME'
        | 'INVALID_TIMEZONE'
        | 'INVALID_LOCAL_TIME'
        | 'RELATIVE_REMINDER_DUE_TIME_REQUIRED'
        | 'RELATIVE_REMINDER_DUE_DATE_REQUIRED'
        | 'RELATIVE_REMINDER_IN_PAST';
      error: string;
    };

export function resolveRelativeReminderMutation(options: {
  current: RelativeReminderState;
  input: RelativeReminderMutationInput;
  timezone: string;
  now?: Date;
}): RelativeReminderMutationResult {
  const { current, input, timezone } = options;
  const updates: Extract<RelativeReminderMutationResult, { success: true }>['updates'] = {};
  const relativeRule = input.reminderRelative !== undefined
    ? input.reminderRelative
    : isReminderRelativeRule(current.reminderRelative ?? '')
      ? current.reminderRelative as ReminderRelativeRule
      : null;
  const dueDate = input.dueDate !== undefined ? input.dueDate : current.dueDate;
  const dueTime = input.reminderDueTime !== undefined
    ? input.reminderDueTime
    : current.reminderDueTime;

  if (input.reminderAt !== undefined && input.reminderRelative === undefined) {
    updates.reminderAt = input.reminderAt;
    updates.reminderRelative = null;
    updates.reminderDueTime = null;
    return { success: true, updates };
  }

  if (input.reminderRelative === null) {
    updates.reminderRelative = null;
    updates.reminderDueTime = null;
    if (input.reminderAt !== undefined) updates.reminderAt = input.reminderAt;
    return { success: true, updates };
  }

  if (!relativeRule) {
    if (input.reminderDueTime !== undefined) {
      return {
        success: false,
        status: 400,
        code: 'RELATIVE_REMINDER_DUE_DATE_REQUIRED',
        error: 'Choose a relative reminder before setting its due time',
      };
    }
    return { success: true, updates };
  }

  if (!dueDate) {
    if (input.reminderRelative && !current.reminderRelative) {
      return {
        success: false,
        status: 400,
        code: 'RELATIVE_REMINDER_DUE_DATE_REQUIRED',
        error: 'Set a due date before choosing a relative reminder',
      };
    }
    if (input.relativeReminderDueDateResolution === 'remove') {
      return {
        success: true,
        updates: { reminderAt: null, reminderRelative: null, reminderDueTime: null },
      };
    }
    if (input.relativeReminderDueDateResolution === 'convert_to_absolute') {
      return {
        success: true,
        updates: {
          reminderAt: current.reminderAt,
          reminderRelative: null,
          reminderDueTime: null,
        },
      };
    }
    return {
      success: false,
      status: 409,
      code: 'RELATIVE_REMINDER_DUE_DATE_REQUIRED',
      error: 'Choose whether to remove the relative reminder or keep its current time',
    };
  }
  if (!dueTime) {
    return {
      success: false,
      status: 400,
      code: 'RELATIVE_REMINDER_DUE_TIME_REQUIRED',
      error: 'Set a due time before choosing a relative reminder',
    };
  }

  const computed = computeRelativeReminderAt({
    dueDate,
    dueTime,
    timezone,
    rule: relativeRule,
  });
  if (!computed.success) {
    return { success: false, status: 400, code: computed.code, error: computed.error };
  }
  if (new Date(computed.reminderAt) <= (options.now ?? new Date())) {
    return {
      success: false,
      status: 409,
      code: 'RELATIVE_REMINDER_IN_PAST',
      error: 'The relative reminder would be in the past',
    };
  }

  return {
    success: true,
    updates: {
      reminderAt: computed.reminderAt,
      reminderRelative: relativeRule,
      reminderDueTime: dueTime,
    },
  };
}
