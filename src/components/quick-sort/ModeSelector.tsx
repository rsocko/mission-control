'use client';

import { AlertCircle, Clock3, Grid2X2, Loader2, Sigma, Tag, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnimatedCounter } from '@/components/ui/AnimatedCounter';
import type { QuickSortModeCounts, QuickSortQueueMode } from '@/lib/hooks/useQuickSortData';

const MODES: Array<{
  id: QuickSortQueueMode;
  label: string;
  description: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  accentClass: string;
  badgeClass: string;
}> = [
  {
    id: 'no_priority',
    label: 'Set Priority',
    description: 'Tasks without a priority level assigned',
    icon: AlertCircle,
    accentClass: 'border-amber-700/60 bg-amber-950/40 hover:bg-amber-950/70',
    badgeClass: 'bg-amber-900/60 text-amber-300',
  },
  {
    id: 'quadrant',
    label: 'Pick Quadrant',
    description: 'Decide what to do, schedule, delegate, or eliminate',
    icon: Grid2X2,
    accentClass: 'border-rose-700/60 bg-rose-950/40 hover:bg-rose-950/70',
    badgeClass: 'bg-rose-900/60 text-rose-300',
  },
  {
    id: 'no_effort',
    label: 'Estimate Effort',
    description: 'Tasks with no effort level set',
    icon: Sigma,
    accentClass: 'border-sky-700/60 bg-sky-950/40 hover:bg-sky-950/70',
    badgeClass: 'bg-sky-900/60 text-sky-300',
  },
  {
    id: 'no_tags',
    label: 'Add Tags',
    description: 'Tasks that have no tags yet',
    icon: Tag,
    accentClass: 'border-violet-700/60 bg-violet-950/40 hover:bg-violet-950/70',
    badgeClass: 'bg-violet-900/60 text-violet-300',
  },
  {
    id: 'no_planning_horizon',
    label: 'Set Time Horizon',
    description: 'Tasks not yet placed in Now, Next, Later, or Someday',
    icon: Clock3,
    accentClass: 'border-emerald-700/60 bg-emerald-950/40 hover:bg-emerald-950/70',
    badgeClass: 'bg-emerald-900/60 text-emerald-300',
  },
];

interface ModeSelectorProps {
  counts: QuickSortModeCounts | null;
  onSelect: (mode: QuickSortQueueMode) => void;
  selectedMode?: QuickSortQueueMode | null;
  disabled?: boolean;
}

export default function ModeSelector({
  counts,
  onSelect,
  selectedMode = null,
  disabled = false,
}: ModeSelectorProps) {
  return (
    <div className="flex flex-col gap-3 px-4 pt-2 pb-6">
      <div className="flex items-center gap-2 mb-1">
        <Zap size={16} className="text-[var(--accent-400)]" />
        <h2 className="text-sm font-semibold text-[var(--text-secondary)]">Choose a queue</h2>
      </div>
      {MODES.map((mode) => {
        const Icon = mode.icon;
        const count = counts ? counts[mode.id] : null;
        const isEmpty = count === 0;
        const isSelected = selectedMode === mode.id;
        const isDisabled = disabled || isEmpty;
        return (
          <button
            key={mode.id}
            onClick={() => onSelect(mode.id)}
            aria-pressed={isSelected}
            disabled={isDisabled}
            className={cn(
              'flex items-center gap-4 rounded-xl border px-4 py-4 text-left transition-all duration-150 active:scale-[0.98]',
              mode.accentClass,
              isSelected && 'ring-2 ring-inset ring-[var(--accent-400)]/55',
              isDisabled && 'cursor-not-allowed opacity-40'
            )}
          >
            <div className="flex-shrink-0">
              <Icon size={22} className="text-[var(--text-secondary)]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[var(--text-primary)] text-base">{mode.label}</span>
                {count !== null ? (
                  <span className={cn('text-xs font-bold px-1.5 py-0.5 rounded-full', mode.badgeClass)}>
                    <AnimatedCounter value={count} className="tabular-nums" />
                  </span>
                ) : (
                  <Loader2 size={12} className="animate-spin text-[var(--text-tertiary)]" />
                )}
              </div>
              <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{mode.description}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
