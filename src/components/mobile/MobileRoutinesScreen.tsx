'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowLeft,
  CalendarDays,
  Check,
  Flame,
  Loader2,
  Moon,
  Plus,
  Repeat,
  Sun,
} from 'lucide-react';
import { PullToRefreshIndicator } from '@/components/ui/PullToRefreshIndicator';
import { usePullToRefresh } from '@/lib/hooks/usePullToRefresh';
import { cn } from '@/lib/utils';
import { getLocalToday } from '@/lib/utils/client-date';
import { getWeekDates, getWeekMonday } from '@/lib/utils/date-format';
import { toast } from 'sonner';

type ViewMode = 'daily' | 'weekly';
type CadenceType =
  | 'daily'
  | 'specific_days'
  | 'x_per_week'
  | 'every_n_days'
  | 'weekly'
  | 'monthly'
  | 'quarterly';

interface CadenceConfig {
  days?: number[];
  target?: number;
  minDays?: number;
  maxDays?: number;
  preferredDay?: number | string;
}

interface WeekCompletion {
  date: string;
  id: string;
}

interface IntervalStatus {
  status: 'on_track' | 'due_soon' | 'overdue_soft';
  daysSinceLast: number;
  progressPercent: number;
}

interface WeeklyProgress {
  done: number;
  target: number;
  isOver: boolean;
  bonus: number;
}

interface RoutineSnapshot {
  id: string;
  name: string;
  icon: string | null;
  cadenceType: CadenceType;
  cadenceConfig: CadenceConfig;
  streak: number;
  weekCompletions: WeekCompletion[];
  intervalStatus: IntervalStatus | null;
  weeklyProgress: WeeklyProgress | null;
}

interface RoutinesResponse {
  routines?: RoutineSnapshot[];
}

export interface MobileRoutinesScreenProps {
  onBack: () => void;
}

const GLASS = 'border border-[rgba(148,163,184,0.14)] bg-[rgba(15,23,42,0.68)] shadow-[0_18px_40px_rgba(2,6,23,0.30)] backdrop-blur-[18px]';
const GLASS_CARD = `${GLASS} rounded-[22px]`;
const GLASS_BUTTON = `${GLASS} relative mt-1 flex h-10 w-10 items-center justify-center rounded-full text-slate-200 transition-colors active:scale-[0.98]`;
const TOUCH_TARGET = 'flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function parseLocalDate(date: string) {
  return new Date(`${date}T12:00:00`);
}

function getCadenceLabel(routine: RoutineSnapshot) {
  switch (routine.cadenceType) {
    case 'daily':
      return 'Daily';
    case 'specific_days':
      return routine.cadenceConfig.days?.length
        ? routine.cadenceConfig.days.map((day) => DAY_NAMES[day] ?? '').filter(Boolean).join(' \u00B7 ')
        : 'Specific days';
    case 'x_per_week':
      return `${routine.cadenceConfig.target ?? 3} times this week`;
    case 'every_n_days':
      if (routine.cadenceConfig.minDays && routine.cadenceConfig.maxDays) {
        return `Every ${routine.cadenceConfig.minDays}-${routine.cadenceConfig.maxDays} days`;
      }
      return 'Every few days';
    case 'weekly':
      return 'Weekly';
    case 'monthly':
      return 'Monthly';
    case 'quarterly':
      return 'Quarterly';
    default:
      return 'Routine';
  }
}

function getScheduleState(routine: RoutineSnapshot, date: string): boolean | null {
  const dayOfWeek = parseLocalDate(date).getDay();

  switch (routine.cadenceType) {
    case 'daily':
    case 'x_per_week':
    case 'every_n_days':
      return true;
    case 'specific_days':
      return routine.cadenceConfig.days?.includes(dayOfWeek) ?? false;
    case 'weekly': {
      const preferredDay = typeof routine.cadenceConfig.preferredDay === 'number'
        ? routine.cadenceConfig.preferredDay
        : null;
      return preferredDay === null ? true : preferredDay === dayOfWeek;
    }
    case 'monthly':
    case 'quarterly':
      return null;
    default:
      return true;
  }
}

function isRoutineRelevantToday(routine: RoutineSnapshot, today: string) {
  if (getScheduleState(routine, today)) return true;
  if (routine.weekCompletions.some((completion) => completion.date === today)) return true;
  if (routine.weeklyProgress && routine.weeklyProgress.done < routine.weeklyProgress.target) return true;
  if (routine.intervalStatus && routine.intervalStatus.status !== 'on_track') return true;
  return false;
}

