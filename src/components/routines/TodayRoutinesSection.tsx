'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Repeat, Check, Flame, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { fadeSlideUp, staggerContainer } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { getLocalToday as getClientToday } from '@/lib/utils/client-date';

interface TodayRoutine {
  id: string;
  name: string;
  icon: string | null;
  cadenceType: string;
  cadenceConfig: { days?: number[] };
  streak: number;
  weekCompletions: Array<{ date: string; id: string }>;
}

/**
 * "Today's Routines" section for the My Day view with inline check-off.
 */
export function TodayRoutinesSection() {
  const [routines, setRoutines] = useState<TodayRoutine[]>([]);
  const [loading, setLoading] = useState(true);
  const today = getClientToday();

  const fetchRoutines = useCallback(async () => {
    try {
      const res = await fetch(`/api/routines?date=${today}`);
      if (!res.ok) return;
      const data = await res.json();
      setRoutines(data.routines || []);
    } catch {
      // silent
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
        await fetch('/api/routines/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ routineId, date: today }),
        });
      }
      fetchRoutines();
    } catch {
      toast.error('Failed to toggle routine');
    }
  };

  if (loading || routines.length === 0) return null;

  // Filter to routines relevant today
  const todayDow = new Date(today + 'T12:00:00').getDay();
  const todayRoutines = routines.filter(r => {
    if (r.cadenceType === 'daily') return true;
    if (r.cadenceType === 'specific_days') {
      return r.cadenceConfig?.days?.includes(todayDow) ?? false;
    }
    return false;
  });

  if (todayRoutines.length === 0) return null;

  const doneCount = todayRoutines.filter(r => r.weekCompletions.some(c => c.date === today)).length;

  return (
    <section className="mb-6">
      <h3 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide mb-3 flex items-center gap-2">
        <Repeat size={12} className="text-[var(--accent-400)]" />
        Today&apos;s Routines ({doneCount}/{todayRoutines.length})
      </h3>
      <motion.div
        className="bg-[var(--surface-1)] rounded-lg border border-[var(--border)] divide-y divide-[var(--border-subtle)]"
        variants={staggerContainer}
        initial="hidden"
        animate="show"
      >
        {todayRoutines.map(routine => {
          const isCompleted = routine.weekCompletions.some(c => c.date === today);
          return (
            <motion.div
              key={routine.id}
              variants={fadeSlideUp}
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
              {routine.streak > 0 && (
                <span className="flex items-center gap-1 text-xs tabular-nums text-[var(--text-muted)] flex-shrink-0 ml-3">
                  <Flame size={11} className={routine.streak >= 7 ? 'text-orange-400' : ''} />
                  {routine.streak}
                </span>
              )}
            </motion.div>
          );
        })}
      </motion.div>
    </section>
  );
}
