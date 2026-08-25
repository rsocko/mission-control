'use client';

import { useEffect, useState } from 'react';
import { Flame, Target, AlertCircle, Telescope, Grid2X2, Sigma, Tag } from 'lucide-react';
import { AnimatedCounter } from '@/components/ui/AnimatedCounter';

interface TriageStats {
  thisWeek: {
    total: number;
    byMode: {
      no_priority: number;
      quadrant: number;
      no_effort: number;
      no_tags: number;
      no_planning_horizon: number;
    };
  };
  streak: number;
}

export default function ActivityBanner() {
  const [stats, setStats] = useState<TriageStats | null>(null);

  useEffect(() => {
    fetch('/api/tasks/quick-sort-stats')
      .then((r) => r.json())
      .then((d) => setStats(d as TriageStats))
      .catch(() => {});
  }, []);

  // Don't render until we have data, and skip if there's no activity at all
  if (!stats || (stats.thisWeek.total === 0 && stats.streak === 0)) return null;

  const { thisWeek, streak } = stats;
  const {
    no_priority,
    quadrant = 0,
    no_effort,
    no_tags,
    no_planning_horizon,
  } = thisWeek.byMode;

  return (
    <div className="mx-4 mb-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-1)] px-4 py-3">
      {/* Headline row */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Target size={14} className="text-[var(--accent-400)] flex-shrink-0" />
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {thisWeek.total === 0
              ? 'No tasks sorted yet this week'
              : (
                  <>
                    <AnimatedCounter value={thisWeek.total} className="tabular-nums" />
                    {thisWeek.total === 1 ? ' task' : ' tasks'} sorted this week
                  </>
                )}
          </span>
        </div>
        {streak >= 2 && (
          <div className="flex items-center gap-1 text-orange-400 flex-shrink-0">
            <Flame size={14} />
            <span className="text-xs font-bold">
              <AnimatedCounter value={streak} className="tabular-nums" />-day streak
            </span>
          </div>
        )}
      </div>

      {/* Breakdown row — only show if there's been any activity */}
      {thisWeek.total > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-tertiary)]">
          {no_priority > 0 && (
            <span className="flex items-center gap-1">
              <AlertCircle size={11} className="text-amber-400" />
              <AnimatedCounter value={no_priority} className="tabular-nums" /> prioritized
            </span>
          )}
          {quadrant > 0 && (
            <span className="flex items-center gap-1">
              <Grid2X2 size={11} className="text-rose-400" />
              <AnimatedCounter value={quadrant} className="tabular-nums" /> quadrant decisions
            </span>
          )}
          {no_effort > 0 && (
            <span className="flex items-center gap-1">
              <Sigma size={11} className="text-sky-400" />
              <AnimatedCounter value={no_effort} className="tabular-nums" /> estimated
            </span>
          )}
          {no_tags > 0 && (
            <span className="flex items-center gap-1">
              <Tag size={11} className="text-violet-400" />
              <AnimatedCounter value={no_tags} className="tabular-nums" /> tagged
            </span>
          )}
          {no_planning_horizon > 0 && (
            <span className="flex items-center gap-1">
              <Telescope size={11} className="text-emerald-400" />
              <AnimatedCounter value={no_planning_horizon} className="tabular-nums" /> planned
            </span>
          )}
        </div>
      )}
    </div>
  );
}
