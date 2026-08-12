'use client';

import { Activity, CheckCircle2, Gauge } from 'lucide-react';
import type { Stats } from '@/components/triage/types';
import type { TriageItem } from '@/types';

interface TriageQuickStatsProps {
  stats: Stats;
  items: TriageItem[];
}

export default function TriageQuickStats({ stats, items }: TriageQuickStatsProps) {
  const actionedToday = items.filter((item) => {
    if (item.status !== 'actioned') return false;
    const lastAction = item.actionsTaken[item.actionsTaken.length - 1];
    if (!lastAction) return false;
    const actionDate = new Date(lastAction.appliedAt);
    const today = new Date();
    return actionDate.toDateString() === today.toDateString();
  }).length;

  const avgScore = items.length > 0
    ? Math.round(items.reduce((sum, item) => sum + item.aiRelevanceScore, 0) / items.length)
    : 0;

  return (
    <div className="grid grid-cols-3 gap-2 rounded-[14px] border border-[var(--border)] bg-[var(--surface-0)] p-3">
      <div className="text-center">
        <div className="text-lg font-bold tabular-nums text-[var(--text-primary)]">{stats.pending}</div>
        <div className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">Pending</div>
      </div>
      <div className="text-center">
        <div className="flex items-center justify-center gap-1">
          <CheckCircle2 size={12} className="text-emerald-400" />
          <span className="text-lg font-bold tabular-nums text-[var(--text-primary)]">{actionedToday}</span>
        </div>
        <div className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">Actioned Today</div>
      </div>
      <div className="text-center">
        <div className="flex items-center justify-center gap-1">
          <Gauge size={12} className="text-[var(--accent-400)]" />
          <span className="text-lg font-bold tabular-nums text-[var(--text-primary)]">{avgScore}</span>
        </div>
        <div className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">Avg Score</div>
      </div>
    </div>
  );
}
