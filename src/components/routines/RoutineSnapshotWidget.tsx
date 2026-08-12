'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Repeat, Check, Flame, Loader2, Plus, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { fadeSlideUp } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { getLocalToday as getClientToday } from '@/lib/utils/client-date';
import Link from 'next/link';

interface RoutineSnapshot {
  id: string;
  name: string;
  icon: string | null;
  cadenceType: string;
  cadenceConfig: { days?: number[]; target?: number; minDays?: number; maxDays?: number };
  streak: number;
  weekCompletions: Array<{ date: string; id: string }>;
  intervalStatus: { status: string; daysSinceLast: number } | null;
  weeklyProgress: { done: number; target: number; bonus: number } | null;
}

/**
 * Dashboard "Routine Snapshot" widget — shows today's routines with quick check-off + streaks.
 */
export function RoutineSnapshotWidget({ embedded, collapsed, onToggleCollapse }: { embedded?: boolean; collapsed?: boolean; onToggleCollapse?: () => void } = {}) {
  const [routines, setRoutines] = useState<RoutineSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const today = getClientToday();

  const fetchRoutines = useCallback(async () => {
    try {
      const res = await fetch(`/api/routines?date=${today}`);
      if (!res.ok) return;
      const data = await res.json();
      setRoutines(data.routines || []);
    } catch {
      // silent on dashboard
    } finally {
      setLoading(false);
    }
  }, [today]);

  useEffect(() => { fetchRoutines(); }, [fetchRoutines]);

  const toggleCompletion = async (routineId: string) => {
    const routine = routines.find(r => r.id === routineId);
    if (!routine) return;
    const isCompleted = routine.weekCompletions.some(c => c.date === today);

    try {
      if (isCompleted) {
        await fetch(`/api/routines/completions?routineId=${routineId}&date=${today}`, { method: 'DELETE' });
      } else {
        const res = await fetch('/api/routines/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ routineId, date: today }),
        });
        if (res.status === 409) return;
      }
      fetchRoutines();
    } catch {
      toast.error('Failed to toggle routine');
    }
  };

  if (loading) {
    if (embedded) {
      return (
        <div className="p-4 flex items-center gap-2 text-[var(--text-muted)] text-sm">
          <Loader2 size={14} className="animate-spin" /> Loading routines…
        </div>
      );
    }
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-4 flex items-center gap-2 text-[var(--text-muted)] text-sm">
        <Loader2 size={14} className="animate-spin" /> Loading routines…
      </div>
    );
  }

  if (routines.length === 0) return null;

  // Filter to routines that are relevant today
  const todayDow = new Date(today + 'T12:00:00').getDay();
  const todayRoutines = routines.filter(r => {
    if (r.cadenceType === 'daily') return true;
    if (r.cadenceType === 'specific_days') {
      return r.cadenceConfig?.days?.includes(todayDow);
    }
    // Show flexible routines that are due_soon or not yet done this week
    if (r.intervalStatus && r.intervalStatus.status !== 'on_track') return true;
    if (r.weeklyProgress && r.weeklyProgress.done < r.weeklyProgress.target) return true;
    return false;
  });

  if (todayRoutines.length === 0) return null;

  const routineContent = (
    <div className="divide-y divide-[var(--border-subtle)]">
      {todayRoutines.map(routine => {
          const isCompleted = routine.weekCompletions.some(c => c.date === today);
          return (
            <div
              key={routine.id}
              className="flex items-center justify-between px-4 py-2.5 hover:bg-[var(--surface-0)] transition-colors duration-[var(--transition-fast)]"
            >
              <div className="flex items-center gap-3 min-w-0">
                <button
                  onClick={() => toggleCompletion(routine.id)}
                  className={cn(
                    'flex-shrink-0 w-5 h-5 rounded-[var(--radius-sm)] border flex items-center justify-center transition-colors duration-[var(--transition-fast)] active:scale-[0.96]',
                    isCompleted
                      ? 'bg-emerald-900/40 border-emerald-700/50 text-emerald-400'
                      : 'border-[var(--border-strong)] text-transparent hover:border-[var(--accent-500)] hover:text-[var(--accent-400)]',
                  )}
                >
                  {isCompleted ? <Check size={11} /> : <Plus size={11} />}
                </button>
                <span className={cn(
                  'text-sm truncate',
                  isCompleted ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]',
                )}>
                  {routine.icon && <span className="mr-1.5">{routine.icon}</span>}
                  {routine.name}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                {routine.streak > 0 && (
                  <span className="flex items-center gap-1 text-xs tabular-nums text-[var(--text-muted)]">
                    <Flame size={11} className={routine.streak >= 7 ? 'text-orange-400' : ''} />
                    {routine.streak}
                  </span>
                )}
              </div>
            </div>
          );
        })}
    </div>
  );

  if (embedded) return collapsed ? null : routineContent;

  return (
    <motion.div
      className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] overflow-hidden"
      variants={fadeSlideUp}
      initial="hidden"
      animate="show"
    >
      <div className="flex items-center justify-between px-4 py-2.5">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          {onToggleCollapse && (
            <ChevronRight
              size={14}
              className={cn(
                'text-[var(--text-secondary)] transition-transform duration-150',
                !collapsed && 'rotate-90',
              )}
            />
          )}
          <Repeat size={14} className="text-[var(--accent-400)]" />
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Routine Snapshot
          </span>
        </button>
        <Link
          href="/routines"
          className="text-xs text-[var(--accent-400)] hover:text-[var(--accent-300)] transition-colors duration-[var(--transition-fast)]"
        >
          View all →
        </Link>
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="routine-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            {routineContent}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