function applyCompletionState(routines: RoutineSnapshot[], routineId: string, date: string, completed: boolean) {
  return routines.map((routine) => {
    if (routine.id !== routineId) return routine;

    const hasCompletion = routine.weekCompletions.some((entry) => entry.date === date);
    const delta = completed && !hasCompletion ? 1 : !completed && hasCompletion ? -1 : 0;

    return {
      ...routine,
      weekCompletions: completed
        ? hasCompletion
          ? routine.weekCompletions
          : [...routine.weekCompletions, { date, id: `optimistic-${routineId}-${date}` }]
        : routine.weekCompletions.filter((entry) => entry.date !== date),
      weeklyProgress: routine.weeklyProgress
        ? {
            ...routine.weeklyProgress,
            done: Math.max(0, routine.weeklyProgress.done + delta),
            bonus: Math.max(0, Math.max(0, routine.weeklyProgress.done + delta) - routine.weeklyProgress.target),
            isOver: Math.max(0, routine.weeklyProgress.done + delta) > routine.weeklyProgress.target,
          }
        : null,
    };
  });
}

function getRoutineIcon(routine: RoutineSnapshot) {
  const keyword = `${routine.icon ?? ''} ${routine.name}`.toLowerCase();

  if (/sun|morning|wake|rise|startup|start/.test(keyword)) {
    return { Icon: Sun, className: 'text-amber-400' };
  }

  if (/moon|evening|night|sleep|shutdown|wind down/.test(keyword)) {
    return { Icon: Moon, className: 'text-violet-400' };
  }

  if (/calendar|schedule|plan/.test(keyword)) {
    return { Icon: CalendarDays, className: 'text-sky-400' };
  }

  return { Icon: Repeat, className: 'text-sky-400' };
}

function getHeaderProgress(routine: RoutineSnapshot, completedToday: boolean) {
  if (routine.weeklyProgress) {
    return routine.weeklyProgress.done > 0
      ? `${routine.weeklyProgress.done} of ${routine.weeklyProgress.target} done`
      : 'Not started';
  }

  return completedToday ? '1 of 1 done' : 'Not started';
}

function getHeaderProgressTone(progress: string) {
  return progress === 'Not started' ? 'text-[var(--text-muted)]' : 'text-emerald-400';
}

function DailyRoutineCard({
  routine,
  today,
  pending,
  index,
  onToggle,
  prefersReducedMotion,
}: {
  routine: RoutineSnapshot;
  today: string;
  pending: boolean;
  index: number;
  onToggle: (routineId: string) => void;
  prefersReducedMotion: boolean;
}) {
  const completedToday = routine.weekCompletions.some((completion) => completion.date === today);
  const progress = getHeaderProgress(routine, completedToday);
  const { Icon, className } = getRoutineIcon(routine);

  return (
    <motion.section
      initial={prefersReducedMotion ? undefined : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={prefersReducedMotion ? { duration: 0 } : { delay: Math.min(index * 0.03, 0.18) }}
      className={cn(GLASS_CARD, index === 0 ? 'mt-5' : 'mt-3', 'p-4')}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn('h-3 w-3 shrink-0', className)} />
          <span className="truncate text-sm font-semibold text-white">{routine.name}</span>
        </div>
        <span className={cn('shrink-0 text-xs', getHeaderProgressTone(progress))}>{progress}</span>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <motion.button
            type="button"
            whileTap={{ scale: 0.94 }}
            onClick={() => onToggle(routine.id)}
            disabled={pending}
            className={cn(TOUCH_TARGET, '-m-2 shrink-0 p-2 text-slate-200')}
            aria-label={`${completedToday ? 'Mark incomplete' : 'Mark complete'} ${routine.name}`}
          >
            <span
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full border',
                completedToday
                  ? 'border-emerald-500/10 bg-emerald-500/20 text-emerald-400'
                  : 'border-slate-600 bg-transparent text-transparent'
              )}
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" /> : completedToday ? <Check className="h-3.5 w-3.5" /> : null}
            </span>
          </motion.button>

          <div className="min-w-0 flex-1">
            <p className={cn('text-sm', completedToday ? 'text-slate-400 line-through' : 'text-slate-200')}>
              {routine.name}
            </p>
            <div className="mt-2 space-y-1">
              <p className="text-xs text-[var(--text-muted)]">{getCadenceLabel(routine)}</p>
              {routine.streak > 0 ? (
                <p className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]">
                  <Flame className="h-3 w-3 text-amber-400" />
                  {routine.streak} day streak
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </motion.section>
  );
}

