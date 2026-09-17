'use client';

import { useMemo, useState } from 'react';
import type {
  WorkActivityBreakdown,
  WorkActivityDimension,
} from '@/lib/stats/insights';

const DIMENSIONS: Array<{ value: WorkActivityDimension; label: string }> = [
  { value: 'lists', label: 'Lists' },
  { value: 'tags', label: 'Tags' },
  { value: 'projects', label: 'Projects' },
  { value: 'sources', label: 'Sources' },
];

interface Props {
  data: WorkActivityBreakdown;
}

export function WorkActivityChart({ data }: Props) {
  const [dimension, setDimension] = useState<WorkActivityDimension>('lists');
  const rows = data[dimension];
  const maxValue = useMemo(
    () => Math.max(1, ...rows.flatMap(row => [row.active, row.closed])),
    [rows],
  );

  return (
    <section
      className="rounded-2xl border border-slate-800 bg-slate-900 p-5"
      aria-labelledby="work-activity-heading"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="work-activity-heading" className="text-sm font-semibold">Active vs closed</h3>
          <p className="mt-1 max-w-2xl text-xs text-slate-400">
            Current open tasks compared with tasks completed in the selected period.
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Group activity by"
          className="flex w-fit rounded-lg bg-slate-800/70 p-0.5"
        >
          {DIMENSIONS.map(option => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={dimension === option.value}
              aria-controls="work-activity-panel"
              onClick={() => setDimension(option.value)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
                dimension === option.value
                  ? 'bg-slate-950 text-slate-100 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-4 text-xs text-slate-400" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-blue-500" /> Active now
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-emerald-500" /> Closed in period
        </span>
      </div>

      <div
        id="work-activity-panel"
        role="tabpanel"
        aria-label={`${DIMENSIONS.find(option => option.value === dimension)?.label} activity`}
        className="mt-4"
      >
        {rows.length === 0 ? (
          <p className="rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-8 text-center text-sm text-slate-500">
            No {dimension} have active or recently closed tasks.
          </p>
        ) : (
          <ol className="space-y-3">
            {rows.map(row => (
              <li
                key={row.key}
                role="img"
                aria-label={`${row.label}: ${row.active} active now, ${row.closed} closed in the selected period`}
                className="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)] items-center gap-3"
              >
                <span className="truncate text-xs font-medium text-slate-300" title={row.label}>
                  {row.label}
                </span>
                <div className="space-y-1.5">
                  <ActivityBar value={row.active} maxValue={maxValue} color="bg-blue-500" />
                  <ActivityBar value={row.closed} maxValue={maxValue} color="bg-emerald-500" />
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function ActivityBar({
  value,
  maxValue,
  color,
}: {
  value: number;
  maxValue: number;
  color: string;
}) {
  const width = value === 0 ? 0 : Math.max(4, (value / maxValue) * 100);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-2">
      <span className="h-2 overflow-hidden rounded-sm bg-slate-800">
        <span
          className={`block h-full rounded-sm ${color}`}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="text-right text-xs tabular-nums text-slate-400">
        {value.toLocaleString()}
      </span>
    </div>
  );
}
