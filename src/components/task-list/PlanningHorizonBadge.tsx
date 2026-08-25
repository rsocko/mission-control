import { Layers3 } from 'lucide-react';
import type { PlanningHorizon } from '@/types';
import { PLANNING_HORIZON_LABELS } from '@/lib/tasks/planning-horizon';

export function PlanningHorizonBadge({
  planningHorizon,
  className = '',
}: {
  planningHorizon: PlanningHorizon | null | undefined;
  className?: string;
}) {
  if (!planningHorizon) return null;

  const label = PLANNING_HORIZON_LABELS[planningHorizon];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded border border-emerald-800/30 bg-emerald-900/20 px-1.5 py-0.5 text-xs font-medium text-emerald-400 ${className}`}
      title={`Planning horizon: ${label}`}
    >
      <Layers3 size={10} aria-hidden="true" />
      {label}
    </span>
  );
}
