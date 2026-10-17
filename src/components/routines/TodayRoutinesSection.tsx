'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Check, ChevronDown, ChevronUp, Flame, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { toast } from '@/lib/toast';
import { fadeSlideUp, staggerContainer } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { getLocalToday as getClientToday } from '@/lib/utils/client-date';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  getQuickActionLimit,
  getRoutineDetail,
  groupTodayRoutines,
  isRoutineComplete,
  type TodayRoutine,
} from './today-routines';
import { RoutineIcon as RenderedRoutineIcon } from './RoutineIcon';

const INITIAL_VISIBLE_ROUTINES = 6;

function getRoutineGridColumns(itemCount: number) {
  if (itemCount === 1) return 'grid-cols-1';
  if (itemCount === 2 || itemCount === 4) return 'grid-cols-1 sm:grid-cols-2';
  return 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3';
}

/**
 * "Today's Routines" section for the My Day view with inline check-off.
 */
export function TodayRoutinesSection() {
  const [routines, setRoutines] = useState<TodayRoutine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [quickActionLimit, setQuickActionLimit] = useState(4);
  const sectionRef = useRef<HTMLElement>(null);
  const today = getClientToday();

  const fetchRoutines = useCallback(async () => {
    try {
      const res = await fetch(`/api/routines?date=${today}`);
      if (!res.ok) throw new Error('Failed to load routines');
      const data = await res.json() as { routines?: TodayRoutine[] };
      setRoutines(data.routines || []);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load routines');
    } finally {
      setLoading(false);
    }
  }, [today]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void fetchRoutines(), 0);
    return () => window.clearTimeout(timeout);
  }, [fetchRoutines]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(([entry]) => {
      setQuickActionLimit(getQuickActionLimit(entry.contentRect.width));
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, [loading]);

  const { promoted, other } = useMemo(
    () => groupTodayRoutines(routines, today),
    [routines, today],
  );
  const doneCount = promoted.filter((routine) => isRoutineComplete(routine, today)).length;
  const remainingCount = promoted.length - doneCount;
  const allComplete = promoted.length > 0 && remainingCount === 0;

  useEffect(() => {
    if (!allComplete) return;
    const timeout = window.setTimeout(() => setExpanded(false), 0);
    return () => window.clearTimeout(timeout);
  }, [allComplete]);

  const setSectionExpanded = (nextExpanded: boolean) => {
    setExpanded(nextExpanded);
    if (!nextExpanded) {
      setShowAll(false);
      setShowOther(false);
    }
  };

  const toggleCompletion = async (routineId: string) => {
    const routine = routines.find(r => r.id === routineId);
    if (!routine || pendingIds.has(routineId)) return;
    const isCompleted = isRoutineComplete(routine, today);
    setPendingIds((current) => new Set(current).add(routineId));

    try {
      const response = isCompleted
        ? await fetch(`/api/routines/completions?routineId=${routineId}&date=${today}`, { method: 'DELETE' })
        : await fetch('/api/routines/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ routineId, date: today }),
        });

      if (!response.ok) throw new Error('Failed to update routine');

      setRoutines((current) => current.map((item) => {
        if (item.id !== routineId) return item;
        const weekCompletions = isCompleted
          ? item.weekCompletions.filter((completion) => completion.date !== today)
          : [...item.weekCompletions, { date: today, id: `pending-${routineId}-${today}` }];
        return { ...item, weekCompletions };
      }));
    } catch (completionError) {
      toast.error(completionError instanceof Error ? completionError.message : 'Failed to update routine');
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(routineId);
        return next;
      });
    }
  };

  if (loading) return null;
  if (!error && routines.length === 0) return null;

  const progress = promoted.length === 0 ? 0 : Math.round((doneCount / promoted.length) * 100);
  const greenWeight = Math.max(0, Math.min(100, Math.round(((progress - 35) / 65) * 100)));
  const progressColor = `color-mix(in srgb, var(--accent-400) ${100 - greenWeight}%, var(--success) ${greenWeight}%)`;
  const visiblePromoted = showAll ? promoted : promoted.slice(0, INITIAL_VISIBLE_ROUTINES);
  const hiddenCount = Math.max(0, promoted.length - INITIAL_VISIBLE_ROUTINES);
  const hiddenCompletedCount = promoted
    .slice(INITIAL_VISIBLE_ROUTINES)
    .filter((routine) => isRoutineComplete(routine, today)).length;
  const quickRoutines = promoted.slice(0, quickActionLimit);
  const quickHiddenCount = Math.max(0, promoted.length - quickRoutines.length);

  return (
    <section ref={sectionRef} className="mb-5" aria-label="Routines">
      <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
        <div className="flex min-h-[58px] items-center gap-2.5 px-3 py-2">
          <button
            type="button"
            onClick={() => setSectionExpanded(!expanded)}
            aria-expanded={expanded}
            className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-md)] text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)]"
          >
            <span
              className="relative grid size-8 shrink-0 place-items-center rounded-full"
              style={{ background: `conic-gradient(${progressColor} 0 ${progress}%, var(--surface-3) ${progress}% 100%)` }}
              aria-hidden="true"
            >
              <span className="grid size-6 place-items-center rounded-full bg-[var(--surface-1)] text-[9px] font-semibold tabular-nums text-[var(--text-primary)]">
                {doneCount}/{promoted.length}
              </span>
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold text-[var(--text-primary)]">
                {error
                  ? 'Routines unavailable'
                  : allComplete
                  ? 'All routines complete'
                  : promoted.length === 0
                    ? 'No routines due today'
                    : `${remainingCount} routine${remainingCount === 1 ? '' : 's'} left today`}
              </span>
              <span className="mt-0.5 block truncate text-[10px] text-[var(--text-muted)]">
                {error
                  ? "Retry to restore today's routine list"
                  : allComplete
                  ? 'Nice work · details collapsed automatically'
                  : other.length > 0
                    ? `${promoted.length} planned · ${other.length} other available`
                    : `${promoted.length} planned for today`}
              </span>
            </span>
          </button>

          {!expanded && promoted.length > 0 && (
            <div className="flex min-w-0 items-center gap-1" aria-label="Quick routine actions">
              {quickRoutines.map((routine) => (
                <RoutineIconButton
                  key={routine.id}
                  routine={routine}
                  completed={isRoutineComplete(routine, today)}
                  pending={pendingIds.has(routine.id)}
                  onToggle={toggleCompletion}
                  compact
                />
              ))}
              {quickHiddenCount > 0 && (
                <Tooltip content={`Show all ${promoted.length} routines`} delay={80}>
                  <button
                    type="button"
                    onClick={() => {
                      setExpanded(true);
                      setShowAll(true);
                    }}
                    className="grid size-8 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] text-xs font-semibold tabular-nums text-[var(--text-secondary)] transition-colors hover:border-[var(--accent-500)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)]"
                    aria-label={`Show ${quickHiddenCount} more routines`}
                  >
                    +{quickHiddenCount}
                  </button>
                </Tooltip>
              )}
            </div>
          )}

          <Link
            href="/routines"
            className="hidden rounded-[var(--radius-sm)] px-2 py-1.5 text-[10px] font-medium text-[var(--accent-400)] transition-colors hover:bg-[var(--accent-500)]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)] sm:block"
          >
            Manage
          </Link>
          <Tooltip content={expanded ? 'Collapse routines' : 'Expand routines'} delay={80}>
            <button
              type="button"
              onClick={() => setSectionExpanded(!expanded)}
              className="grid size-7 shrink-0 place-items-center rounded-[var(--radius-sm)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)]"
              aria-label={expanded ? 'Collapse routines' : 'Expand routines'}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </Tooltip>
        </div>

        {expanded && (
          <div className="border-t border-[var(--border-subtle)]">
            {error ? (
              <div className="m-2.5 flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--surface-0)] px-3 py-2.5">
                <span className="text-sm text-[var(--text-secondary)]">Routines could not load.</span>
                <button
                  type="button"
                  aria-label="Retry loading routines"
                  onClick={() => {
                    setError(null);
                    setLoading(true);
                    void fetchRoutines();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1 text-xs font-medium text-[var(--accent-400)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)]"
                >
                  <RotateCcw size={12} />
                  Retry
                </button>
              </div>
            ) : (
              <>
                {visiblePromoted.length > 0 && (
                  <motion.div
                    className={cn(
                      'grid gap-px bg-[var(--border-subtle)]',
                      getRoutineGridColumns(visiblePromoted.length),
                    )}
                    variants={staggerContainer}
                    initial="hidden"
                    animate="show"
                  >
                    {visiblePromoted.map((routine) => (
                      <RoutineCard
                        key={routine.id}
                        routine={routine}
                        completed={isRoutineComplete(routine, today)}
                        pending={pendingIds.has(routine.id)}
                        onToggle={toggleCompletion}
                      />
                    ))}
                  </motion.div>
                )}

                {hiddenCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAll(!showAll)}
                    aria-expanded={showAll}
                    className="flex min-h-[35px] w-full items-center justify-between gap-3 border-t border-[var(--border-subtle)] bg-[var(--surface-0)] px-[11px] py-1.5 text-left text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-500)]"
                  >
                    <span>
                      <strong className="font-medium text-[var(--text-secondary)]">
                        {showAll ? `All ${promoted.length} routines shown` : `${hiddenCount} more routine${hiddenCount === 1 ? '' : 's'}`}
                      </strong>
                      {!showAll && hiddenCompletedCount > 0 && ` · includes ${hiddenCompletedCount} completed`}
                    </span>
                    <span className="font-medium text-[var(--accent-400)]">
                      {showAll ? 'Show fewer' : 'Show all'}
                    </span>
                  </button>
                )}

                {other.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowOther(!showOther)}
                      aria-expanded={showOther}
                      className="flex min-h-[35px] w-full items-center justify-between gap-3 border-t border-[var(--border-subtle)] bg-[var(--surface-0)] px-[11px] py-1.5 text-left text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-500)]"
                    >
                      <span>
                        <strong className="font-medium text-[var(--text-secondary)]">Other routines ({other.length})</strong>
                        {' · '}not due today, but available to log
                      </span>
                      <span className="font-medium text-[var(--accent-400)]">{showOther ? 'Hide' : 'Show'}</span>
                    </button>
                    {showOther && (
                      <motion.div
                        className={cn(
                          'grid gap-px border-t border-[var(--border-subtle)] bg-[var(--border-subtle)]',
                          getRoutineGridColumns(other.length),
                        )}
                        variants={staggerContainer}
                        initial="hidden"
                        animate="show"
                      >
                        {other.map((routine) => (
                          <RoutineCard
                            key={routine.id}
                            routine={routine}
                            completed={isRoutineComplete(routine, today)}
                            pending={pendingIds.has(routine.id)}
                            onToggle={toggleCompletion}
                          />
                        ))}
                      </motion.div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function RoutineIcon({
  routine,
  size = 'regular',
}: {
  routine: TodayRoutine;
  size?: 'compact' | 'regular';
}) {
  return <RenderedRoutineIcon routine={routine} size={size === 'compact' ? 13 : 15} />;
}

function RoutineIconButton({
  routine,
  completed,
  pending,
  onToggle,
  compact = false,
}: {
  routine: TodayRoutine;
  completed: boolean;
  pending: boolean;
  onToggle: (routineId: string) => void;
  compact?: boolean;
}) {
  const action = completed ? `Mark ${routine.name} incomplete` : `Mark ${routine.name} complete`;

  return (
    <Tooltip content={action} delay={80}>
      <button
        type="button"
        onClick={() => onToggle(routine.id)}
        disabled={pending}
        aria-label={action}
        className={cn(
          'relative grid shrink-0 place-items-center rounded-[var(--radius-md)] border bg-[var(--surface-2)] transition-[border-color,background-color,transform,opacity] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)] disabled:cursor-wait disabled:opacity-60',
          compact ? 'size-[29px]' : 'size-8',
          completed
            ? 'border-emerald-700/60 bg-emerald-950/35'
            : 'border-[var(--border)] hover:border-[var(--accent-500)] hover:bg-[var(--surface-3)]',
        )}
      >
        <RoutineIcon routine={routine} size={compact ? 'compact' : 'regular'} />
        <span
          className={cn(
            'absolute grid rounded-full border-2 border-[var(--surface-1)]',
            compact ? '-bottom-1 -right-1 size-4' : '-bottom-1.5 -right-1.5 size-[18px]',
            completed
              ? 'place-items-center bg-emerald-500 text-white'
              : 'bg-[var(--surface-1)] ring-1 ring-inset ring-[var(--border-strong)]',
          )}
          aria-hidden="true"
        >
          {completed && <Check size={10} strokeWidth={3} />}
        </span>
      </button>
    </Tooltip>
  );
}

function RoutineCard({
  routine,
  completed,
  pending,
  onToggle,
}: {
  routine: TodayRoutine;
  completed: boolean;
  pending: boolean;
  onToggle: (routineId: string) => void;
}) {
  return (
    <motion.div
      variants={fadeSlideUp}
      className={cn(
        'flex min-h-[43px] min-w-0 items-center gap-[9px] bg-[var(--surface-1)] px-[11px] py-2 transition-colors hover:bg-[var(--surface-0)]',
      )}
    >
      <RoutineIconButton
        routine={routine}
        completed={completed}
        pending={pending}
        onToggle={onToggle}
      />
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-xs font-medium leading-4',
            completed ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]',
          )}
        >
          {routine.name}
        </span>
        <span className="mt-px block truncate text-[9px] leading-3 text-[var(--text-muted)]">
          {getRoutineDetail(routine, completed)}
        </span>
      </div>
      {routine.streak > 0 && (
        <span
          className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-[var(--text-muted)]"
          aria-label={`${routine.streak} day streak`}
        >
          <Flame size={11} className={routine.streak >= 7 ? 'text-orange-400' : ''} />
          {routine.streak}
        </span>
      )}
    </motion.div>
  );
}
