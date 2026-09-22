export interface WorkTodoRfc3339Instant {
  epochSecond: number;
  fraction: string;
}

export const WORK_TODO_SYNC_TIMESTAMP_MAX_LENGTH = 64;

export const WORK_TODO_RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses exactly the RFC3339 grammar accepted for Work To Do sync checkpoints.
 * The fractional digits remain text so ordering never loses precision.
 */
export function parseWorkTodoRfc3339Instant(
  value: string,
): WorkTodoRfc3339Instant | null {
  const match = WORK_TODO_RFC3339_PATTERN.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', fraction = '', zone] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return null;

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    local.getUTCFullYear() !== year
    || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day
    || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute
    || local.getUTCSeconds() !== second
  ) {
    return null;
  }

  let offsetSeconds = 0;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetSeconds = (offsetHour * 60 + offsetMinute) * 60;
    if (zone[0] === '-') offsetSeconds *= -1;
  }

  let fractionEnd = fraction.length;
  while (fractionEnd > 0 && fraction.charCodeAt(fractionEnd - 1) === 48) {
    fractionEnd -= 1;
  }

  return {
    epochSecond: local.getTime() / 1_000 - offsetSeconds,
    fraction: fraction.slice(0, fractionEnd),
  };
}

/** Validates an inbound checkpoint while legacy stored rows remain orderable. */
export function parseWorkTodoSyncTimestamp(
  value: string,
): WorkTodoRfc3339Instant | null {
  if (value.length > WORK_TODO_SYNC_TIMESTAMP_MAX_LENGTH) return null;
  return parseWorkTodoRfc3339Instant(value);
}
