'use client';

import { Check, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DAY_LABELS, DAY_NUMBERS, type CadenceConfig, type Routine } from './types';

interface WeeklyGridProps {
  title: string;
  routines: Routine[];
  weekDates: string[];
  today: string;
  onToggle: (routineId: string, date: string, isCompleted: boolean) => void;
  onDelete: (id: string) => void;
}

function getDayLabel(cadenceConfig: CadenceConfig): string {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return cadenceConfig.days?.map((day) => dayNames[day]).join('/') ?? '';
}

export function WeeklyGrid({
  title,
  routines,
  weekDates,
  today,
  onToggle,
  onDelete,
}: WeeklyGridProps) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="border-b border-[var(--border)] px-5 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
          {title}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full" aria-label={title}>
          <thead>
            <tr className="border-b border-[var(--border)] text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              <th className="px-3 py-3 text-left sm:px-5">Routine</th>
              {DAY_LABELS.map((label, index) => (
                <th key={index} className="w-8 px-1 py-3 text-center sm:w-10 sm:px-2">
                  {label}
                </th>
              ))}
              <th className="hidden px-5 py-3 text-right sm:table-cell">Streak</th>
              <th className="hidden w-8 px-3 py-3 sm:table-cell" />
            </tr>
          </thead>
          <tbody className="text-sm">
            {routines.map((routine, index) => {
              const completedDates = new Set(routine.weekCompletions.map((completion) => completion.date));
              const scheduledDays =
                routine.cadenceType === 'specific_days'
                  ? new Set(routine.cadenceConfig.days ?? [])
                  : null;

              return (
                <tr
                  key={routine.id}
                  data-routine-id={routine.id}
                  className={cn(index < routines.length - 1 && 'border-b border-[var(--border-subtle)]')}
                >
                  <td className="max-w-[100px] truncate px-3 py-3 font-medium text-[var(--text-primary)] sm:max-w-none sm:truncate-none sm:px-5">
                    {routine.icon && <span className="mr-2">{routine.icon}</span>}
                    {routine.name}
                    {routine.cadenceType === 'specific_days' && (
                      <span className="ml-2 hidden text-xs text-[var(--text-muted)] sm:inline">
                        ({getDayLabel(routine.cadenceConfig)})
                      </span>
                    )}
                  </td>
                  {weekDates.map((date, dayIndex) => {
                    const dayOfWeek = DAY_NUMBERS[dayIndex];
                    const isCompleted = completedDates.has(date);
                    const isFuture = date > today;
                    const isScheduled = scheduledDays ? scheduledDays.has(dayOfWeek) : true;

                    if (!isScheduled) {
                      return (
                        <td key={date} className="px-1 py-3 text-center sm:px-2">
                          <span className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] text-xs text-[var(--text-muted)]">
                            —
                          </span>
                        </td>
                      );
                    }

                    if (isFuture) {
                      return (
                        <td key={date} className="px-1 py-3 text-center sm:px-2">
                          <span className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] border border-dashed border-[var(--border-strong)] text-xs text-[var(--text-muted)]">
                            ·
                          </span>
                        </td>
                      );
                    }

                    return (
                      <td key={date} className="px-1 py-3 text-center sm:px-2">
                        <button
                          onClick={() => onToggle(routine.id, date, isCompleted)}
                          aria-label={`${routine.name} ${date}: ${isCompleted ? 'completed, click to undo' : 'not completed, click to complete'}`}
                          className={cn(
                            'inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] border text-xs transition-colors duration-[var(--transition-fast)] active:scale-[0.96]',
                            isCompleted
                              ? 'border-emerald-700/50 bg-emerald-900/40 text-emerald-400'
                              : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-muted)] hover:border-[var(--accent-500)] hover:text-[var(--accent-400)]',
                          )}
                        >
                          {isCompleted ? <Check size={12} /> : '·'}
                        </button>
                      </td>
                    );
                  })}
                  <td className="hidden px-5 py-3 text-right font-medium tabular-nums text-[var(--text-primary)] sm:table-cell">
                    {routine.streak}
                    {routine.streak >= 7 && <span className="ml-1 text-orange-400">🔥</span>}
                  </td>
                  <td className="hidden px-3 py-3 sm:table-cell">
                    <button
                      onClick={() => onDelete(routine.id)}
                      className="rounded-[var(--radius-sm)] p-1 text-[var(--text-muted)] transition-colors duration-[var(--transition-fast)] hover:bg-[var(--surface-2)] hover:text-[var(--danger)]"
                      title="Archive routine"
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
