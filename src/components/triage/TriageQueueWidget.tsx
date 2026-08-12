'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Inbox, AlertTriangle, ChevronRight, Loader2 } from 'lucide-react';
import { fadeSlideUp } from '@/lib/motion';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { TriageSourceIcon } from '@/components/triage/TriageSourceIcon';
import type { QueueHealthMetrics } from '@/lib/triage/staleness';

function formatAge(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

interface TriageQueueWidgetProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function TriageQueueWidget({ collapsed, onToggleCollapse }: TriageQueueWidgetProps) {
  const [metrics, setMetrics] = useState<QueueHealthMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/triage/health');
      if (!res.ok) return;
      const data: QueueHealthMetrics = await res.json();
      setMetrics(data);
    } catch {
      // silent on dashboard
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchHealth(); }, [fetchHealth]);

  if (loading) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-4 flex items-center gap-2 text-[var(--text-muted)] text-sm">
        <Loader2 size={14} className="animate-spin" /> Loading triage queue…
      </div>
    );
  }

  // Don't render if no pending items
  if (!metrics || metrics.totalPending === 0) return null;

  const staleBuckets = [
    { label: '> 14d', count: metrics.over14d },
    { label: '> 7d', count: metrics.over7d - metrics.over14d },
    { label: '> 3d', count: metrics.over3d - metrics.over7d },
    { label: '> 24h', count: metrics.over24h - metrics.over3d },
  ].filter((b) => b.count > 0);

  const sortedSources = Object.entries(metrics.sourceCounts)
    .sort(([, a], [, b]) => b - a);

  const widgetContent = (
    <div className="px-4 pb-3 space-y-3">
      {/* Top row: metrics summary using horizontal space */}
      <div className="flex items-center gap-6">
        {/* Pending count */}
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular-nums text-[var(--text-primary)]">
            {metrics.totalPending}
          </span>
          <span className="text-xs text-[var(--text-muted)]">pending</span>
        </div>

        {/* Oldest age */}
        {metrics.oldestAgeHours !== null && (
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold tabular-nums text-[var(--text-secondary)]">
              {formatAge(metrics.oldestAgeHours)}
            </span>
            <span className="text-xs text-[var(--text-muted)]">oldest</span>
          </div>
        )}

        {/* Average age */}
        {metrics.averageAgeHours > 0 && (
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold tabular-nums text-[var(--text-secondary)]">
              {formatAge(metrics.averageAgeHours)}
            </span>
            <span className="text-xs text-[var(--text-muted)]">avg age</span>
          </div>
        )}

        {/* Staleness warning - inline */}
        {metrics.isStale && (
          <div className="flex items-center gap-1.5 ml-auto text-xs text-amber-300">
            <AlertTriangle size={12} className="flex-shrink-0" />
            <span className="tabular-nums">{metrics.over7d} stale</span>
          </div>
        )}
      </div>

      {/* Staleness breakdown + source distribution in a horizontal row */}
      <div className="flex items-center gap-4 flex-wrap">
        {/* Staleness pills */}
        {staleBuckets.length > 0 && (
          <div className="flex items-center gap-1.5">
            {staleBuckets.map((bucket) => (
              <span
                key={bucket.label}
                className={cn(
                  'px-2 py-0.5 rounded-full text-xs border tabular-nums',
                  bucket.label === '> 14d'
                    ? 'bg-red-900/30 text-red-300 border-red-800/40'
                    : bucket.label === '> 7d'
                      ? 'bg-amber-900/30 text-amber-300 border-amber-800/40'
                      : 'bg-slate-800/50 text-slate-300 border-slate-600/40',
                )}
              >
                {bucket.count} {bucket.label}
              </span>
            ))}
          </div>
        )}

        {/* Separator */}
        {staleBuckets.length > 0 && sortedSources.length > 0 && (
          <div className="w-px h-4 bg-[var(--border)]" />
        )}

        {/* Source distribution with icons */}
        {sortedSources.length > 0 && (
          <div className="flex items-center gap-2.5">
            {sortedSources.map(([platform, count]) => (
              <div
                key={platform}
                className="flex items-center gap-1 text-xs text-[var(--text-secondary)]"
                title={platform}
              >
                <TriageSourceIcon source={platform} size={14} />
                <span className="tabular-nums font-medium">{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

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
          <Inbox size={14} className={metrics.isStale ? 'text-amber-400' : 'text-[var(--accent-400)]'} />
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Triage Queue
          </span>
          {metrics.isStale && (
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          )}
        </button>
        <Link
          href="/triage"
          className="text-xs text-[var(--accent-400)] hover:text-[var(--accent-300)] transition-colors duration-[var(--transition-fast)]"
        >
          Review Queue →
        </Link>
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="triage-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            {widgetContent}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
