'use client';

import { Check, Flame, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type Routine } from './types';

interface FlexibleRoutineCardProps {
  routine: Routine;
  today: string;
  weekDates: string[];
  onToggle: (routineId: string, date: string, isCompleted: boolean) => void;
  onDelete: (id: string) => void;
}

export function FlexibleRoutineCard({
  routine,
  today,
  weekDates,
  onToggle,
  onDelete,
}: FlexibleRoutineCardProps) {
  void weekDates;

  const completedDates = new Set(routine.weekCompletions.map((completion) => completion.date));
  const isCompletedToday = completedDates.has(today);

  const cadenceLabel = (() => {
    switch (routine.cadenceType) {
      case 'x_per_week':
        return `${routine.cadenceConfig.target || 3}x/week`;
      case 'every_n_days':
        return `every ${routine.cadenceConfig.minDays || 3}-${routine.cadenceConfig.maxDays || 4} days`;
      case 'weekly':
        return '~weekly';
      case 'monthly':
        return 'monthly';
      case 'quarterly':
        return 'quarterly';
      default:
        return routine.cadenceType;
    }
  })();

  const statusColor = routine.intervalStatus
    ? {
        on_track: 'text-emerald-400',
        due_soon: 'text-amber-400',
        overdue_soft: 'text-red-400',
      }[routine.intervalStatus.status]
    : '';

  const statusLabel = routine.intervalStatus
    ? {
        on_track: 'On track',
        due_soon: 'Due soon',
        overdue_soft: 'Consider doing',
      }[routine.intervalStatus.status]
    : '';

  const progressBarColor = routine.intervalStatus
    ? {
        on_track: 'bg-emerald-500',
        due_soon: 'bg-amber-500',
        overdue_soft: 'bg-red-500',
      }[routine.intervalStatus.status]
    : 'bg-emerald-500';

  return (
    <div data-routine-id={routine.id} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-[var(--text-primary)]">
              {routine.icon && <span className="mr-1.5">{routine.icon}</span>}
              {routine.name}
            </h3>
            <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
              {cadenceLabel}
            </span>
          </div>
          {routine.intervalStatus && (
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Last: {routine.intervalStatus.daysSinceLast} day
              {routine.intervalStatus.daysSinceLast !== 1 ? 's' : ''} ago
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          {routine.weeklyProgress && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-[var(--text-secondary)]">
                Done:{' '}
                <span className="tabular-nums font-medium text-[var(--text-primary)]">
                  {routine.weeklyProgress.done}/{routine.weeklyProgress.target}
                </span>
              </span>
              {routine.weeklyProgress.isOver && (
                <span className="rounded-full bg-emerald-900/30 px-2 py-0.5 text-xs font-medium text-emerald-400">
                  +{routine.weeklyProgress.bonus} bonus
                </span>
              )}
            </div>
          )}
          {routine.intervalStatus && (
            <span className={cn('text-sm font-medium', statusColor)}>{statusLabel}</span>
          )}
          <button
            onClick={() => onToggle(routine.id, today, isCompletedToday)}
            className={cn(
              'rounded-[var(--radius-md)] border px-2.5 py-1 text-xs font-medium transition-colors duration-[var(--transition-fast)] active:scale-[0.96]',
              isCompletedToday
                ? 'border-emerald-700/50 bg-emerald-900/30 text-emerald-400'
                : 'border-[var(--accent-600)] bg-[var(--accent-900)]/30 text-[var(--accent-400)] hover:bg-[var(--accent-900)]/50',
            )}
          >
            {isCompletedToday ? (
              <Check size={12} className="mr-1 inline" />
            ) : (
              <Plus size={12} className="mr-1 inline" />
            )}
            {isCompletedToday ? 'Done' : '+1'}
          </button>
          <button
            onClick={() => onDelete(routine.id)}
            className="rounded-[var(--radius-sm)] p-1 text-[var(--text-muted)] transition-colors duration-[var(--transition-fast)] hover:bg-[var(--surface-2)] hover:text-[var(--danger)]"
            title="Archive"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {routine.intervalStatus && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
            <div
              className={cn('h-full rounded-full transition-[width] duration-300', progressBarColor)}
              style={{ width: `${routine.intervalStatus.progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {routine.weeklyProgress && (() => {
        const wp = routine.weeklyProgress;
        return (
        <div className="mt-3 flex items-center gap-2">
          <div className="flex gap-1">
            {Array.from({ length: wp.target }).map((_, index) => (
              <span
                key={index}
                className={cn(
                  'h-2.5 w-2.5 rounded-full',
                  index < wp.done ? 'bg-emerald-500' : 'bg-[var(--surface-3)]',
                )}
              />
            ))}
            {wp.bonus > 0 &&
              Array.from({ length: wp.bonus }).map((_, index) => (
                <span
                  key={`bonus-${index}`}
                  className="h-2.5 w-2.5 rounded-full bg-emerald-400/50 ring-1 ring-emerald-500/30"
                />
              ))}
          </div>
          <span className="tabular-nums text-xs text-[var(--text-muted)]">
            {wp.done}/{wp.target}
          </span>
        </div>
        );
      })()}

      <div className="mt-2 flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <Flame size={12} className={routine.streak >= 3 ? 'text-orange-400' : ''} />
        <span className="tabular-nums">{routine.streak} streak</span>
      </div>
    </div>
  );
}
