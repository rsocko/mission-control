'use client';

import React from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { motion, AnimatePresence } from 'motion/react';
import {
  getScoreTier,
  SMART_SCORE_FACTOR_MAX,
  type ScoreBreakdown,
} from '@/lib/smart-score';
import { AnimatedCounter } from '@/components/ui/AnimatedCounter';

interface SmartScoreBadgeProps {
  score: number;
  breakdown?: ScoreBreakdown;
  size?: 'sm' | 'md';
  displayMode?: 'score' | 'percentile';
}

const SCORE_COLORS = {
  high: 'bg-blue-600 text-white',
  mid: 'bg-amber-500/12 text-amber-300',
  low: 'bg-slate-700 text-slate-500',
};

function percentileColor(topPercent: number): string {
  if (topPercent <= 1) return 'bg-emerald-500 text-emerald-950';
  if (topPercent <= 5) return 'bg-cyan-500/20 text-cyan-200';
  if (topPercent <= 15) return 'bg-violet-500/20 text-violet-200';
  return 'bg-slate-700 text-slate-400';
}

function formatTopPercent(topPercent: number): string {
  return topPercent < 1
    ? topPercent.toFixed(1)
    : Number.isInteger(topPercent)
      ? topPercent.toFixed(0)
      : topPercent.toFixed(1);
}