function WeeklyRoutineCard({
  routine,
  today,
  weekDates,
  index,
  prefersReducedMotion,
}: {
  routine: RoutineSnapshot;
  today: string;
  weekDates: string[];
  index: number;
  prefersReducedMotion: boolean;
}) {
  const completedToday = routine.weekCompletions.some((completion) => completion.date === today);
  const progress = getHeaderProgress(routine, completedToday);
  const { Icon, className } = getRoutineIcon(routine);

  return (
    <motion.section
      initial={prefersReducedMotion ? undefined : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={prefersReducedMotion ? { duration: 0 } : { delay: Math.min(index * 0.03, 0.18) }}
      className={cn(GLASS_CARD, index === 0 ? 'mt-5' : 'mt-3', 'p-4')}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn('h-3 w-3 shrink-0', className)} />
          <span className="truncate text-sm font-semibold text-white">{routine.name}</span>
        </div>
        <span className={cn('shrink-0 text-xs', getHeaderProgressTone(progress))}>{progress}</span>
      </div>

      <div className="grid grid-cols-7 gap-2">
        {weekDates.map((date, dayIndex) => {
          const completed = routine.weekCompletions.some((completion) => completion.date === date);
          const scheduled = getScheduleState(routine, date);
          const isToday = date === today;

          return (
            <div key={date} className="flex flex-col items-center gap-2">
              <div
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-full border text-slate-400',
                  scheduled === false || scheduled === null
                    ? 'border-slate-800 bg-[rgba(2,6,23,0.24)] text-slate-700'
                    : 'border-slate-700 bg-[rgba(15,23,42,0.82)]',
                  completed && 'border-emerald-500/10 bg-emerald-500/20 text-emerald-400',
                  !completed && isToday && scheduled && 'border-sky-400/30 bg-[rgba(10,132,255,0.18)] text-sky-300',
                  isToday && 'ring-1 ring-inset ring-sky-400/30'
                )}
              >
                {completed ? (
                  <Check className="h-3.5 w-3.5" />
                ) : scheduled ? (
                  <span className={cn('h-2 w-2 rounded-full', isToday ? 'bg-sky-300' : 'bg-slate-500')} />
                ) : null}
              </div>
              <span className={cn('text-xs', isToday ? 'text-slate-200' : 'text-[var(--text-muted)]')}>
                {WEEKDAY_LETTERS[dayIndex]}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3 space-y-1">
        <p className="text-xs text-[var(--text-muted)]">{getCadenceLabel(routine)}</p>
        {routine.streak > 0 ? (
          <p className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <Flame className="h-3 w-3 text-amber-400" />
            {routine.streak} day streak
          </p>
        ) : null}
      </div>
    </motion.section>
  );
}

export function MobileRoutinesScreen({ onBack }: MobileRoutinesScreenProps) {
  const today = useMemo(() => getLocalToday(), []);
  const weekMonday = useMemo(() => getWeekMonday(today), [today]);
  const weekDates = useMemo(() => getWeekDates(weekMonday), [weekMonday]);
  const [viewMode, setViewMode] = useState<ViewMode>('daily');
  const [routines, setRoutines] = useState<RoutineSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const prefersReducedMotion = useReducedMotion() ?? false;

  const loadData = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/routines?date=${today}`, { signal });
    if (!response.ok) {
      throw new Error('Unable to load routines');
    }

    const data: RoutinesResponse = await response.json();
    setRoutines(data.routines ?? []);
  }, [today]);

  useEffect(() => {
    const controller = new AbortController();

    async function hydrate() {
      setIsLoading(true);
      setError(null);

      try {
        await loadData(controller.signal);
      } catch (loadError) {
        if ((loadError as Error).name !== 'AbortError') {
          setError('Could not load routines.');
        }
      } finally {
        setIsLoading(false);
      }
    }

    void hydrate();
    return () => controller.abort();
  }, [loadData]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      await loadData();
    } catch {
      setError('Could not refresh routines.');
    }
  }, [loadData]);

  const { containerRef, pullDistance, isRefreshing, containerProps, contentStyle } = usePullToRefresh({
    onRefresh: refresh,
    enabled: !isLoading,
  });

  const visibleRoutines = useMemo(
    () => (viewMode === 'daily' ? routines.filter((routine) => isRoutineRelevantToday(routine, today)) : routines),
    [routines, today, viewMode]
  );

  const weeklyLabel = useMemo(() => {
    const start = parseLocalDate(weekDates[0]);
    const end = parseLocalDate(weekDates[6]);
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }, [weekDates]);

  const handleToggleCompletion = useCallback(async (routineId: string) => {
    if (pendingIds.has(routineId)) return;

    setPendingIds((current) => {
      const next = new Set(current);
      next.add(routineId);
      return next;
    });

    const routine = routines.find((item) => item.id === routineId);
    if (!routine) {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(routineId);
        return next;
      });
      return;
    }

    const wasCompleted = routine.weekCompletions.some((completion) => completion.date === today);
    const previousRoutines = routines;

    setRoutines((current) => applyCompletionState(current, routineId, today, !wasCompleted));

    try {
      const response = wasCompleted
        ? await fetch(`/api/routines/completions?routineId=${routineId}&date=${today}`, { method: 'DELETE' })
        : await fetch('/api/routines/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ routineId, date: today }),
          });

      if (!response.ok && !(!wasCompleted && response.status === 409)) {
        throw new Error('Unable to update routine');
      }

      await loadData();
    } catch {
      setRoutines(previousRoutines);
      toast.error('Could not update routine. Please try again.');
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(routineId);
        return next;
      });
    }
  }, [loadData, pendingIds, routines, today]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#020617] text-slate-200">
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center px-5">
          <div className={cn(GLASS_CARD, 'flex items-center gap-3 px-4 py-3 text-sm text-slate-200')}>
            <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
            Loading routines...
          </div>
        </div>
      ) : (
        <div
          ref={containerRef}
          className="relative flex-1 overflow-y-auto overscroll-y-contain"
          {...containerProps}
        >
          <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing} />

          <div style={contentStyle} className="px-5 pb-28 pt-4">
            <div className="flex items-start justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <button type="button" onClick={onBack} className={`${GLASS_BUTTON} h-11 w-11 min-h-[44px] min-w-[44px]`} aria-label="Go back">
                  <ArrowLeft className="h-[14px] w-[14px]" />
                </button>
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-[0.24em] text-sky-400/90">Daily Habits</p>
                  <h1 className="mt-1 text-[1.75rem] font-semibold text-white">Routines</h1>
                </div>
              </div>
              <button
                type="button"
                className={GLASS_BUTTON}
                aria-label="Add routine"
                onClick={() => toast.info('Create routines from the desktop view for now.')}
              >
                <Plus className="h-[13px] w-[13px]" />
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2">
              {([
                { key: 'daily', label: 'Daily' },
                { key: 'weekly', label: 'Weekly' },
              ] as const).map((option) => {
                const active = viewMode === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setViewMode(option.key)}
                    className={cn(
                      'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                      active
                        ? 'bg-[rgba(10,132,255,0.20)] text-white ring-1 ring-inset ring-sky-400/30'
                        : `${GLASS} text-slate-400`
                    )}
                    aria-pressed={active}
                  >
                    {option.label}
                  </button>
                );
              })}
              {viewMode === 'weekly' ? (
                <span className="ml-auto text-xs text-[var(--text-muted)]">{weeklyLabel}</span>
              ) : null}
            </div>

            {error ? (
              <div className={cn(GLASS_CARD, 'mt-5 p-4')}>
                <p className="text-sm text-slate-200">{error}</p>
                <button
                  type="button"
                  onClick={() => {
                    void refresh();
                  }}
                  className="mt-3 rounded-full border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200"
                >
                  Try again
                </button>
              </div>
            ) : null}

            {visibleRoutines.length === 0 ? (
              <div className={cn(GLASS_CARD, 'mt-5 p-4')}>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Repeat className="h-3 w-3 text-sky-400" />
                    <span className="text-sm font-semibold text-white">Routines</span>
                  </div>
                  <span className="text-xs text-[var(--text-muted)]">Not started</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full border border-slate-600" />
                  <span className="text-sm text-slate-400">
                    {viewMode === 'daily' ? 'Nothing scheduled for today.' : 'No routines available this week.'}
                  </span>
                </div>
              </div>
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                {viewMode === 'daily' ? (
                  <motion.div
                    key="daily"
                    initial={prefersReducedMotion ? undefined : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={prefersReducedMotion ? undefined : { opacity: 0 }}
                    transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2 }}
                  >
                    {visibleRoutines.map((routine, index) => (
                      <DailyRoutineCard
                        key={routine.id}
                        routine={routine}
                        today={today}
                        pending={pendingIds.has(routine.id)}
                        index={index}
                        prefersReducedMotion={prefersReducedMotion}
                        onToggle={(routineId) => {
                          void handleToggleCompletion(routineId);
                        }}
                      />
                    ))}
                  </motion.div>
                ) : (
                  <motion.div
                    key="weekly"
                    initial={prefersReducedMotion ? undefined : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={prefersReducedMotion ? undefined : { opacity: 0 }}
                    transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2 }}
                  >
                    {visibleRoutines.map((routine, index) => (
                      <WeeklyRoutineCard
                        key={routine.id}
                        routine={routine}
                        today={today}
                        weekDates={weekDates}
                        index={index}
                        prefersReducedMotion={prefersReducedMotion}
                      />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default MobileRoutinesScreen;
