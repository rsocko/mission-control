'use client';

import Link from 'next/link';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { FlowInsightsResult } from '@/lib/stats/flow-query';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TASK_STATUS_VISUALS } from '@/lib/constants/task-formatting';

export interface FlowFilterValues {
  projectId: string;
  source: string;
  priority: string;
  status: string;
  staleDays: string;
}

interface Props {
  data: FlowInsightsResult;
  filters: FlowFilterValues;
  onFilterChange: (name: keyof FlowFilterValues, value: string) => void;
}

const STATUS_COLORS = {
  todo: TASK_STATUS_VISUALS.todo.color,
  inProgress: TASK_STATUS_VISUALS.in_progress.color,
  done: TASK_STATUS_VISUALS.done.color,
  cancelled: TASK_STATUS_VISUALS.cancelled.color,
};
const ALL_FILTER_VALUE = '__all__';

function formatDays(value: number | null): string {
  return value === null ? '-' : `${value.toLocaleString()}d`;
}

function EmptyChart({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-52 items-center justify-center rounded-xl border border-dashed border-slate-700 text-center text-sm text-slate-500">
      {children}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-36 flex-col gap-1 text-xs text-slate-400">
      {label}
      <Select
        value={value || ALL_FILTER_VALUE}
        onValueChange={nextValue => onChange(nextValue === ALL_FILTER_VALUE ? '' : nextValue)}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER_VALUE}>All</SelectItem>
        {options.filter(option => option.value.trim()).map(option => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
        </SelectContent>
      </Select>
    </label>
  );
}

export function FlowInsightsSection({ data, filters, onFilterChange }: Props) {
  const commitStaleDraft = (input: HTMLInputElement) => {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) {
      input.value = filters.staleDays;
      return;
    }
    const clamped = String(Math.min(365, Math.max(1, Math.round(parsed))));
    input.value = clamped;
    if (clamped !== filters.staleDays) onFilterChange('staleDays', clamped);
  };

  const cfdData = data.cumulativeFlow.points.map(point => ({
    ...point,
    todo: point.coverage === 'unavailable' ? null : point.todo,
    inProgress: point.coverage === 'unavailable' ? null : point.inProgress,
    done: point.coverage === 'unavailable' ? null : point.done,
    cancelled: point.coverage === 'unavailable' ? null : point.cancelled,
    label: new Date(`${point.date}T12:00:00`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    }),
  }));

  return (
    <section aria-labelledby="flow-heading" className="mb-6 space-y-5">
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">Flow</p>
            <h3 id="flow-heading" className="mt-1 text-lg font-semibold">Work movement and bottlenecks</h3>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">
              Based only on recorded task transitions. Historical Kanban column identities are not
              versioned, so these reports use normalized Todo, In progress, Done, and Cancelled states.
              Source, priority, and current-status filters use current task metadata.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <FilterSelect
              label="Project"
              value={filters.projectId}
              options={data.filterOptions.projects.map(project => ({
                value: project.id,
                label: project.name,
              }))}
              onChange={value => onFilterChange('projectId', value)}
            />
            <FilterSelect
              label="Source"
              value={filters.source}
              options={data.filterOptions.sources.map(source => ({ value: source, label: source }))}
              onChange={value => onFilterChange('source', value)}
            />
            <FilterSelect
              label="Priority"
              value={filters.priority}
              options={data.filterOptions.priorities.map(priority => ({ value: priority, label: priority }))}
              onChange={value => onFilterChange('priority', value)}
            />
            <FilterSelect
              label="Current status"
              value={filters.status}
              options={data.filterOptions.statuses.map(status => ({ value: status, label: status }))}
              onChange={value => onFilterChange('status', value)}
            />
            <label className="flex w-28 flex-col gap-1 text-xs text-slate-400">
              Stale after
              <span className="relative">
                <input
                  aria-label="Stale threshold in days"
                  type="number"
                  min={1}
                  max={365}
                  key={filters.staleDays}
                  defaultValue={filters.staleDays}
                  onBlur={event => commitStaleDraft(event.currentTarget)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 pr-8 text-sm text-slate-200 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                />
                <span className="pointer-events-none absolute right-2.5 top-2 text-xs text-slate-500">days</span>
              </span>
            </label>
          </div>
        </div>
        {data.partialHistory && (
          <div role="status" className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            Partial history: state before {new Date(data.historicalBoundaryAt!).toLocaleString()} is
            unknown and is not inferred. Unavailable CFD dates are left blank, and tasks without
            recorded state entry are excluded from duration metrics.
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="mb-4">
            <h4 className="text-sm font-semibold">Cycle Time</h4>
            <p className="mt-1 text-xs text-slate-400">
              First recorded entry into In progress through final completion in this window.
              Reopened work keeps its original start and is marked as rework.
            </p>
          </div>
          <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Median" value={formatDays(data.cycleTime.medianDays)} />
            <Metric label="Average" value={formatDays(data.cycleTime.averageDays)} />
            <Metric label="85th percentile" value={formatDays(data.cycleTime.percentile85Days)} />
            <Metric label="Reworked" value={data.cycleTime.reworkedCount.toLocaleString()} />
          </dl>
          {data.cycleTime.count === 0 ? (
            <EmptyChart>No completed tasks have both a recorded start and final completion in this range.</EmptyChart>
          ) : (
            <div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.cycleTime.distribution} accessibilityLayer>
                  <CartesianGrid stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
                  <Tooltip
                    cursor={{ fill: 'rgba(51,65,85,0.25)' }}
                    contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8 }}
                    formatter={value => [Number(value ?? 0).toLocaleString(), 'Tasks']}
                  />
                  <Bar dataKey="count" name="Tasks" fill="#22d3ee" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <AccessibleDataTable
                caption="Cycle time distribution by duration bucket"
                headers={['Duration', 'Tasks']}
                rows={data.cycleTime.distribution.map(bucket => [
                  bucket.label,
                  String(bucket.count),
                ])}
              />
            </div>
          )}
          {data.cycleTime.excludedWithoutStart > 0 && (
            <p className="mt-3 text-xs text-amber-300">
              {data.cycleTime.excludedWithoutStart} completed task{data.cycleTime.excludedWithoutStart === 1 ? '' : 's'} excluded because no start transition was recorded.
            </p>
          )}
          {data.cycleTime.items.length > 0 && (
            <div className="mt-4 border-t border-slate-800 pt-3">
              <p className="mb-2 text-xs font-medium text-slate-300">Longest cycle times</p>
              <ol className="space-y-2">
                {data.cycleTime.items.slice(0, 5).map(item => (
                  <li key={item.taskId} className="flex items-center justify-between gap-3 text-xs">
                    <Link className="truncate text-slate-300 hover:text-cyan-300" href={`/?taskId=${encodeURIComponent(item.taskId)}`}>
                      {item.title}
                    </Link>
                    <span className="shrink-0 tabular-nums text-slate-400">
                      {item.days}d{item.reworkCount > 0 ? ` · ${item.reworkCount} rework` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </article>

        <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="mb-4">
            <h4 className="text-sm font-semibold">Aging Work in Progress</h4>
            <p className="mt-1 text-xs text-slate-400">
              Current In progress tasks aged from their latest recorded entry into that state,
              not from task creation. Drill-through is oldest first.
            </p>
          </div>
          <dl className="mb-4 grid grid-cols-3 gap-3">
            <Metric label="Active" value={data.agingWip.count.toLocaleString()} />
            <Metric label="Median age" value={formatDays(data.agingWip.medianAgeDays)} />
            <Metric label={`Stale (${data.agingWip.staleThresholdDays}d+)`} value={data.agingWip.staleCount.toLocaleString()} />
          </dl>
          {data.agingWip.count === 0 ? (
            <EmptyChart>No active tasks have a recorded entry into their current state.</EmptyChart>
          ) : (
            <div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.agingWip.buckets} accessibilityLayer>
                  <CartesianGrid stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
                  <Tooltip
                    cursor={{ fill: 'rgba(51,65,85,0.25)' }}
                    contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8 }}
                    formatter={value => [Number(value ?? 0).toLocaleString(), 'Active tasks']}
                  />
                  <Bar dataKey="count" name="Active tasks" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <AccessibleDataTable
                caption="Active work age distribution by duration bucket"
                headers={['Age', 'Active tasks']}
                rows={data.agingWip.buckets.map(bucket => [
                  bucket.label,
                  String(bucket.count),
                ])}
              />
            </div>
          )}
          {data.agingWip.excludedWithoutEntry > 0 && (
            <p className="mt-3 text-xs text-amber-300">
              {data.agingWip.excludedWithoutEntry} active task{data.agingWip.excludedWithoutEntry === 1 ? '' : 's'} excluded because current-state entry predates recorded history.
            </p>
          )}
          {data.agingWip.items.length > 0 && (
            <div className="mt-4 max-h-48 overflow-y-auto border-t border-slate-800 pt-3">
              <ol className="space-y-2">
                {data.agingWip.items.map(item => (
                  <li key={item.taskId} className="flex items-center justify-between gap-3 text-xs">
                    <Link className="truncate text-slate-300 hover:text-amber-300" href={`/?taskId=${encodeURIComponent(item.taskId)}`}>
                      {item.title}
                    </Link>
                    <span className={item.stale ? 'shrink-0 tabular-nums text-amber-300' : 'shrink-0 tabular-nums text-slate-400'}>
                      {item.ageDays}d
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </article>
      </div>

      <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="mb-4">
          <h4 className="text-sm font-semibold">Cumulative Flow</h4>
          <p className="mt-1 text-xs text-slate-400">
            End-of-day task counts reconstructed from recorded normalized-status and project-membership transitions.
            Widening In progress bands can indicate a bottleneck.
          </p>
        </div>
        {cfdData.every(point => point.knownTasks === 0) ? (
          <EmptyChart>No recorded task state is available for this range and filter selection.</EmptyChart>
        ) : (
          <div>
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={cfdData} accessibilityLayer>
                <CartesianGrid stroke="#1e293b" vertical={false} />
                <XAxis dataKey="label" minTickGap={24} tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} width={32} />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8 }}
                  formatter={(value, name) => [Number(value ?? 0).toLocaleString(), String(name)]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="todo" name="Todo" stackId="flow" stroke={STATUS_COLORS.todo} fill={STATUS_COLORS.todo} fillOpacity={0.75} connectNulls={false} />
                <Area type="monotone" dataKey="inProgress" name="In progress" stackId="flow" stroke={STATUS_COLORS.inProgress} fill={STATUS_COLORS.inProgress} fillOpacity={0.8} connectNulls={false} />
                <Area type="monotone" dataKey="done" name="Done" stackId="flow" stroke={STATUS_COLORS.done} fill={STATUS_COLORS.done} fillOpacity={0.75} connectNulls={false} />
                <Area type="monotone" dataKey="cancelled" name="Cancelled" stackId="flow" stroke={STATUS_COLORS.cancelled} fill={STATUS_COLORS.cancelled} fillOpacity={0.65} connectNulls={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
        <AccessibleDataTable
          caption="Cumulative flow end-of-day counts by normalized task status"
          headers={['Date', 'Todo', 'In progress', 'Done', 'Cancelled', 'Coverage']}
          rows={data.cumulativeFlow.points.map(point => [
            point.date,
            point.coverage === 'unavailable' ? '-' : String(point.todo),
            point.coverage === 'unavailable' ? '-' : String(point.inProgress),
            point.coverage === 'unavailable' ? '-' : String(point.done),
            point.coverage === 'unavailable' ? '-' : String(point.cancelled),
            point.coverage,
          ])}
        />
      </article>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-950/70 px-3 py-2.5">
      <dt className="text-[0.65rem] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-slate-100">{value}</dd>
    </div>
  );
}

function AccessibleDataTable({
  caption,
  headers,
  rows,
}: {
  caption: string;
  headers: string[];
  rows: string[][];
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>{headers.map(header => <th key={header} scope="col">{header}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={`${row[0]}-${rowIndex}`}>
            {row.map((cell, cellIndex) => (
              cellIndex === 0
                ? <th key={cellIndex} scope="row">{cell}</th>
                : <td key={cellIndex}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
