/**
 * Client-safe date formatting utilities for Mission Control.
 *
 * All functions parse date strings as local time to avoid UTC timezone shifts.
 * Safe to use in both client components and server-side code (no Node.js deps).
 */

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Parse a date string (YYYY-MM-DD or ISO) into a local-time Date.
 * Returns null for invalid/empty inputs.
 */
export function parseLocalDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const datePart = dateStr.split('T')[0];
  const parts = datePart.split('-');
  if (parts.length < 3) return null;
  const [y, m, d] = parts.map(Number);
  if (!y || !m || !d || isNaN(y) || isNaN(m) || isNaN(d)) return null;
  const date = new Date(y, m - 1, d);
  return isNaN(date.getTime()) ? null : date;
}

/** Returns true if the string is a valid date (YYYY-MM-DD or ISO). */
export function isValidDateStr(dateStr: string | null | undefined): dateStr is string {
  if (!dateStr) return false;
  const d = new Date(dateStr.split('T')[0] + 'T00:00:00');
  return !isNaN(d.getTime()) && d.getFullYear() > 1970;
}

/** Get today's midnight as a Date in local time. */
function todayMidnight(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Difference in calendar days between a target date and today. */
function diffDaysFromToday(target: Date): number {
  return Math.round((target.getTime() - todayMidnight().getTime()) / 86400000);
}

// ---------------------------------------------------------------------------
// YYYY-MM-DD formatting
// ---------------------------------------------------------------------------

/**
 * Format a Date as YYYY-MM-DD in local time.
 * Avoids the UTC rollover issue of `toISOString().split('T')[0]`.
 */
export function formatDateLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Format a compact calendar date, including the year when it differs from the
 * current year.
 */
export function formatShortDate(dateStr: string | null | undefined, now = new Date()): string {
  const date = parseLocalDate(dateStr);
  if (!date) return '';
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString('en-US', opts);
}

// ---------------------------------------------------------------------------
// Relative date formatting (for due dates, display)
// ---------------------------------------------------------------------------

/**
 * Format a date string relative to today for task display.
 * Returns "Today", "Tomorrow", "Yesterday", "3d ago", "In 5d", or "Jul 15".
 */
export function formatDate(dateStr: string | null | undefined): string {
  const date = parseLocalDate(dateStr);
  if (!date) return '';
  const now = new Date();
  const diff = diffDaysFromToday(date);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff < -1) return `${Math.abs(diff)}d ago`;
  if (diff <= 7) return `In ${diff}d`;
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString('en-US', opts);
}

/**
 * Format a due date string — uses weekday names for the upcoming week.
 * Returns "Today", "Tomorrow", "Yesterday", "Wednesday", or "Jul 15".
 */
export function formatDueDate(dateStr: string | null): string {
  const date = parseLocalDate(dateStr);
  if (!date) return '';
  const now = new Date();
  const diff = diffDaysFromToday(date);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff <= 6) return date.toLocaleDateString('en-US', { weekday: 'long' });
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString('en-US', opts);
}

/**
 * Format a date with a "reschedule" hint for overdue items.
 * Returns "Today", "Tomorrow", "3d ago — reschedule?", "In 2 weeks".
 */
export function formatRelativeDate(dateStr: string): string {
  const date = parseLocalDate(dateStr);
  if (!date) return '';
  const diff = diffDaysFromToday(date);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff < -1) return `${Math.abs(diff)}d ago — reschedule?`;
  if (diff <= 7) return `In ${diff} days`;
  return `In ${Math.ceil(diff / 7)} weeks`;
}

/**
 * Format a date label with a fallback — useful for project timelines.
 */
export function formatDateLabel(value?: string | null, fallback = '—'): string {
  const date = parseLocalDate(value);
  if (!date) return fallback;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Relative time formatting (for timestamps, sync times)
// ---------------------------------------------------------------------------

/**
 * Format a timestamp as relative time ago: "5m ago", "2h ago", "3d ago".
 */
export function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/**
 * Format a sync timestamp as compact relative time: "Just now", "5m", "2h", "3d".
 */
export function formatSyncTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// ---------------------------------------------------------------------------
// Week/calendar helpers
// ---------------------------------------------------------------------------

/**
 * Get the Monday of the week for a given YYYY-MM-DD date string.
 * Returns a YYYY-MM-DD string.
 */
export function getWeekMonday(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return formatDateLocal(d);
}

/**
 * Get all 7 dates (Mon–Sun) for the week starting at mondayStr.
 * Returns an array of YYYY-MM-DD strings.
 */
export function getWeekDates(mondayStr: string): string[] {
  const dates: string[] = [];
  const d = new Date(mondayStr + 'T12:00:00');
  for (let i = 0; i < 7; i++) {
    dates.push(formatDateLocal(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/**
 * Format a week range display: "Jul 14 – Jul 20, 2026".
 */
export function formatWeekRange(mondayStr: string): string {
  const monday = new Date(mondayStr + 'T12:00:00');
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const mOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const sOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  return `${monday.toLocaleDateString('en-US', mOpts)} – ${sunday.toLocaleDateString('en-US', sOpts)}`;
}
