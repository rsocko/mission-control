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
}

const SCORE_COLORS = {
  high: 'bg-blue-600 text-white',
  mid: 'bg-amber-500/12 text-amber-300',
  low: 'bg-slate-700 text-slate-500',
};

export function SmartScoreBadge({ score, breakdown, size = 'md' }: SmartScoreBadgeProps) {
  const tier = getScoreTier(score);
  const colorClass = SCORE_COLORS[tier];

  const sizeClass = size === 'sm'
    ? 'w-9 h-7 text-xs rounded-lg'
    : 'w-11 h-9 text-sm rounded-xl';

  return (
    <RadixTooltip.Root delayDuration={200}>
      <RadixTooltip.Trigger asChild>
        <div tabIndex={0} role="group" aria-label={`Smart score: ${score} out of 100`}>
          <div className={`${sizeClass} ${colorClass} flex items-center justify-center font-bold tabular-nums shadow-inner`}>
            <AnimatedCounter value={score} />
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
                className="w-[240px] p-3.5 bg-slate-950 border border-blue-500/15 rounded-xl shadow-2xl"
              >
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-xs font-semibold">Smart Score</div>
                    <div className="text-xs text-slate-400 mt-0.5">Each factor uses its own maximum</div>
                  </div>
                  <div className="text-lg font-bold text-blue-400">{breakdown.total}</div>
                </div>

                <div className="space-y-2.5">
                  <BreakdownRow label="Priority" value={breakdown.priorityBase} max={SMART_SCORE_FACTOR_MAX.priorityBase} color="bg-rose-400" />
                  <BreakdownRow label="Entity tier" value={breakdown.entityTier} max={SMART_SCORE_FACTOR_MAX.entityTier} color="bg-blue-400" />
                  <BreakdownRow label="Due-date urgency" value={breakdown.urgency} max={SMART_SCORE_FACTOR_MAX.urgency} color="bg-sky-400" />
                  <BreakdownRow label="Planning horizon" value={breakdown.planningHorizon} max={SMART_SCORE_FACTOR_MAX.planningHorizon} color="bg-violet-400" />
                  <BreakdownRow label="Source rank" value={breakdown.sourceRank} max={SMART_SCORE_FACTOR_MAX.sourceRank} color="bg-cyan-400" />
                  <BreakdownRow label="Freshness" value={breakdown.freshness} max={SMART_SCORE_FACTOR_MAX.freshness} color="bg-emerald-400" />
                  <BreakdownRow label="Execution fit" value={breakdown.executionFit} max={SMART_SCORE_FACTOR_MAX.executionFit} color="bg-lime-400" />
                  {breakdown.snoozePenalty < 0 && (
                    <BreakdownRow label="Snooze penalty" value={breakdown.snoozePenalty} max={SMART_SCORE_FACTOR_MAX.snoozePenalty} color="bg-amber-400" isPenalty />
                  )}
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