export function SmartScoreBadge({
  score,
  breakdown,
  size = 'md',
  displayMode = 'score',
}: SmartScoreBadgeProps) {
  const tier = getScoreTier(score);
  const scopeRanking = breakdown?.audit.ranking?.scope;
  const showPercentile = displayMode === 'percentile' && scopeRanking;
  const colorClass = showPercentile
    ? percentileColor(scopeRanking.topPercent)
    : SCORE_COLORS[tier];

  const sizeClass = size === 'sm'
    ? showPercentile
      ? 'min-w-11 h-7 px-1.5 text-[11px] rounded-lg'
      : 'w-9 h-7 text-xs rounded-lg'
    : showPercentile
      ? 'min-w-16 h-9 px-2 text-xs rounded-xl'
      : 'w-11 h-9 text-sm rounded-xl';
  const accessibleLabel = showPercentile
    ? `Smart score percentile: top ${formatTopPercent(scopeRanking.topPercent)} percent in ${scopeRanking.label}`
    : `Smart score: ${score} out of 100`;

  return (
    <RadixTooltip.Root delayDuration={200}>
      <RadixTooltip.Trigger asChild>
        <div tabIndex={0} role="group" aria-label={accessibleLabel}>
          <div className={`${sizeClass} ${colorClass} flex items-center justify-center font-bold tabular-nums shadow-inner`}>
            {showPercentile
              ? `${formatTopPercent(scopeRanking.topPercent)}%`
              : <AnimatedCounter value={score} />}
          </div>
        </div>
      </RadixTooltip.Trigger>
      {breakdown && (
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side="bottom"
            align="end"
            sideOffset={8}
            className="z-[9999] pointer-events-none"
          >
            <AnimatePresence>
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.15 }}
                className="w-[310px] p-3.5 bg-slate-950 border border-blue-500/15 rounded-xl shadow-2xl"
              >
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-xs font-semibold">Smart Score</div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      Attention-worthiness, not ease of execution
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold text-blue-400">{breakdown.total}</div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      {breakdown.audit.confidence.level} confidence · {breakdown.audit.confidence.percentage}%
                    </div>
                  </div>
                </div>

                <div className="space-y-2.5">
                  <BreakdownRow label="Priority" value={breakdown.priority} max={SMART_SCORE_FACTOR_MAX.priority} color="bg-rose-400" />
                  <BreakdownRow label="Due-date urgency" value={breakdown.urgency} max={SMART_SCORE_FACTOR_MAX.urgency} color="bg-sky-400" />
                  <BreakdownRow label="Planning horizon" value={breakdown.planningHorizon} max={SMART_SCORE_FACTOR_MAX.planningHorizon} color="bg-violet-400" />
                  <BreakdownRow label="Organizational context" value={breakdown.organizationalContext} max={SMART_SCORE_FACTOR_MAX.organizationalContext} color="bg-blue-400" />
                  <BreakdownRow label="Momentum" value={breakdown.momentum} max={SMART_SCORE_FACTOR_MAX.momentum} color="bg-emerald-400" />
                  <BreakdownRow label="Source trust" value={breakdown.sourceTrust} max={SMART_SCORE_FACTOR_MAX.sourceTrust} color="bg-cyan-400" />
                  {breakdown.snoozePenalty < 0 && (
                    <BreakdownRow label="Snooze penalty" value={breakdown.snoozePenalty} max={SMART_SCORE_FACTOR_MAX.snoozePenalty} color="bg-amber-400" isPenalty />
                  )}
                </div>

                {breakdown.audit.ranking && (
                  <div className="mt-3 border-t border-slate-800 pt-2.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      Relative position
                    </div>
                    <div className="mt-1.5 space-y-1 text-xs text-slate-300">
                      <RankingLine ranking={breakdown.audit.ranking.scope} />
                      {breakdown.audit.ranking.overall
                        && breakdown.audit.ranking.overall.label !== breakdown.audit.ranking.scope.label && (
                        <RankingLine ranking={breakdown.audit.ranking.overall} />
                      )}
                    </div>
                  </div>
                )}

                <div className="mt-3 border-t border-slate-800 pt-2.5">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Audit
                  </div>
                  <div className="mt-1.5 space-y-1 text-xs text-slate-300">
                    {breakdown.audit.evidence
                      .filter((item) => item.points !== 0)
                      .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
                      .slice(0, 6)
                      .map((item, index) => (
                        <div key={`${item.factor}-${item.label}-${index}`} className="flex gap-2">
                          <span className="min-w-6 text-right font-semibold tabular-nums text-slate-400">
                            {item.points > 0 ? `+${item.points}` : item.points}
                          </span>
                          <span>{item.label}: {item.detail}</span>
                        </div>
                      ))}
                    {breakdown.audit.missingSignals.length > 0 && (
                      <div className="pt-1 text-slate-500">
                        Missing: {breakdown.audit.missingSignals.join('; ')}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-3 border-t border-slate-800 pt-2.5 text-xs text-slate-400">
                  <div className="font-medium text-slate-300">Planning context only</div>
                  <div className="mt-0.5">
                    Duration {breakdown.audit.sessionFit.estimatedDuration === null
                      ? 'unknown'
                      : `${breakdown.audit.sessionFit.estimatedDuration} min`} · Effort{' '}
                    {breakdown.audit.sessionFit.effort ?? 'unknown'}
                  </div>
                  <div className="mt-0.5 text-slate-500">{breakdown.audit.sessionFit.note}</div>
                </div>

                <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center justify-between text-xs">
                  <span className="text-slate-400">Total</span>
                  <span className="font-semibold text-white">{breakdown.total}</span>
                </div>
              </motion.div>
            </AnimatePresence>
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      )}
    </RadixTooltip.Root>
  );
}

function RankingLine({ ranking }: {
  ranking: NonNullable<ScoreBreakdown['audit']['ranking']>['scope'];
}) {
  const formattedPercent = formatTopPercent(ranking.topPercent);
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 truncate" title={ranking.label}>
        {ranking.label}
      </span>
      <span className="shrink-0 text-right font-medium tabular-nums text-slate-200">
        #{ranking.rank.toLocaleString()} of {ranking.total.toLocaleString()} · Top {formattedPercent}%
      </span>
    </div>
  );
}

function BreakdownRow({ label, value, max, color, isPenalty }: { label: string; value: number; max: number; color: string; isPenalty?: boolean }) {
  const magnitude = isPenalty ? Math.abs(value) : value;
  const pct = Math.max(0, Math.min(100, (magnitude / max) * 100));
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-400">{label}</span>
        <span className={`font-medium tabular-nums ${isPenalty ? 'text-amber-400' : 'text-slate-300'}`}>
          {value} / {max}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={magnitude}
        />
      </div>
    </div>
  );
}
