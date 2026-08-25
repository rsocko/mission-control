'use client';

import { Clock3 } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  PLANNING_HORIZON_LABELS,
  PLANNING_HORIZON_VISUALS,
} from '@/lib/tasks/planning-horizon';
import { cn } from '@/lib/utils';
import type { PlanningHorizon } from '@/types';

const PLANNING_HORIZON_HELP = 'Broad planning intent, independent of due dates.';

export function PlanningHorizonFieldLabel({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-1.5', className)}>
      <Tooltip content="Planning horizon" subtitle={PLANNING_HORIZON_HELP}>
        <span
          tabIndex={0}
          aria-label={`About planning horizon. ${PLANNING_HORIZON_HELP}`}
          className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)]"
        >
          <Clock3 size={13} aria-hidden="true" />
        </span>
      </Tooltip>
      <span>Planning horizon</span>
    </span>
  );
}

export function PlanningHorizonOption({
  value,
  className,
}: {
  value: PlanningHorizon | null;
  className?: string;
}) {
  const visual = value ? PLANNING_HORIZON_VISUALS[value] : null;
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'size-2 shrink-0 rounded-full',
          visual?.dotClass ?? 'border border-[var(--text-muted)]',
        )}
      />
      <span className={visual?.textClass ?? 'text-[var(--text-muted)]'}>
        {value ? PLANNING_HORIZON_LABELS[value] : 'Not set'}
      </span>
    </span>
  );
}
