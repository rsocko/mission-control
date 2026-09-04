'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Sun, Moon, Sunrise, CloudSun } from 'lucide-react';
import { HoustonIcon } from '@/components/ui/HoustonIcon';

interface DailySummary {
  overdue: number;
  dueToday: number;
  inProgress: number;
  triagePending: number;
  completedToday: number;
}

function getTimeOfDay(): 'morning' | 'afternoon' | 'evening' | 'night' {
  const hour = new Date().getHours();
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

function getGreeting(timeOfDay: string): string {
  switch (timeOfDay) {
    case 'morning': return 'Good morning';
    case 'afternoon': return 'Good afternoon';
    case 'evening': return 'Good evening';
    default: return 'Hey there';
  }
}

function getTimeIcon(timeOfDay: string) {
  switch (timeOfDay) {
    case 'morning':
      return <Sunrise size={14} className="text-[var(--text-tertiary)]" />;
    case 'afternoon':
      return <Sun size={14} className="text-[var(--text-tertiary)]" />;
    case 'evening':
      return <CloudSun size={14} className="text-[var(--text-tertiary)]" />;
    default:
      return <Moon size={14} className="text-[var(--text-tertiary)]" />;
  }
}

function getHoustonMessage(summary: DailySummary): string {
  if (summary.overdue > 0) {
    return `You have ${summary.overdue} overdue ${summary.overdue === 1 ? 'item' : 'items'} that need attention.`;
  }
  if (summary.dueToday > 0) {
    return `${summary.dueToday} ${summary.dueToday === 1 ? 'task' : 'tasks'} due today. Let's knock them out.`;
  }
  if (summary.triagePending > 0) {
    return `${summary.triagePending} items in your triage queue. Ready to process?`;
  }
  if (summary.completedToday > 0) {
    return `You've completed ${summary.completedToday} ${summary.completedToday === 1 ? 'task' : 'tasks'} today. Nice work.`;
  }
  return 'All systems nominal. What would you like to focus on?';
}

export function HoustonGreeting() {
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeOfDay] = useState<'morning' | 'afternoon' | 'evening' | 'night'>(getTimeOfDay);

  useEffect(() => {
    async function fetchSummary() {
      try {
        const [tasksRes, triageRes] = await Promise.allSettled([
          fetch('/api/tasks?status=todo&openOnly=true&parentOnly=true&countsOnly=true'),
          fetch('/api/triage?status=pending&limit=0'),
        ]);

        let overdue = 0;
        let dueToday = 0;
        let inProgress = 0;
        let completedToday = 0;

        if (tasksRes.status === 'fulfilled' && tasksRes.value.ok) {
          const data = await tasksRes.value.json();
          overdue = data?.stats?.overdue ?? 0;
          dueToday = data?.stats?.dueToday ?? 0;
          inProgress = data?.stats?.totalOpen ?? 0;
          completedToday = data?.stats?.recentlyCreated ?? 0;
        }

        let triagePending = 0;
        if (triageRes.status === 'fulfilled' && triageRes.value.ok) {
          const data = await triageRes.value.json();
          triagePending = data?.stats?.pending ?? data?.totalFiltered ?? 0;
        }

        setSummary({ overdue, dueToday, inProgress, triagePending, completedToday });
      } catch {
        setSummary({ overdue: 0, dueToday: 0, inProgress: 0, triagePending: 0, completedToday: 0 });
      } finally {
        setLoading(false);
      }
    }

    void fetchSummary();
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface-1)]/80 backdrop-blur-xl p-5"
    >
      {/* Greeting header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative">
          <HoustonIcon size={40} />
          <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-400 rounded-full border-2 border-[var(--surface-1)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {getTimeIcon(timeOfDay)}
            <h2 className="text-lg font-semibold text-[var(--text-primary)] truncate">
              {getGreeting(timeOfDay)}
            </h2>
          </div>
          <p className="text-xs text-[var(--text-tertiary)]">
            Houston is ready to assist
          </p>
        </div>
      </div>

      {/* Daily summary */}
      {loading ? (
        <div className="flex gap-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="flex-1 h-14 rounded-xl bg-[var(--surface-2)] animate-pulse" />
          ))}
        </div>
      ) : summary ? (
        <>
          <p className="text-sm text-[var(--text-secondary)] mb-3">
            {getHoustonMessage(summary)}
          </p>
          <div className="grid grid-cols-3 gap-2">
            <StatPill
              label="Overdue"
              value={summary.overdue}
              color={summary.overdue > 0 ? 'red' : 'muted'}
            />
            <StatPill
              label="Due Today"
              value={summary.dueToday}
              color={summary.dueToday > 0 ? 'amber' : 'muted'}
            />
            <StatPill
              label="Triage"
              value={summary.triagePending}
              color={summary.triagePending > 0 ? 'blue' : 'muted'}
            />
          </div>
        </>
      ) : null}
    </motion.div>
  );
}

function StatPill({ label, value, color }: { label: string; value: number; color: 'red' | 'amber' | 'blue' | 'muted' }) {
  const colorClasses = {
    red: 'text-red-400 bg-red-500/10 border-red-500/20',
    amber: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    blue: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
    muted: 'text-[var(--text-tertiary)] bg-[var(--surface-2)] border-[var(--border-subtle)]',
  };

  return (
    <div className={`rounded-xl border px-3 py-2 text-center ${colorClasses[color]}`}>
      <div className="text-lg font-bold leading-tight">{value}</div>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
    </div>
  );
}
