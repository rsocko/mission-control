import type { Routine } from './types';

export type TodayRoutine = Pick<
  Routine,
  | 'id'
  | 'name'
  | 'icon'
  | 'cadenceType'
  | 'cadenceConfig'
  | 'sortOrder'
  | 'streak'
  | 'weekCompletions'
  | 'intervalStatus'
  | 'weeklyProgress'
>;

export function isRoutineComplete(routine: TodayRoutine, today: string): boolean {
  return routine.weekCompletions.some((completion) => completion.date === today);
}

function getDaysRemainingInWeek(today: string): number {
  const day = new Date(`${today}T12:00:00`).getDay();
  const mondayBasedDay = day === 0 ? 6 : day - 1;
  return 7 - mondayBasedDay;
}

function isWeeklyTargetDue(routine: TodayRoutine, today: string): boolean {
  const target = routine.weeklyProgress?.target ?? routine.cadenceConfig.target ?? 1;
  const done = routine.weeklyProgress?.done
    ?? new Set(routine.weekCompletions.map((completion) => completion.date)).size;
  const remaining = Math.max(0, target - done);

  return remaining > 0 && remaining >= getDaysRemainingInWeek(today);
}

function getPromotionRank(routine: TodayRoutine, today: string): number | null {
  if (routine.intervalStatus?.status === 'overdue_soft') return 0;
  if (routine.intervalStatus?.status === 'due_soon') return 1;

  if (routine.cadenceType === 'specific_days') {
    const day = new Date(`${today}T12:00:00`).getDay();
    return routine.cadenceConfig.days?.includes(day) ? 2 : null;
  }

  if (routine.cadenceType === 'daily') return 3;
  if (routine.cadenceType === 'x_per_week' && isWeeklyTargetDue(routine, today)) return 4;

  return null;
}

function compareRoutineIdentity(a: TodayRoutine, b: TodayRoutine): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

export function groupTodayRoutines(
  routines: TodayRoutine[],
  today: string,
): { promoted: TodayRoutine[]; other: TodayRoutine[] } {
  const promoted: Array<{ routine: TodayRoutine; rank: number }> = [];
  const other: TodayRoutine[] = [];

  for (const routine of routines) {
    const rank = getPromotionRank(routine, today);
    if (rank === null) {
      other.push(routine);
    } else {
      promoted.push({ routine, rank });
    }
  }

  promoted.sort((a, b) => {
    const completionOrder = Number(isRoutineComplete(a.routine, today))
      - Number(isRoutineComplete(b.routine, today));
    return completionOrder || a.rank - b.rank || compareRoutineIdentity(a.routine, b.routine);
  });

  other.sort((a, b) => {
    const completionOrder = Number(isRoutineComplete(a, today))
      - Number(isRoutineComplete(b, today));
    return completionOrder || compareRoutineIdentity(a, b);
  });

  return {
    promoted: promoted.map(({ routine }) => routine),
    other,
  };
}

function getCadenceLabel(routine: TodayRoutine): string {
  switch (routine.cadenceType) {
    case 'daily':
      return 'Daily';
    case 'specific_days': {
      const days = [...(routine.cadenceConfig.days ?? [])].sort((a, b) => a - b);
      if (days.join(',') === '1,2,3,4,5') return 'Weekdays';
      if (days.join(',') === '0,6') return 'Weekends';
      const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return days.map((day) => dayLabels[day]).filter(Boolean).join(', ') || 'Scheduled days';
    }
    case 'x_per_week': {
      const target = routine.weeklyProgress?.target ?? routine.cadenceConfig.target ?? 1;
      return `${target}x/week`;
    }
    case 'every_n_days': {
      const minDays = routine.cadenceConfig.minDays ?? 1;
      const maxDays = routine.cadenceConfig.maxDays ?? 7;
      return minDays === maxDays ? `Every ${maxDays} days` : `Every ${minDays}-${maxDays} days`;
    }
    case 'weekly':
      return 'Weekly';
    case 'monthly':
      return 'Monthly';
    case 'quarterly':
      return 'Quarterly';
  }
}

function getIntervalDays(routine: TodayRoutine): number {
  switch (routine.cadenceType) {
    case 'every_n_days':
      return routine.cadenceConfig.maxDays ?? 7;
    case 'weekly':
      return 7;
    case 'monthly':
      return 30;
    case 'quarterly':
      return 90;
    default:
      return 0;
  }
}

export function getRoutineDetail(routine: TodayRoutine, completed = false): string {
  const cadence = getCadenceLabel(routine);
  if (completed) return `${cadence} · completed today`;

  if (routine.cadenceType === 'x_per_week') {
    const done = routine.weeklyProgress?.done ?? 0;
    const target = routine.weeklyProgress?.target ?? routine.cadenceConfig.target ?? 1;
    return `${cadence} · ${done} of ${target} complete`;
  }

  if (routine.cadenceType === 'specific_days') {
    return `${cadence} · scheduled today`;
  }

  if (routine.intervalStatus?.status === 'overdue_soft') {
    const daysOverdue = Math.max(1, routine.intervalStatus.daysSinceLast - getIntervalDays(routine));
    return `${cadence} · overdue by ${daysOverdue} day${daysOverdue === 1 ? '' : 's'}`;
  }

  if (routine.intervalStatus?.status === 'due_soon') {
    if (routine.intervalStatus.daysSinceLast === 0) return `${cadence} · ready to start`;
    const daysUntilDue = Math.max(0, getIntervalDays(routine) - routine.intervalStatus.daysSinceLast);
    if (daysUntilDue === 0) return `${cadence} · due today`;
    return `${cadence} · due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}`;
  }

  const daysSinceLast = routine.intervalStatus?.daysSinceLast;
  if (daysSinceLast === 0) return `${cadence} · logged today`;
  if (daysSinceLast === 1) return `${cadence} · logged yesterday`;
  if (typeof daysSinceLast === 'number') return `${cadence} · logged ${daysSinceLast} days ago`;
  return cadence;
}

export function getQuickActionLimit(width: number): number {
  if (width < 480) return 2;
  if (width < 640) return 3;
  if (width < 800) return 4;
  return 6;
}
