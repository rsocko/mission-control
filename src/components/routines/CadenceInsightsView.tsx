'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { BarChart3, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fadeSlideUp } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { CADENCE_LABELS, type Routine } from './types';

export interface InsightSuggestion {
  type: 'increase' | 'decrease' | 'confirmed' | 'pattern';
  routine: Routine;
  title: string;
  detail: string;
  suggestion: string;
}

export function generateInsights(routines: Routine[]): InsightSuggestion[] {
  const insights: InsightSuggestion[] = [];
  const activeRoutines = routines.filter((routine) => !routine.isArchived);

  for (const routine of activeRoutines) {
    if (
      routine.cadenceType === 'x_per_week' &&
      routine.weeklyProgress &&
      routine.weeklyProgress.bonus > 0 &&
      routine.streak >= 2
    ) {
      insights.push({
        type: 'increase',
        routine,
        title: `"${routine.name}" — currently ${routine.cadenceConfig.target || 3}x/week`,
        detail: `You've consistently exceeded your target (${routine.weeklyProgress.done}x this week). Streak: ${routine.streak} weeks.`,
        suggestion: `Consider: Adjust to ${(routine.cadenceConfig.target || 3) + 1}x/week?`,
      });
    } else if (routine.intervalStatus && routine.intervalStatus.status === 'overdue_soft' && routine.streak === 0) {
      const cadenceLabel =
        routine.cadenceType === 'every_n_days'
          ? `every ${routine.cadenceConfig.minDays || 3}-${routine.cadenceConfig.maxDays || 4} days`
          : CADENCE_LABELS[routine.cadenceType];
      insights.push({
        type: 'decrease',
        routine,
        title: `"${routine.name}" — currently set to ${cadenceLabel}`,
        detail: `Last completed ${routine.intervalStatus.daysSinceLast} days ago. This pattern has been consistent.`,
        suggestion: 'Consider: Adjust to a longer interval? No shame — match reality.',
      });
    } else if (routine.streak >= 7) {
      insights.push({
        type: 'confirmed',
        routine,
        title: `"${routine.name}" — ${CADENCE_LABELS[routine.cadenceType]}`,
        detail: `You've maintained a ${routine.streak}-streak. This cadence fits you well.`,
        suggestion: 'No change needed.',
      });
    } else if (
      routine.cadenceType === 'daily' &&
      routine.streak === 0 &&
      routine.weekCompletions.length > 0 &&
      routine.weekCompletions.length < 5
    ) {
      insights.push({
        type: 'pattern',
        routine,
        title: `"${routine.name}" — currently daily`,
        detail: `You completed this ${routine.weekCompletions.length}/7 days this week.`,
        suggestion: 'Consider: Switch to "specific days" so non-completion days become intentional rest?',
      });
    }
  }

  return insights;
}

export function CadenceInsightsView({ routines }: { routines: Routine[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const visibleInsights = generateInsights(routines).filter((insight) => !dismissed.has(insight.routine.id));

  const dismiss = (routineId: string) => {
    setDismissed((previous) => new Set(previous).add(routineId));
  };

  const colorMap = {
    increase: {
      border: 'border-l-blue-500',
      bg: 'bg-blue-950/20',
      label: 'text-blue-400',
      labelText: '📈 Increase frequency suggestion',
    },
    decrease: {
      border: 'border-l-amber-500',
      bg: 'bg-amber-950/20',
      label: 'text-amber-400',
      labelText: '📉 Decrease frequency suggestion',
    },
    confirmed: {
      border: 'border-l-emerald-500',
      bg: 'bg-emerald-950/20',
      label: 'text-emerald-400',
      labelText: 'Confirmed pattern',
    },
    pattern: {
      border: 'border-l-purple-500',
      bg: 'bg-purple-950/20',
      label: 'text-purple-400',
      labelText: '🆕 Pattern detected',
    },
  };

  return (
    <motion.div variants={fadeSlideUp} className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
          <BarChart3 size={18} className="text-[var(--accent-400)]" />
          Cadence Insights
        </h2>
        <p className="mt-1 text-sm text-[var(--text-tertiary)]">
          Your patterns suggest some adjustments. These are suggestions, not rules.
        </p>
      </div>

      {visibleInsights.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-8 text-center">
          <CheckCircle2 size={32} className="mx-auto mb-3 text-emerald-500" />
          <p className="text-sm text-[var(--text-secondary)]">
            No insights right now. Keep tracking and patterns will emerge.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleInsights.map((insight) => {
            const colors = colorMap[insight.type];
            return (
              <div
                key={insight.routine.id}
                className={cn(
                  'rounded-[var(--radius-lg)] border border-[var(--border)] border-l-4 p-5',
                  colors.border,
                  colors.bg,
                )}
              >
                <p className={cn('text-xs font-semibold uppercase tracking-[0.14em]', colors.label)}>
                  {colors.labelText}
                </p>
                <h3 className="mt-2 text-sm font-semibold text-[var(--text-primary)]">{insight.title}</h3>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">{insight.detail}</p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">{insight.suggestion}</p>
                {insight.type !== 'confirmed' && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => dismiss(insight.routine.id)}>
                      Dismiss
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => dismiss(insight.routine.id)}>
                      Keep watching
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}
