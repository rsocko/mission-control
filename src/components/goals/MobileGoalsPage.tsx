'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Plus, Loader2, Target } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils/cn';
import { staggerContainer } from '@/lib/motion';
import { parseLocalDate } from '@/lib/utils/date-format';
import { MobileGoalCard } from './MobileGoalCard';
import { EmptyState } from './EmptyState';
import type { FilterType, GoalItem } from './types';

type PeriodFilter = 'quarter' | 'annual' | 'all';

/** Determines if a goal falls within the current quarter based on dueDate or createdAt. */
function isInCurrentQuarter(item: GoalItem): boolean {
  const now = new Date();
  const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const nextQuarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + 3, 1);

  const dateStr = item.dueDate || item.createdAt;
  if (!dateStr) return true;
  const date = item.dueDate ? parseLocalDate(dateStr) : new Date(dateStr);
  if (!date || Number.isNaN(date.getTime())) return true;
  return date >= quarterStart && date < nextQuarterStart;
}

/** Determines if a goal falls within the current year. */
function isInCurrentYear(item: GoalItem): boolean {
  const now = new Date();
  const dateStr = item.dueDate || item.createdAt;
  if (!dateStr) return true;
  const date = item.dueDate ? parseLocalDate(dateStr) : new Date(dateStr);
  return !date || Number.isNaN(date.getTime()) || date.getFullYear() === now.getFullYear();
}

function getCurrentQuarterLabel(): string {
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3) + 1;
  return `Q${quarter} ${now.getFullYear()}`;
}

export function MobileGoalsPage() {
  const [items, setItems] = useState<GoalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>('all');
  const prefersReducedMotion = useReducedMotion() ?? false;

  const fetchGoals = useCallback(async () => {
    try {
      // Only fetch goals (not ideas/brainstorms) for mobile goals view
      const res = await fetch('/api/goals?filter=goal');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setItems(data.items || []);
    } catch {
      toast.error('Failed to load goals');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGoals();
  }, [fetchGoals]);

  useEffect(() => {
    const handler = () => fetchGoals();
    window.addEventListener('mission-control:task-added', handler);
    return () => window.removeEventListener('mission-control:task-added', handler);
  }, [fetchGoals]);

  // Apply period filter
  const filteredItems = items.filter(item => {
    if (periodFilter === 'quarter') return isInCurrentQuarter(item);
    if (periodFilter === 'annual') return isInCurrentYear(item);
    return true;
  });

  // Sort by progress descending (most active first)
  const sortedItems = [...filteredItems].sort((a, b) => {
    const progressA = a.progress ?? 0;
    const progressB = b.progress ?? 0;
    // Active goals (with some progress) first, then by progress desc
    if (progressA > 0 && progressB === 0) return -1;
    if (progressB > 0 && progressA === 0) return 1;
    return progressB - progressA;
  });

  const periodOptions: Array<{ value: PeriodFilter; label: string }> = [
    { value: 'quarter', label: getCurrentQuarterLabel() },
    { value: 'annual', label: 'Annual' },
    { value: 'all', label: 'All' },
  ];

  return (
    <div className="flex flex-col h-full bg-[var(--surface-0)]">
      {/* Page header content (below MobileHeader) */}
      <div className="px-5 pt-4 pb-2">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--accent-400)]/90">
              Objectives
            </p>
            <h2 className="mt-1 text-2xl font-semibold text-[var(--text-primary)]">
              Goals
            </h2>
          </div>
          <button
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)] transition-colors min-w-[44px] min-h-[44px]"
            aria-label="Add new goal"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('mission-control:open-quick-add', {
                detail: { defaultTags: ['goal'] },
              }));
            }}
          >
            <Plus size={13} />
          </button>
        </div>

        {/* Period filter chips (F-90) */}
        <div className="mt-4 flex gap-2">
          {periodOptions.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setPeriodFilter(value)}
              className={cn(
                'rounded-full px-3 py-1.5 text-xs font-medium transition-colors min-h-[32px]',
                periodFilter === value
                  ? 'bg-[var(--accent-600)]/20 text-[var(--text-primary)] ring-1 ring-inset ring-[var(--accent-400)]/30'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] bg-[var(--surface-2)]'
              )}
              aria-pressed={periodFilter === value}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Goals list */}
      <div className="flex-1 overflow-y-auto px-5 pb-28 pt-3">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={20} className="animate-spin text-[var(--text-tertiary)]" />
          </div>
        ) : sortedItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center px-4">
            <div className="w-12 h-12 rounded-full bg-[var(--surface-2)] flex items-center justify-center mb-3">
              <Target size={20} className="text-[var(--text-tertiary)]" />
            </div>
            <p className="text-sm font-medium text-[var(--text-secondary)]">
              {periodFilter !== 'all' ? 'No goals for this period' : 'No goals yet'}
            </p>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">
              {periodFilter !== 'all'
                ? 'Try switching to "All" to see all goals'
                : 'Create a goal to start tracking your objectives'}
            </p>
          </div>
        ) : (
          <motion.div
            variants={staggerContainer}
            initial={prefersReducedMotion ? 'show' : 'hidden'}
            animate="show"
            className="space-y-3"
          >
            {sortedItems.map((item) => (
              <MobileGoalCard key={item.id} item={item} />
            ))}
          </motion.div>
        )}
      </div>
    </div>
  );
}
