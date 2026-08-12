'use client';

import { motion } from 'motion/react';
import { fadeSlideUp } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { formatWeekRange, getWeekMonday } from '@/lib/utils/date-format';
import { type HeatmapCompletion, type Routine } from './types';

interface OverCompletionLogProps {
  routines: Routine[];
  completions: HeatmapCompletion[];
}

export function OverCompletionLog({
  routines,
  completions,
}: OverCompletionLogProps) {
  const weeklyData = new Map<string, Map<string, number>>();

  for (const completion of completions) {
    const weekKey = getWeekMonday(completion.date);
    if (!weeklyData.has(completion.routineId)) {
      weeklyData.set(completion.routineId, new Map());
    }

    const routineWeeks = weeklyData.get(completion.routineId);
    routineWeeks?.set(weekKey, (routineWeeks.get(weekKey) || 0) + 1);
  }

  const entries: { routine: Routine; weekMonday: string; count: number; target: number }[] = [];

  for (const routine of routines.filter((item) => !item.isArchived)) {
    const routineWeeks = weeklyData.get(routine.id);
    if (!routineWeeks) continue;

    let target = 7;
    if (routine.cadenceType === 'x_per_week') target = routine.cadenceConfig.target || 3;
    else if (routine.cadenceType === 'specific_days') target = routine.cadenceConfig.days?.length || 7;
    else if (routine.cadenceType === 'weekly') target = 1;
    else if (routine.cadenceType === 'monthly' || routine.cadenceType === 'quarterly') continue;

    for (const [weekKey, count] of routineWeeks) {
      if (count > target) {
        entries.push({ routine, weekMonday: weekKey, count, target });
      }
    }
  }

  const recentEntries = entries
    .sort((left, right) => right.weekMonday.localeCompare(left.weekMonday))
    .slice(0, 10);

  if (recentEntries.length === 0) {
    return null;
  }

  return (
    <motion.div variants={fadeSlideUp} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-5">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Over-completion Log</h3>
      <div className="mt-4 space-y-2">
        {recentEntries.map((entry, index) => (
          <div
            key={`${entry.routine.id}-${entry.weekMonday}-${index}`}
            className={cn(
              'rounded-[var(--radius-md)] bg-[var(--surface-0)] px-4 py-3 text-sm text-[var(--text-secondary)]',
            )}
          >
            {entry.routine.icon && <span className="mr-1.5">{entry.routine.icon}</span>}
            {entry.routine.name}:{' '}
            <span className="font-medium text-[var(--text-primary)]">
              {entry.count}x this week (target: {entry.target})
            </span>
            {' — '}
            {formatWeekRange(entry.weekMonday).split(',')[0]} week
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-[var(--text-muted)]">
        Over-completions inform cadence suggestions. You&apos;re naturally doing more — let the system match your pace.
      </p>
    </motion.div>
  );
}
