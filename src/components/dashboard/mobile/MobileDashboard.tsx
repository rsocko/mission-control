'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  Layers,
  Zap,
  ChevronRight,
  Activity,
  Target,
  Repeat,
  AlertTriangle,
  Sun,
  Grid2X2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TodayStats {
  totalOpen: number;
  completedToday: number;
  inProgress: number;
  overdue: number;
  completionPct: number;
}

interface QueueCounts {
  triage: number;
  sort: number;
  overdue: number;
}

interface RecentActivityItem {
  id: string;
  title: string;
  completedAt: string | null;
  type: 'completed';
}

interface MobileDashboardData {
  today: TodayStats;
  queues: QueueCounts;
  recentActivity: RecentActivityItem[];
}

// ─── Hook ───────────────────────────────────────────────────────────────────

function useMobileDashboardData() {
  const [data, setData] = useState<MobileDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/mobile-dashboard');
      if (!res.ok) throw new Error('Failed to load dashboard data');
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

/** F-83: Compact operational summary — today's status at a glance */
function StatusSnapshot({ stats }: { stats: TodayStats }) {
  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Today</span>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            <span className="font-semibold text-[var(--text-primary)]">{stats.inProgress}</span> in progress
            <span aria-hidden="true"> · </span>
            <span className="font-semibold text-red-400">{stats.overdue}</span> overdue
          </p>
        </div>
        <div className="text-right">
          <p className="text-base font-semibold tabular-nums text-emerald-400">{stats.completionPct}%</p>
          <p className="text-xs text-[var(--text-muted)]">{stats.completedToday} of {stats.totalOpen + stats.completedToday} done</p>
        </div>
      </div>
    </section>
  );
}

/** F-85: Action queues — things that need your attention NOW */
function ActionQueues({ queues }: { queues: QueueCounts }) {
  const actions = [
    {
      href: '/triage',
      icon: Layers,
      iconColor: 'text-sky-400',
      iconBg: 'bg-sky-500/15',
      label: 'Process Triage',
      description: 'Review incoming items',
      count: queues.triage,
      countLabel: 'pending',
      badgeBg: 'bg-sky-500/15',
      badgeText: 'text-sky-300',
      show: queues.triage > 0,
    },
    {
      href: '/quick-sort',
      icon: Zap,
      iconColor: 'text-amber-400',
      iconBg: 'bg-amber-500/15',
      label: 'Quick Sort',
      description: 'Prioritize unsorted tasks',
      count: queues.sort,
      countLabel: 'unsorted',
      badgeBg: 'bg-amber-500/15',
      badgeText: 'text-amber-300',
      show: queues.sort > 0,
    },
    {
      href: '/today',
      icon: AlertTriangle,
      iconColor: 'text-red-400',
      iconBg: 'bg-red-500/15',
      label: 'Fix Overdue',
      description: 'Reschedule or complete',
      count: queues.overdue,
      countLabel: 'overdue',
      badgeBg: 'bg-red-500/15',
      badgeText: 'text-red-300',
      show: queues.overdue > 0,
    },
  ].filter((a) => a.show);

  if (actions.length === 0) {
    return (
      <section className="rounded-2xl bg-[var(--surface-1)] border border-[var(--border)] p-4 text-center">
        <CheckCircle2 size={24} className="text-emerald-400 mx-auto mb-2" />
        <p className="text-sm text-[var(--text-secondary)] font-medium">All caught up!</p>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">No queues need attention right now</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-[var(--surface-1)] border border-[var(--border)] p-4">
      <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Needs Attention
      </span>
      <div className="mt-3 space-y-2">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <Link
              key={action.href}
              href={action.href}
              className="flex min-h-[44px] items-center gap-3 p-2.5 -mx-1 rounded-xl hover:bg-[var(--surface-2)] transition-colors group"
            >
              <span className={cn('flex items-center justify-center w-9 h-9 rounded-lg', action.iconBg)}>
                <Icon size={16} className={action.iconColor} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">{action.label}</p>
                <p className="text-xs text-[var(--text-muted)]">{action.description}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', action.badgeBg, action.badgeText)}>
                  {action.count} {action.countLabel}
                </span>
                <ChevronRight size={14} className="text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** F-85: Compact action strip — secondary destinations after urgent work */
function GoTo() {
  const destinations = [
    { href: '/today', icon: Sun, label: 'My Day', color: 'text-amber-400' },
    { href: '/triage', icon: Layers, label: 'Triage', color: 'text-sky-400' },
    { href: '/quick-sort', icon: Zap, label: 'Sort', color: 'text-amber-300' },
    { href: '/goals', icon: Target, label: 'Goals', color: 'text-rose-400' },
    { href: '/routines', icon: Repeat, label: 'Routines', color: 'text-emerald-400' },
    { href: '/insights', icon: Activity, label: 'Insights', color: 'text-cyan-400' },
    { href: '/matrix', icon: Grid2X2, label: 'Matrix', color: 'text-blue-400' },
  ];

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
      <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Go To</span>
      <div className="mt-2 flex gap-1 overflow-x-auto pb-1 scrollbar-none">
        {destinations.map((d) => {
          const Icon = d.icon;
          return (
            <Link
              key={d.href}
              href={d.href}
              className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            >
              <Icon size={15} className={d.color} />
              <span className="text-xs font-medium">{d.label}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** Recent completions — momentum feedback (lightweight, not analytics) */
function RecentWins({ items }: { items: RecentActivityItem[] }) {
  if (items.length === 0) return null;

  return (
    <section className="rounded-2xl bg-[var(--surface-1)] border border-[var(--border)] p-4">
      <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Recent Wins
      </span>
      <div className="mt-3 space-y-2">
        {items.slice(0, 3).map((item) => (
          <div key={item.id} className="flex items-center gap-2 text-xs">
            <CheckCircle2 size={12} className="text-emerald-400 flex-shrink-0" />
            <span className="text-[var(--text-secondary)] truncate flex-1">
              {item.title}
            </span>
            <span className="text-[var(--text-muted)] flex-shrink-0">
              {formatRelativeTime(item.completedAt)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ─── Loading Skeleton ───────────────────────────────────────────────────────

function MobileDashboardSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="rounded-2xl bg-[var(--surface-1)] border border-[var(--border)] p-4 h-[100px]" />
      <div className="rounded-2xl bg-[var(--surface-1)] border border-[var(--border)] p-4 h-[140px]" />
      <div className="rounded-2xl bg-[var(--surface-1)] border border-[var(--border)] p-4 h-[160px]" />
      <div className="rounded-2xl bg-[var(--surface-1)] border border-[var(--border)] p-4 h-[80px]" />
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

/**
 * Mobile-optimized dashboard — a launchpad for action.
 *
 * Philosophy: "What should I go DO right now?"
 * - Action queues (things that need attention — triage, sort, overdue)
 * - Compact status snapshot
 * - Secondary navigation strip
 * - Recent wins (lightweight momentum, not analytics)
 *
 * Analytics/trends/historical data live in /insights.
 */
export function MobileDashboard() {
  const { data, loading, error } = useMobileDashboardData();

  if (loading) return <MobileDashboardSkeleton />;

  if (error || !data) {
    return (
      <div className="rounded-2xl bg-[var(--surface-1)] border border-[var(--border)] p-6 text-center">
        <p className="text-sm text-[var(--text-secondary)]">Unable to load dashboard</p>
        <p className="text-xs text-[var(--text-muted)] mt-1">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-20">
      <ActionQueues queues={data.queues} />
      <StatusSnapshot stats={data.today} />
      <GoTo />
      <RecentWins items={data.recentActivity} />
    </div>
  );
}
