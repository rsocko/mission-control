import {
  RECURRENCE_WEEKDAYS,
  createCanonicalRecurrenceRule,
  type CanonicalRecurrenceRuleV1,
  type RecurrenceEnd,
  type RecurrencePattern,
  type RecurrenceSupportStatus,
  type RecurrenceWeekday,
} from '@/lib/recurrence/canonical';
import type { GraphTodoTask } from './types';

type MicrosoftRecurrence = NonNullable<GraphTodoTask['recurrence']>;

export interface MicrosoftRecurrenceMappingInput {
  readonly recurrence: MicrosoftRecurrence;
  readonly rawRecurrence?: unknown;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly providerTaskId: string;
  readonly dueDate?: string;
  readonly createdAt: string;
  readonly timezone: string;
  readonly localTime?: string | null;
  readonly legacyLabel: string;
  readonly missionControlSeriesId?: string;
}

function isCalendarDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function weekdayForDate(date: string): RecurrenceWeekday {
  const index = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return RECURRENCE_WEEKDAYS[(index + 6) % 7];
}

function mapPattern(
  recurrence: MicrosoftRecurrence,
  startDate: string,
  reasons: string[],
): RecurrencePattern {
  const { pattern } = recurrence;
  const interval = Number.isInteger(pattern.interval) && pattern.interval > 0
    ? pattern.interval
    : 1;
  if (interval !== pattern.interval) reasons.push('invalid_interval_defaulted');

  if (pattern.type === 'daily') return { type: 'daily', interval };
  if (pattern.type === 'weekly') {
    const providerDays = pattern.daysOfWeek ?? [];
    const recognizedDays = providerDays
      .map((day) => day.toLowerCase())
      .filter((day): day is RecurrenceWeekday => (
        RECURRENCE_WEEKDAYS.includes(day as RecurrenceWeekday)
      ));
    if (recognizedDays.length !== providerDays.length) {
      reasons.push('unrecognized_weekday');
    }
    if (recognizedDays.length === 0) {
      reasons.push('weekly_days_inferred_from_start');
      recognizedDays.push(weekdayForDate(startDate));
    }
    return { type: 'weekly', interval, daysOfWeek: recognizedDays };
  }
  if (pattern.type === 'absoluteMonthly') {
    if (
      !Number.isInteger(pattern.dayOfMonth)
      || pattern.dayOfMonth! < 1
      || pattern.dayOfMonth! > 31
    ) {
      reasons.push('missing_or_invalid_day_of_month');
      return { type: 'unsupported' };
    }
    return { type: 'monthly', interval, dayOfMonth: pattern.dayOfMonth! };
  }
  if (pattern.type === 'absoluteYearly') {
    if (
      !Number.isInteger(pattern.dayOfMonth)
      || pattern.dayOfMonth! < 1
      || pattern.dayOfMonth! > 31
      || !Number.isInteger(pattern.month)
      || pattern.month! < 1
      || pattern.month! > 12
    ) {
      reasons.push('missing_or_invalid_yearly_date');
      return { type: 'unsupported' };
    }
    const [startYear] = startDate.split('-').map(Number);
    const maxDay = new Date(Date.UTC(startYear, pattern.month!, 0)).getUTCDate();
    if (pattern.dayOfMonth! > maxDay) {
      reasons.push('missing_or_invalid_yearly_date');
      return { type: 'unsupported' };
    }
    return {
      type: 'yearly',
      interval,
      month: pattern.month!,
      dayOfMonth: pattern.dayOfMonth!,
    };
  }
  reasons.push(
    pattern.type === 'relativeMonthly' || pattern.type === 'relativeYearly'
      ? 'relative_pattern_not_supported'
      : 'provider_pattern_not_supported',
  );
  return { type: 'unsupported' };
}

function mapEnd(
  recurrence: MicrosoftRecurrence,
  startDate: string,
  reasons: string[],
): RecurrenceEnd {
  if (recurrence.range.type === 'noEnd') return { type: 'never' };
  if (
    recurrence.range.type === 'endDate'
    && isCalendarDate(recurrence.range.endDate)
    && recurrence.range.endDate >= startDate
  ) {
    return { type: 'date', date: recurrence.range.endDate };
  }
  if (
    recurrence.range.type === 'numbered'
    && Number.isInteger(recurrence.range.numberOfOccurrences)
    && recurrence.range.numberOfOccurrences! > 0
  ) {
    return { type: 'count', count: recurrence.range.numberOfOccurrences! };
  }
  reasons.push('provider_range_not_supported');
  return { type: 'never' };
}

export function mapMicrosoftTodoRecurrence(
  input: MicrosoftRecurrenceMappingInput,
): CanonicalRecurrenceRuleV1 {
  const reasons: string[] = [];
  let startDate = isCalendarDate(input.recurrence.range.startDate)
    ? input.recurrence.range.startDate
    : isCalendarDate(input.dueDate)
      ? input.dueDate
      : input.createdAt.slice(0, 10);
  if (!isCalendarDate(startDate)) {
    startDate = '1970-01-01';
    reasons.push('missing_valid_start_date');
  }

  if (!isCalendarDate(input.recurrence.range.startDate)) {
    reasons.push('start_date_inferred');
  }
  const timezoneKind = isIanaTimezone(input.timezone) ? 'iana' : 'provider';
  if (timezoneKind === 'provider') reasons.push('provider_timezone_not_iana');
  let pattern = mapPattern(input.recurrence, startDate, reasons);
  const end = mapEnd(input.recurrence, startDate, reasons);
  if (reasons.includes('missing_valid_start_date')) pattern = { type: 'unsupported' };
  const unsupported = pattern.type === 'unsupported';
  const supportStatus: RecurrenceSupportStatus = unsupported
    ? 'unsupported'
    : reasons.length > 0
      ? 'lossy'
      : 'supported';
  // Microsoft To Do does not expose a durable series ID. Its task ID is the
  // only stable provider key across edits to one imported occurrence; later
  // provider-created occurrences may receive a new derived series identity.
  const externalSeriesId = `task:${input.providerTaskId}`;

  return createCanonicalRecurrenceRule({
    seriesIdentity: input.missionControlSeriesId
      ? {
          kind: 'mission-control',
          stableId: input.missionControlSeriesId,
          connectorInstanceId: input.connectorInstanceId,
        }
      : {
          kind: 'connector',
          connectorType: input.connectorType,
          connectorInstanceId: input.connectorInstanceId,
          externalSeriesId,
          stability: 'derived',
        },
    semantics: {
      mode: 'schedule',
      timezone: {
        id: input.timezone,
        kind: timezoneKind,
        dstPolicy: 'preserve-wall-clock',
        gapPolicy: 'shift-forward',
        overlapPolicy: 'earlier-offset',
      },
      start: { date: startDate, localTime: input.localTime ?? null },
      pattern,
      end,
      exceptions: { skipDates: [] },
      materialization: { strategy: 'on-schedule', catchUp: 'latest' },
    },
    source: {
      owner: 'connector',
      connectorType: input.connectorType,
      connectorInstanceId: input.connectorInstanceId,
      support: {
        status: supportStatus,
        reasons,
      },
      raw: input.rawRecurrence ?? input.recurrence,
    },
    compatibility: {
      legacyLabel: input.legacyLabel,
      migratedFrom: null,
    },
  });
}
