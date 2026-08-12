import { getTimezone } from '@/lib/mode';
import { fromZonedTime } from 'date-fns-tz';

/**
 * Format a Date as YYYY-MM-DD in the configured timezone.
 * Avoids the UTC rollover issue where toISOString().split('T')[0]
 * returns tomorrow's date after local midnight vs UTC midnight.
 */
export function formatDateInLocalTimezone(date: Date): string {
  const tz = getTimezone();
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/**
 * Get today's date as YYYY-MM-DD in the configured timezone.
 *
 * NOTE: This file imports from mode.ts which uses Node.js 'fs'.
 * Only import this from server-side code (API routes, connectors).
 */
export function getLocalToday(): string {
  return formatDateInLocalTimezone(new Date());
}

/**
 * Get a date N days from now as YYYY-MM-DD in the configured timezone.
 */
export function getLocalDaysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return formatDateInLocalTimezone(d);
}

/**
 * Get the current time as an ISO string anchored to the configured timezone's "today".
 * Useful for timestamps that need to be date-consistent (e.g., seed data).
 */
export function getLocalNowISO(): string {
  return new Date().toISOString();
}

/**
 * Convert a local date string (YYYY-MM-DD in the given timezone) to the UTC Date
 * representing midnight (00:00:00) on that local date.
 *
 * Works for all IANA timezones including UTC±14.
 */
function localDateToMidnightUTC(localDateStr: string, tz: string): Date {
  return fromZonedTime(`${localDateStr}T00:00:00`, tz);
}

export function getLocalDateBoundsISO(localDateStr: string): { dayStart: string; nextDayStart: string } {
  const tz = getTimezone();
  const dayStart = localDateToMidnightUTC(localDateStr, tz);
  const nextDayRef = new Date(dayStart.getTime() + 25 * 3600 * 1000);
  const nextDayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(nextDayRef);
  const nextDayStart = localDateToMidnightUTC(nextDayStr, tz);

  return {
    dayStart: dayStart.toISOString(),
    nextDayStart: nextDayStart.toISOString(),
  };
}

/**
 * Parse stored ISO timestamps consistently. Some connectors omit a UTC suffix
 * even though their timestamps are UTC, so bare timestamps must not inherit the
 * server process timezone.
 */
export function parseStoredTimestamp(timestamp: string): number {
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp);
  return Date.parse(hasTimezone ? timestamp : `${timestamp}Z`);
}

export function isTimestampWithinBounds(
  timestamp: string,
  dayStart: string,
  nextDayStart: string,
): boolean {
  const value = parseStoredTimestamp(timestamp);
  return Number.isFinite(value)
    && value >= Date.parse(dayStart)
    && value < Date.parse(nextDayStart);
}

/**
 * Get UTC-equivalent ISO timestamps for the start and end of "today" in the
 * configured timezone.  Use these for date-range queries where timestamps are
 * stored in UTC but "today" should reflect the user's local calendar day.
 *
 * NOTE: Only import this from server-side code (API routes, server libs).
 */
export function getLocalDayBoundsISO(): { todayStart: string; tomorrowStart: string } {
  const { dayStart, nextDayStart } = getLocalDateBoundsISO(getLocalToday());

  return {
    todayStart: dayStart,
    tomorrowStart: nextDayStart,
  };
}
