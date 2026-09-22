'use client';

import {
  TASK_PRIORITY_VISUALS,
  TASK_STATUS_VISUALS,
} from '@/lib/constants/task-formatting';
import type { TaskBreakdown, TaskBreakdownItem } from '@/lib/stats/insights';

interface Props {
  data: TaskBreakdown;
  compact?: boolean;
}

const PRIORITY_VISUALS: Record<string, { label: string; color: string }> = TASK_PRIORITY_VISUALS;
const STATUS_VISUALS: Record<string, { label: string; color: string }> = {
  todo: TASK_STATUS_VISUALS.todo,
  in_progress: TASK_STATUS_VISUALS.in_progress,
  done: TASK_STATUS_VISUALS.done,
  cancelled: TASK_STATUS_VISUALS.cancelled,
};

function Breakdown({
  title,
  description,
  items,
  visuals,
}: {
  title: string;
  description: string;
  items: TaskBreakdownItem[];
  visuals: Record<string, { label: string; color: string }>;
}) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const summary = items
    .filter((item) => item.count > 0)
    .map((item) => `${visuals[item.value]?.label ?? item.value}: ${item.count}`)
    .join(', ');

  return (
    <section aria-label={title}>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-100">{title}</h4>
          <p className="mt-0.5 text-xs text-slate-500">{description}</p>
        </div>
        <span className="shrink-0 text-lg font-semibold tabular-nums text-slate-100">
          {total.toLocaleString()}
        </span>
      </div>

      {total === 0 ? (
        <div className="mt-4 flex h-12 items-center justify-center rounded-lg border border-dashed border-slate-700 text-xs text-slate-500">
          No tasks in this scope
        </div>
      ) : (
        <>
          <div
            role="img"
            aria-label={`${title}. ${summary}`}
            className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-slate-800"
          >
            {items.filter((item) => item.count > 0).map((item) => (
              <span
                key={item.value}
                title={`${visuals[item.value]?.label ?? item.value}: ${item.count} (${item.percentage}%)`}
                style={{
                  backgroundColor: visuals[item.value]?.color ?? '#64748b',
                  width: `${(item.count / total) * 100}%`,
                }}
              />
            ))}
          </div>
          <dl className="mt-3 space-y-2">
            {items.map((item) => {
              const visual = visuals[item.value] ?? { label: item.value, color: '#64748b' };
              return (
                <div key={item.value} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 text-xs">
                  <dt className="flex min-w-0 items-center gap-2 text-slate-300">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: visual.color }} />
                    <span className="truncate">{visual.label}</span>
                  </dt>
                  <dd className="w-9 text-right tabular-nums text-slate-100">{item.count.toLocaleString()}</dd>
                  <dd className="w-9 text-right tabular-nums text-slate-500">{item.percentage}%</dd>
                </div>
              );
            })}
          </dl>
        </>
      )}
    </section>
  );
}

export function TaskBreakdownChart({ data, compact = false }: Props) {
  return (
    <div className={compact ? 'space-y-5' : 'grid grid-cols-1 gap-6 md:grid-cols-2'}>
      <Breakdown
        title="Open tasks by priority"
        description="Current active, top-level work"
        items={data.byPriority}
        visuals={PRIORITY_VISUALS}
      />
      <Breakdown
        title="Tasks by status"
        description="Current active, top-level inventory"
        items={data.byStatus}
        visuals={STATUS_VISUALS}
      />
    </div>
  );
}
