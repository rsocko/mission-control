'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fadeSlideUp } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { formatDateLocal } from '@/lib/utils/date-format';
import { type HeatmapCompletion, type Routine } from './types';

interface BehaviorHeatmapProps {
  routines: Routine[];
  completions: HeatmapCompletion[];
  today: string;
}

export function BehaviorHeatmap({
  routines,
  completions,
  today,
}: BehaviorHeatmapProps) {
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);

  const todayDate = new Date(`${today}T12:00:00`);
  const endDate = new Date(todayDate);
  const startDate = new Date(todayDate);
  startDate.setDate(startDate.getDate() - 27 * 7);

  const startDayOfWeek = startDate.getDay();
  if (startDayOfWeek !== 0) {
    startDate.setDate(startDate.getDate() - startDayOfWeek);
  }

  const weeks: string[][] = [];
  const cursor = new Date(startDate);
  let currentWeek: string[] = [];

  while (cursor <= endDate) {
    if (cursor.getDay() === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }

    currentWeek.push(formatDateLocal(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  if (currentWeek.length > 0) {
    weeks.push(currentWeek);
  }

  const completionsByDate = new Map<string, Set<string>>();
  for (const completion of completions) {
    if (selectedRoutineId && completion.routineId !== selectedRoutineId) continue;
    if (!completionsByDate.has(completion.date)) {
      completionsByDate.set(completion.date, new Set());
    }
    completionsByDate.get(completion.date)?.add(completion.routineId);
  }

  const activeRoutines = routines.filter((routine) => !routine.isArchived);
  const maxCount = selectedRoutineId ? 1 : Math.max(1, activeRoutines.length);

  const getIntensity = (date: string) => {
    const dateCompletions = completionsByDate.get(date);
    if (!dateCompletions) return 0;
    if (selectedRoutineId) return dateCompletions.size > 0 ? 4 : 0;

    const fraction = dateCompletions.size / maxCount;
    if (fraction <= 0.25) return 1;
    if (fraction <= 0.5) return 2;
    if (fraction <= 0.75) return 3;
    return 4;
  };

  const intensityColors = [
    'bg-[var(--surface-2)]',
    'bg-emerald-900/60',
    'bg-emerald-700/70',
    'bg-emerald-500',
    'bg-emerald-400',
  ];

  const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  const monthLabels: { label: string; col: number }[] = [];
  let lastMonth = -1;

  weeks.forEach((week, index) => {
    const firstDate = week[0];
    const month = new Date(`${firstDate}T12:00:00`).getMonth();
    if (month !== lastMonth) {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      monthLabels.push({ label: monthNames[month], col: index });
      lastMonth = month;
    }
  });

  return (
    <motion.div variants={fadeSlideUp} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Behavior Heatmap</h3>
        <Select
          value={selectedRoutineId || '_all'}
          onValueChange={(value) => setSelectedRoutineId(value === '_all' ? null : value)}
        >
          <SelectTrigger className="h-8 w-[180px] border-[var(--border-strong)] bg-[var(--surface-0)] text-xs">
            <SelectValue placeholder="All routines" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All routines</SelectItem>
            {activeRoutines.map((routine) => (
              <SelectItem key={routine.id} value={routine.id}>
                {routine.icon ? `${routine.icon} ` : ''}
                {routine.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-x-auto" role="img" aria-label="Behavior heatmap showing routine completion intensity over time. Darker cells indicate more completions.">
        <div className="inline-flex min-w-max flex-col gap-[2px]">
          <div className="mb-1 ml-[30px] flex gap-[2px]">
            {weeks.map((_, index) => {
              const monthLabel = monthLabels.find((month) => month.col === index);
              return (
                <div key={index} className="w-[11px]">
                  {monthLabel && (
                    <span className="whitespace-nowrap text-xs text-[var(--text-muted)]">
                      {monthLabel.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {Array.from({ length: 7 }).map((_, dayIndex) => (
            <div key={dayIndex} className="flex items-center gap-[2px]">
              <span className="w-[26px] flex-shrink-0 pr-1 text-right text-xs text-[var(--text-muted)]">
                {dayLabels[dayIndex]}
              </span>
              {weeks.map((week, weekIndex) => {
                const date = week[dayIndex];
                if (!date || date > today) {
                  return <span key={weekIndex} className="h-[11px] w-[11px] rounded-[2px]" />;
                }

                const intensity = getIntensity(date);
                const count = completionsByDate.get(date)?.size || 0;

                return (
                  <span
                    key={weekIndex}
                    className={cn(
                      'h-[11px] w-[11px] rounded-[2px] transition-colors duration-100',
                      intensityColors[intensity],
                    )}
                    title={`${date}: ${count} completion${count !== 1 ? 's' : ''}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-1.5 text-xs text-[var(--text-muted)]">
        <span>Less</span>
        {intensityColors.map((color, index) => (
          <span key={index} className={cn('h-[11px] w-[11px] rounded-[2px]', color)} />
        ))}
        <span>More</span>
      </div>
    </motion.div>
  );
}
