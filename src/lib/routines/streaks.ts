/**
 * Streak calculation engine for multi-cadence routines.
 *
 * Each cadence type has its own logic for what constitutes a "consecutive" period:
 * - daily: consecutive days completed
 * - specific_days: consecutive scheduled days completed
 * - x_per_week: consecutive weeks meeting target count
 * - every_n_days: consecutive completions within the max interval
 * - weekly: consecutive weeks with at least one completion
 * - monthly: consecutive months with at least one completion
 * - quarterly: consecutive quarters with at least one completion
 */

export interface CadenceConfig {
  days?: number[];        // specific_days: 0=Sun..6=Sat
  target?: number;        // x_per_week
  minDays?: number;       // every_n_days
  maxDays?: number;       // every_n_days
  preferredDay?: string;  // weekly/monthly/quarterly
}

interface CompletionRecord {
  date: string; // YYYY-MM-DD
}

function parseDate(dateStr: string): Date {
  return new Date(dateStr + 'T12:00:00');
}

/** Format a Date as YYYY-MM-DD in local time (avoids UTC rollover in UTC+13/14). */
function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function getWeekMonday(d: Date): string {
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  return formatDate(monday);
}

function getMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getQuarterKey(d: Date): string {
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

/**
 * Calculate streak for a routine given its completions.
 * Returns the current streak count (0 if none).
 */
export function calculateStreak(
  cadenceType: string,
  cadenceConfig: CadenceConfig,
  completions: CompletionRecord[],
  today: string,
): number {
  if (completions.length === 0) return 0;

  const sorted = [...completions].sort((a, b) => b.date.localeCompare(a.date));
  const todayDate = parseDate(today);

  switch (cadenceType) {
    case 'daily':
      return calculateDailyStreak(sorted, todayDate);
    case 'specific_days':
      return calculateSpecificDaysStreak(sorted, cadenceConfig, todayDate);
    case 'x_per_week':
      return calculateXPerWeekStreak(sorted, cadenceConfig, todayDate);
    case 'every_n_days':
      return calculateEveryNDaysStreak(sorted, cadenceConfig, todayDate);
    case 'weekly':
      return calculateWeeklyStreak(sorted, todayDate);
    case 'monthly':
      return calculateMonthlyStreak(sorted);
    case 'quarterly':
      return calculateQuarterlyStreak(sorted);
    default:
      return 0;
  }
}

function calculateDailyStreak(sorted: CompletionRecord[], today: Date): number {
  const uniqueDates = [...new Set(sorted.map(c => c.date))].sort((a, b) => b.localeCompare(a));
  const latestDate = parseDate(uniqueDates[0]);
  const gap = daysBetween(latestDate, today);
  if (gap > 1) return 0;

  let streak = 1;
  for (let i = 1; i < uniqueDates.length; i++) {
    const prev = parseDate(uniqueDates[i - 1]);
    const curr = parseDate(uniqueDates[i]);
    if (daysBetween(curr, prev) === 1) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function calculateSpecificDaysStreak(
  sorted: CompletionRecord[],
  config: CadenceConfig,
  today: Date,
): number {
  const scheduledDays = new Set(config.days || []);
  if (scheduledDays.size === 0) return 0;

  const completedDates = new Set(sorted.map(c => c.date));
  const todayStr = formatDate(today);

  let streak = 0;
  const d = new Date(today);

  for (let i = 0; i < 365; i++) {
    if (scheduledDays.has(d.getDay())) {
      const dateStr = formatDate(d);
      if (dateStr > todayStr) {
        d.setDate(d.getDate() - 1);
        continue;
      }
      if (completedDates.has(dateStr)) {
        streak++;
      } else if (dateStr === todayStr) {
        // Allow today to be incomplete
        d.setDate(d.getDate() - 1);
        continue;
      } else {
        break;
      }
    }
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function calculateXPerWeekStreak(
  sorted: CompletionRecord[],
  config: CadenceConfig,
  today: Date,
): number {
  const target = config.target || 1;
  const weekCounts = new Map<string, number>();
  for (const c of sorted) {
    const weekKey = getWeekMonday(parseDate(c.date));
    weekCounts.set(weekKey, (weekCounts.get(weekKey) || 0) + 1);
  }

  let streak = 0;
  const d = new Date(today);
  const currentWeek = getWeekMonday(d);

  for (let i = 0; i < 52; i++) {
    const weekKey = getWeekMonday(d);
    const count = weekCounts.get(weekKey) || 0;

    if (weekKey === currentWeek) {
      if (count >= target) streak++;
    } else {
      if (count >= target) {
        streak++;
      } else {
        break;
      }
    }
    d.setDate(d.getDate() - 7);
  }

  return streak;
}

function calculateEveryNDaysStreak(
  sorted: CompletionRecord[],
  config: CadenceConfig,
  today: Date,
): number {
  const maxInterval = config.maxDays || 7;
  const uniqueDates = [...new Set(sorted.map(c => c.date))].sort((a, b) => b.localeCompare(a));
  const latestDate = parseDate(uniqueDates[0]);
  if (daysBetween(latestDate, today) > maxInterval) return 0;

  let streak = 1;
  for (let i = 1; i < uniqueDates.length; i++) {
    const prev = parseDate(uniqueDates[i - 1]);
    const curr = parseDate(uniqueDates[i]);
    if (daysBetween(curr, prev) <= maxInterval) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function calculateWeeklyStreak(sorted: CompletionRecord[], today: Date): number {
  const weeks = new Set(sorted.map(c => getWeekMonday(parseDate(c.date))));
  const weeksList = [...weeks].sort((a, b) => b.localeCompare(a));
  if (weeksList.length === 0) return 0;

  const currentWeek = getWeekMonday(today);
  if (weeksList[0] !== currentWeek) {
    const gap = daysBetween(parseDate(weeksList[0]), today);
    if (gap > 13) return 0;
  }

  let streak = 1;
  for (let i = 1; i < weeksList.length; i++) {
    const prev = parseDate(weeksList[i - 1]);
    const curr = parseDate(weeksList[i]);
    if (daysBetween(curr, prev) === 7) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function calculateMonthlyStreak(sorted: CompletionRecord[]): number {
  const months = new Set(sorted.map(c => getMonthKey(parseDate(c.date))));
  const monthsList = [...months].sort((a, b) => b.localeCompare(a));
  if (monthsList.length === 0) return 0;

  let streak = 1;
  for (let i = 1; i < monthsList.length; i++) {
    const [prevYear, prevMonth] = monthsList[i - 1].split('-').map(Number);
    const [currYear, currMonth] = monthsList[i].split('-').map(Number);
    const expectedMonth = prevMonth === 1 ? 12 : prevMonth - 1;
    const expectedYear = prevMonth === 1 ? prevYear - 1 : prevYear;
    if (currYear === expectedYear && currMonth === expectedMonth) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function calculateQuarterlyStreak(sorted: CompletionRecord[]): number {
  const quarters = new Set(sorted.map(c => getQuarterKey(parseDate(c.date))));
  const quartersList = [...quarters].sort((a, b) => b.localeCompare(a));
  if (quartersList.length === 0) return 0;

  let streak = 1;
  for (let i = 1; i < quartersList.length; i++) {
    const [prevYear, prevQ] = quartersList[i - 1].split('-Q').map(Number);
    const [currYear, currQ] = quartersList[i].split('-Q').map(Number);
    const expectedQ = prevQ === 1 ? 4 : prevQ - 1;
    const expectedYear = prevQ === 1 ? prevYear - 1 : prevYear;
    if (currYear === expectedYear && currQ === expectedQ) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * For "every_n_days" / "weekly" / "monthly" / "quarterly" cadence,
 * get the status relative to the interval window.
 */
export function getIntervalStatus(
  cadenceType: string,
  config: CadenceConfig,
  lastCompletionDate: string | null,
  today: string,
): { status: 'on_track' | 'due_soon' | 'overdue_soft'; daysSinceLast: number; progressPercent: number } {
  if (!lastCompletionDate) {
    return { status: 'due_soon', daysSinceLast: 0, progressPercent: 0 };
  }

  const daysSince = daysBetween(parseDate(lastCompletionDate), parseDate(today));
  let maxDays: number;

  switch (cadenceType) {
    case 'every_n_days':
      maxDays = config.maxDays || 7;
      break;
    case 'weekly':
      maxDays = 7;
      break;
    case 'monthly':
      maxDays = 30;
      break;
    case 'quarterly':
      maxDays = 90;
      break;
    default:
      maxDays = 7;
  }

  const progressPercent = Math.min(100, Math.round((daysSince / maxDays) * 100));
  const minDays = cadenceType === 'every_n_days' ? (config.minDays || 1) : 0;
  const warningThreshold = Math.floor(maxDays * 0.7);

  if (daysSince < minDays) {
    // Within rest period — not expected yet
    return { status: 'on_track', daysSinceLast: daysSince, progressPercent };
  }
  if (daysSince <= warningThreshold) {
    return { status: 'on_track', daysSinceLast: daysSince, progressPercent };
  }
  if (daysSince <= maxDays) {
    return { status: 'due_soon', daysSinceLast: daysSince, progressPercent };
  }
  return { status: 'overdue_soft', daysSinceLast: daysSince, progressPercent };
}

/**
 * For "x_per_week" cadence, compute weekly progress.
 */
export function getWeeklyProgress(
  config: CadenceConfig,
  completionsThisWeek: CompletionRecord[],
): { done: number; target: number; isOver: boolean; bonus: number } {
  const target = config.target || 1;
  const done = new Set(completionsThisWeek.map(c => c.date)).size;
  return {
    done,
    target,
    isOver: done > target,
    bonus: Math.max(0, done - target),
  };
}
