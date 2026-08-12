export interface RoutineCadenceConfig {
  days?: number[];
  target?: number;
  minDays?: number;
  maxDays?: number;
}

interface BuildRoutineHeatmapDaysOptions {
  weekMonday: string;
  today: string;
  cadenceType: string;
  config: RoutineCadenceConfig;
  completionDates: readonly string[];
  priorCompletionDate?: string;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function daysBetween(start: string, end: string): number {
  const startDate = new Date(start + 'T00:00:00');
  const endDate = new Date(end + 'T00:00:00');
  return Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
}

function findLastCompletionBefore(sortedDates: readonly string[], date: string): string | null {
  let result: string | null = null;
  for (const completionDate of sortedDates) {
    if (completionDate >= date) break;
    result = completionDate;
  }
  return result;
}

function isScheduled(
  cadenceType: string,
  config: RoutineCadenceConfig,
  date: string,
  dayOfWeek: number,
  allCompletionDates: readonly string[],
  weekCompletionCount: number,
): boolean {
  switch (cadenceType) {
    case 'daily':
      return true;
    case 'specific_days':
      return config.days?.includes(dayOfWeek) ?? true;
    case 'every_n_days': {
      const lastCompletion = findLastCompletionBefore(allCompletionDates, date);
      if (!lastCompletion) return true;
      return daysBetween(lastCompletion, date) > (config.maxDays ?? 7);
    }
    case 'x_per_week':
      return weekCompletionCount < (config.target ?? 1) && dayOfWeek === 0;
    case 'weekly':
      return weekCompletionCount === 0 && dayOfWeek === 0;
    case 'monthly':
    case 'quarterly':
      return false;
    default:
      return true;
  }
}

export function buildRoutineHeatmapDays({
  weekMonday,
  today,
  cadenceType,
  config,
  completionDates,
  priorCompletionDate,
}: BuildRoutineHeatmapDaysOptions): (boolean | null)[] {
  const weekCompletions = new Set(completionDates);
  const allCompletionDates = [...weekCompletions];
  if (priorCompletionDate) allCompletionDates.push(priorCompletionDate);
  allCompletionDates.sort();

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekMonday + 'T12:00:00');
    date.setDate(date.getDate() + index);
    const dateString = formatDate(date);

    if (weekCompletions.has(dateString)) return true;
    if (dateString > today) return null;

    return isScheduled(
      cadenceType,
      config,
      dateString,
      date.getDay(),
      allCompletionDates,
      weekCompletions.size,
    )
      ? false
      : null;
  });
}
