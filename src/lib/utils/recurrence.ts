import { fromZonedTime } from 'date-fns-tz';

/**
 * Maximum number of recurrence iterations when advancing past overdue dates.
 * 1000 iterations covers even a daily task that has been overdue for ~2.7 years,
 * which far exceeds any realistic use case while still preventing infinite loops
 * for unknown/custom recurrence patterns that may advance by only 1 day at a time.
 */
const MAX_RECURRENCE_ITERATIONS = 1000;

/**
 * Advance a Date by one recurrence interval, mutating the passed object.
 */
function advanceDate(d: Date, recurrence: string): void {
  switch (recurrence) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekdays':
      // Advance by at least one day, then skip over any weekend days
      d.setDate(d.getDate() + 1);
      while (d.getDay() === 0 || d.getDay() === 6) {
        d.setDate(d.getDate() + 1);
      }
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'biweekly':
      d.setDate(d.getDate() + 14);
      break;
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      break;
    case 'yearly':
      d.setFullYear(d.getFullYear() + 1);
      break;
    default: {
      // "every N days"
      const daysMatch = recurrence.match(/^every (\d+) days?$/i);
      if (daysMatch) {
        d.setDate(d.getDate() + parseInt(daysMatch[1], 10));
        return;
      }
      // "every N weeks"
      const weeksMatch = recurrence.match(/^every (\d+) weeks?$/i);
      if (weeksMatch) {
        d.setDate(d.getDate() + parseInt(weeksMatch[1], 10) * 7);
        return;
      }
      // "every N months"
      const monthsMatch = recurrence.match(/^every (\d+) months?$/i);
      if (monthsMatch) {
        d.setMonth(d.getMonth() + parseInt(monthsMatch[1], 10));
        return;
      }
      // "every N years"
      const yearsMatch = recurrence.match(/^every (\d+) years?$/i);
      if (yearsMatch) {
        d.setFullYear(d.getFullYear() + parseInt(yearsMatch[1], 10));
        return;
      }
      // "weekly (monday, wednesday, ...)" or "every N weeks (monday, wednesday, ...)"
      const weeklyDaysMatch = recurrence.match(/^(?:weekly|every (\d+) weeks?) \(([^)]+)\)$/i);
      if (weeklyDaysMatch) {
        const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const intervalWeeks = weeklyDaysMatch[1] ? parseInt(weeklyDaysMatch[1], 10) : 1;
        const allowed = weeklyDaysMatch[2].split(',').map((s) => s.trim().toLowerCase());
        if (intervalWeeks <= 1) {
          // Simple weekly: advance day-by-day to the next allowed day
          d.setDate(d.getDate() + 1);
          for (let i = 0; i < 7; i++) {
            if (allowed.length > 0 && allowed.includes(DAY_NAMES[d.getDay()])) break;
            d.setDate(d.getDate() + 1);
          }
        } else {
          // Multi-week: jump N weeks, then find the first allowed day in that week
          d.setDate(d.getDate() + intervalWeeks * 7);
          // Wind back to the Monday of the target week
          const dayOfWeek = d.getDay();
          const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
          d.setDate(d.getDate() + mondayOffset);
          // Find first allowed day in the week (scan Sun-Sat)
          for (let i = 0; i < 7; i++) {
            if (allowed.includes(DAY_NAMES[d.getDay()])) return;
            d.setDate(d.getDate() + 1);
          }
        }
        return;
      }
      // Unknown/custom pattern — advance by 1 day as a safe fallback
      d.setDate(d.getDate() + 1);
    }
  }
}

function formatDateYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Extract the recurrence pattern from a task's metadata. Metadata columns are
 * stored as JSON in the database (Drizzle's `mode: 'json'`), so API responses
 * deliver it as an already-parsed object — only some legacy/manual call sites
 * still pass a raw JSON string. Handle both to avoid silently losing recurrence.
 * Returns null if metadata is absent, malformed, or contains no recurrence.
 */
export function extractRecurrenceFromMetadata(
  metadata: Record<string, unknown> | string | null | undefined,
): string | null {
  if (!metadata) return null;
  const parsed = typeof metadata === 'string'
    ? (() => {
        try {
          return JSON.parse(metadata) as Record<string, unknown>;
        } catch {
          return null;
        }
      })()
    : metadata;
  return typeof parsed?.recurrence === 'string' ? parsed.recurrence : null;
}

/**
 * Given an overdue recurring task, calculate the next due date that falls on or after today.
 *
 * The function repeatedly advances the current due date by the recurrence interval until
 * it reaches a date >= today, mimicking the "Skip to current" behaviour in Microsoft To Do.
 *
 * @param currentDueDate - The task's current (overdue) due date as YYYY-MM-DD.
 * @param recurrence     - Recurrence pattern string (e.g. 'daily', 'weekly', 'monthly').
 * @param today          - Today's date as YYYY-MM-DD.
 * @returns The earliest upcoming occurrence as YYYY-MM-DD (>= today).
 */
export function getNextRecurringDate(
  currentDueDate: string,
  recurrence: string,
  today: string,
): string {
  const [y, m, dayOfMonth] = currentDueDate.split('-').map(Number);
  const d = new Date(y, m - 1, dayOfMonth);
  const [ty, tm, td] = today.split('-').map(Number);
  const todayDate = new Date(ty, tm - 1, td);

  // If the current date is already today or future, return it unchanged
  if (d >= todayDate) return formatDateYMD(d);

  // Advance until we reach today or beyond
  let iterations = 0;
  while (d < todayDate && iterations < MAX_RECURRENCE_ITERATIONS) {
    advanceDate(d, recurrence);
    iterations++;
  }

  return formatDateYMD(d);
}

/**
 * Advance exactly one interval from the local date/time at which an occurrence
 * was completed. Date-only tasks remain date-only; timed tasks retain the
 * completion wall-clock time in the configured timezone.
 */
export function getCompletionAnchoredDueDate(
  completedAt: string,
  recurrence: string,
  timezone: string,
  includeTime: boolean,
): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(completedAt))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const date = new Date(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
  );
  advanceDate(date, recurrence);
  const nextDate = formatDateYMD(date);
  if (!includeTime) return nextDate;

  return fromZonedTime(
    `${nextDate}T${parts.hour}:${parts.minute}:${parts.second}`,
    timezone,
  ).toISOString();
}
