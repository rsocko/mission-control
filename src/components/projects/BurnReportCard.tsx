'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, ChartNoAxesCombined, Info, LoaderCircle, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type {
  BurnReport,
  BurnReportMode,
} from '@/lib/reports/burn-types';
import { getLocalToday } from '@/lib/utils/client-date';

type ReportView = 'burnup' | 'burndown' | 'status';
type RangePreset = '30' | '90' | 'all' | 'custom';
type DrillKind = 'all' | 'completed' | 'remaining' | 'todo' | 'inProgress' | 'cancelled';
const MAX_REPORT_DAYS = 1_830;

interface BurnReportCardProps {
  projectId: string;
  phaseId?: string;
  scopeName: string;
  refreshKey?: string | number;
  embedded?: boolean;
  onTaskSelect: (taskId: string) => void;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function formatDate(value: string, includeYear = false): string {
  return new Date(`${value}T12:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' as const } : {}),
  });
}

function formatMetric(value: number, mode: BurnReportMode): string {
  return mode === 'count'
    ? Math.round(value).toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function rangeStart(preset: RangePreset, today: string): string {
  if (preset === '30') return addUtcDays(today, -29);
  if (preset === '90') return addUtcDays(today, -89);
  return addUtcDays(today, -(MAX_REPORT_DAYS - 1));
}

function dayCount(start: string, end: string): number {
  return Math.round(
    (new Date(`${end}T00:00:00.000Z`).getTime()
      - new Date(`${start}T00:00:00.000Z`).getTime()) / 86_400_000,
  ) + 1;
}

function ReportToggle<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean; title?: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="inline-flex rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-0)] p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            'min-h-8 rounded-[calc(var(--radius-md)-2px)] px-2.5 text-xs font-medium transition-colors',
            value === option.value
              ? 'bg-[var(--surface-2)] text-[var(--text-primary)] shadow-sm'
              : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]',
            option.disabled && 'cursor-not-allowed opacity-45',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function BurnReportCard({
  projectId,
  phaseId,
  scopeName,
  refreshKey = 0,
  embedded = false,
  onTaskSelect,
}: BurnReportCardProps) {
  const titleId = useId();
  const descriptionId = useId();
  const today = useMemo(() => getLocalToday(), []);
  const [view, setView] = useState<ReportView>('burnup');
  const [mode, setMode] = useState<BurnReportMode>('count');
  const [lastBurnMode, setLastBurnMode] = useState<BurnReportMode>('count');
  const projectStart = useMemo(() => rangeStart('all', today), [today]);
  const [preset, setPreset] = useState<RangePreset>('all');
  const [customStart, setCustomStart] = useState(projectStart);
  const [customEnd, setCustomEnd] = useState(today);
  const [appliedCustomRange, setAppliedCustomRange] = useState({
    start: projectStart,
    end: today,
  });
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [report, setReport] = useState<BurnReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [drillKind, setDrillKind] = useState<DrillKind | null>(null);
  const requestStart = preset === 'custom'
    ? appliedCustomRange.start
    : rangeStart(preset, today);
  const requestEnd = preset === 'custom' ? appliedCustomRange.end : today;

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      mode,
      start: requestStart,
      end: requestEnd,
    });
    if (phaseId) params.set('phase_id', phaseId);

    fetch(`/api/projects/${projectId}/reports/burn?${params}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          report?: BurnReport;
          error?: string;
        } | null;
        if (!response.ok || !payload?.report) {
          throw new Error(payload?.error || 'Failed to load progress report');
        }
        setError(null);
        setReport(payload.report);
      })
      .catch((caughtError: unknown) => {
        if (caughtError instanceof DOMException && caughtError.name === 'AbortError') return;
        setError(caughtError instanceof Error ? caughtError.message : 'Failed to load progress report');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [mode, phaseId, projectId, refreshKey, requestEnd, requestStart, retryToken]);

  const actualPoints = report?.points.filter((point) => point.total !== null) ?? [];
  const latestPoint = actualPoints.at(-1) ?? null;
  const hasHistoricalScope = actualPoints.some((point) => (
    (point.total ?? 0) > 0 || (point.cancelled ?? 0) > 0
  ));
  const taskMap = new Map(report?.tasks.map((task) => [task.id, task.title]) ?? []);
  const selectedTaskIds = latestPoint && drillKind
    ? drillKind === 'completed'
      ? latestPoint.completedTaskIds
      : drillKind === 'remaining'
        ? latestPoint.remainingTaskIds
        : drillKind === 'todo'
          ? latestPoint.statusTaskIds.todo
          : drillKind === 'inProgress'
            ? latestPoint.statusTaskIds.inProgress
            : drillKind === 'cancelled'
              ? latestPoint.statusTaskIds.cancelled
        : [...latestPoint.completedTaskIds, ...latestPoint.remainingTaskIds].sort()
    : [];
  const firstObservedIndex = report?.points.findIndex((point) => (
    point.total !== null
    && (
      point.total > 0
      || (point.cancelled ?? 0) > 0
    )
  )) ?? -1;
  const completeHistoryIndex = report?.completeFromDate
    ? report.points.findIndex((point) => point.date === report.completeFromDate)
    : -1;
  const firstIdealPointIndex = report?.ideal.available
    ? report.points.findIndex((point) => (
        point.idealCompleted !== null || point.idealRemaining !== null
      ))
    : -1;
  const displayAnchorIndexes = [firstObservedIndex, completeHistoryIndex, firstIdealPointIndex]
    .filter((index) => index >= 0);
  const firstDisplayedIndex = preset === 'all' && displayAnchorIndexes.length > 0
    ? Math.min(...displayAnchorIndexes)
    : 0;
  const displayedPoints = report && firstDisplayedIndex > 0
    ? report.points.slice(firstDisplayedIndex)
    : report?.points ?? [];
  const spansMultipleYears = report
    ? report.range.start.slice(0, 4) !== report.range.end.slice(0, 4)
    : false;
  const chartData = displayedPoints.map((point) => ({
    ...point,
    label: formatDate(point.date, spansMultipleYears),
  })) ?? [];
  const primaryKey = view === 'burnup' ? 'completed' : 'remaining';
  const idealKey = view === 'burnup' ? 'idealCompleted' : 'idealRemaining';
  const primaryLabel = view === 'burnup' ? 'Completed' : 'Remaining';
  const scopeLabel = phaseId ? 'Phase' : 'Project';
  const hasIncompleteHistoricalEffort = mode === 'effort'
    && report?.points.some((point) => point.total !== null && point.estimateIncomplete);

  const content = (
    <>
      <CardHeader className={cn('gap-4', embedded && 'p-4')}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ChartNoAxesCombined className="h-4 w-4 text-[var(--accent-400)]" aria-hidden="true" />
              <CardTitle id={titleId}>
                {phaseId ? `${scopeName} progress report` : 'Progress reports'}
              </CardTitle>
            </div>
            <CardDescription id={descriptionId}>
              Daily scope and completion reconstructed from task lifecycle and project history.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <ReportToggle
              label="Report type"
              value={view}
              options={[
                { value: 'burnup', label: 'Burnup' },
                { value: 'burndown', label: 'Burndown' },
                { value: 'status', label: 'Status' },
              ]}
              onChange={(nextView) => {
                setView(nextView);
                if (nextView === 'status' && mode === 'effort') {
                  setMode('count');
                  setLoading(true);
                } else if (view === 'status' && nextView !== 'status' && mode !== lastBurnMode) {
                  setMode(lastBurnMode);
                  setLoading(true);
                }
              }}
            />
            <ReportToggle
              label="Report unit"
              value={mode}
              options={[
                { value: 'count', label: 'Task count' },
                {
                  value: 'effort',
                  label: 'Effort',
                  disabled: view === 'status',
                  title: view === 'status'
                    ? 'Status flow is reported by task count.'
                    : report && !report.effort.available
                      ? report.effort.message ?? undefined
                      : undefined,
                },
              ]}
              onChange={(nextMode) => {
                if (nextMode === mode) return;
                setLastBurnMode(nextMode);
                setMode(nextMode);
                setLoading(true);
              }}
            />
            <ReportToggle
              label="Date range"
              value={preset}
              options={[
                { value: '30', label: '30d' },
                { value: '90', label: '90d' },
                { value: 'all', label: scopeLabel },
                { value: 'custom', label: 'Custom' },
              ]}
              onChange={(nextPreset) => {
                const nextStart = nextPreset === 'custom'
                  ? appliedCustomRange.start
                  : rangeStart(nextPreset, today);
                const nextEnd = nextPreset === 'custom' ? appliedCustomRange.end : today;
                if (nextStart !== requestStart || nextEnd !== requestEnd) setLoading(true);
                setPreset(nextPreset);
              }}
            />
          </div>
        </div>
        {preset === 'custom' ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (customStart > customEnd) {
                setRangeError('Start date must be on or before end date.');
                return;
              }
              if (dayCount(customStart, customEnd) > MAX_REPORT_DAYS) {
                setRangeError('Custom ranges can include up to 5 years.');
                return;
              }
              setRangeError(null);
              if (customStart !== requestStart || customEnd !== requestEnd) setLoading(true);
              setAppliedCustomRange({ start: customStart, end: customEnd });
            }}
          >
            <label className="grid gap-1 text-xs text-[var(--text-tertiary)]">
              Start
              <input
                type="date"
                value={customStart}
                max={customEnd}
                onChange={(event) => setCustomStart(event.target.value)}
                className="h-8 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-0)] px-2 text-xs text-[var(--text-primary)]"
                required
              />
            </label>
            <label className="grid gap-1 text-xs text-[var(--text-tertiary)]">
              End
              <input
                type="date"
                value={customEnd}
                min={customStart}
                max={today}
                onChange={(event) => setCustomEnd(event.target.value)}
                className="h-8 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-0)] px-2 text-xs text-[var(--text-primary)]"
                required
              />
            </label>
            <Button type="submit" variant="outline" size="sm">Apply</Button>
            {rangeError ? <p className="text-xs text-[var(--danger)]" role="alert">{rangeError}</p> : null}
          </form>
        ) : null}
      </CardHeader>
      <CardContent className={cn('space-y-4', embedded && 'p-4 pt-0')}>
        {loading ? (
          <div className="flex h-72 items-center justify-center text-sm text-[var(--text-tertiary)]" role="status">
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            Loading progress report
          </div>
        ) : error ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-[var(--danger)]/40 p-6 text-center" role="alert">
            <p className="text-sm text-[var(--text-secondary)]">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setError(null);
                setLoading(true);
                setRetryToken((value) => value + 1);
              }}
            >
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : report && !hasHistoricalScope && !report.partialHistory ? (
          <div className="flex min-h-48 flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] p-6 text-center">
            <ChartNoAxesCombined className="mb-3 h-7 w-7 text-[var(--text-tertiary)]" aria-hidden="true" />
            <p className="text-sm font-medium text-[var(--text-primary)]">No scoped work to chart yet</p>
            <p className="mt-1 max-w-md text-sm text-[var(--text-tertiary)]">
              Add tasks to this {phaseId ? 'phase' : 'project'} to begin tracking scope and completion.
            </p>
          </div>
        ) : report && mode === 'effort' && !report.effort.available ? (
          <div className="flex min-h-48 flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-amber-500/40 p-6 text-center" role="status">
            <AlertTriangle className="mb-3 h-6 w-6 text-amber-400" aria-hidden="true" />
            <p className="text-sm font-medium text-[var(--text-primary)]">Effort report unavailable</p>
            <p className="mt-1 max-w-lg text-sm text-[var(--text-tertiary)]">{report.effort.message}</p>
            <Button
              className="mt-4"
              variant="outline"
              size="sm"
              onClick={() => {
                setLastBurnMode('count');
                setMode('count');
                setLoading(true);
              }}
            >
              Show task count
            </Button>
          </div>
        ) : report ? (
          <>
            {report.partialHistory ? (
              <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-[var(--text-secondary)]" role="status">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
                <span>
                  Earlier values are hidden because task history is only complete from{' '}
                  {report.completeFromDate
                    ? formatDate(report.completeFromDate, spansMultipleYears)
                    : 'the observed boundary'}.
                </span>
              </div>
            ) : null}
            {report.effort.message ? (
              <div className={cn(
                'flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-xs text-[var(--text-secondary)]',
                report.effort.available
                  ? 'border-sky-500/25 bg-sky-500/5'
                  : 'border-amber-500/30 bg-amber-500/5',
              )} role="status">
                {report.effort.available ? (
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
                )}
                <span>{report.effort.message}</span>
              </div>
            ) : null}
            {hasIncompleteHistoricalEffort && !report.effort.message ? (
              <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-xs text-[var(--text-secondary)]" role="status">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" aria-hidden="true" />
                <span>Some historical points include only tasks that had effort estimates on that date.</span>
              </div>
            ) : null}
            <div
              className="h-64 w-full sm:h-72"
              role="img"
              aria-labelledby={titleId}
              aria-describedby={descriptionId}
            >
              <ResponsiveContainer width="100%" height="100%">
                {view === 'status' ? (
                  <AreaChart
                    data={chartData}
                    margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
                    accessibilityLayer
                  >
                    <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="label"
                      minTickGap={28}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={{ stroke: 'var(--border)' }}
                      tickLine={false}
                    />
                    <YAxis
                      width={42}
                      allowDecimals={mode === 'effort'}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <ChartTooltip
                      contentStyle={{
                        backgroundColor: 'var(--surface-2)',
                        border: '1px solid var(--border-strong)',
                        borderRadius: 10,
                        fontSize: 12,
                      }}
                      labelStyle={{ color: 'var(--text-secondary)' }}
                      formatter={(value, name) => [formatMetric(Number(value ?? 0), mode), String(name)]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="cancelled" name="Cancelled" stackId="status" stroke="#fb7185" fill="#fb7185" fillOpacity={0.55} connectNulls={false} isAnimationActive={false} />
                    <Area type="monotone" dataKey="completed" name="Done" stackId="status" stroke="#34d399" fill="#34d399" fillOpacity={0.65} connectNulls={false} isAnimationActive={false} />
                    <Area type="monotone" dataKey="inProgress" name="In progress" stackId="status" stroke="#c084fc" fill="#c084fc" fillOpacity={0.7} connectNulls={false} isAnimationActive={false} />
                    <Area type="monotone" dataKey="todo" name="To do" stackId="status" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.65} connectNulls={false} isAnimationActive={false} />
                  </AreaChart>
                ) : (
                <LineChart
                  data={chartData}
                  margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
                  accessibilityLayer
                >
                  <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="label"
                    minTickGap={28}
                    tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={false}
                  />
                  <YAxis
                    width={42}
                    allowDecimals={mode === 'effort'}
                    tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <ChartTooltip
                    contentStyle={{
                      backgroundColor: 'var(--surface-2)',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 10,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: 'var(--text-secondary)' }}
                    formatter={(value, name) => [
                      formatMetric(Number(value ?? 0), mode),
                      name === primaryLabel || name === 'Total scope' ? name : 'Ideal',
                    ]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {report.completeFromDate && displayedPoints.some((point) => point.date === report.completeFromDate) ? (
                    <ReferenceLine
                      x={formatDate(report.completeFromDate, spansMultipleYears)}
                      stroke="#f59e0b"
                      strokeDasharray="4 4"
                      label={{ value: 'Complete history', fill: '#f59e0b', fontSize: 10 }}
                    />
                  ) : null}
                  {view === 'burnup' ? (
                    <Line
                      type="monotone"
                      dataKey="total"
                      name="Total scope"
                      stroke="#60a5fa"
                      strokeWidth={2}
                      dot={false}
                      connectNulls={false}
                    />
                  ) : null}
                  <Line
                    type="monotone"
                    dataKey={primaryKey}
                    name={primaryLabel}
                    stroke={view === 'burnup' ? '#34d399' : '#f59e0b'}
                    strokeWidth={2.5}
                    dot={false}
                    connectNulls={false}
                  />
                  {report.ideal.available ? (
                    <Line
                      type="linear"
                      dataKey={idealKey}
                      name="Ideal"
                      stroke="#94a3b8"
                      strokeWidth={1.5}
                      strokeDasharray="6 5"
                      dot={false}
                      connectNulls={false}
                    />
                  ) : null}
                </LineChart>
                )}
              </ResponsiveContainer>
            </div>
            <div className="flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-[var(--text-tertiary)]">
                {latestPoint ? (
                  view === 'status' ? (
                    <>
                      As of {formatDate(latestPoint.date)}:{' '}
                      <span className="font-medium text-[var(--text-primary)]">
                        {Object.values(latestPoint.statusTaskIds).flat().length} tracked{' '}
                        {Object.values(latestPoint.statusTaskIds).flat().length === 1 ? 'task' : 'tasks'}
                      </span>
                      {' — '}
                      {latestPoint.statusTaskIds.todo.length} to do,{' '}
                      {latestPoint.statusTaskIds.inProgress.length} in progress,{' '}
                      {latestPoint.statusTaskIds.done.length} done,{' '}
                      {latestPoint.statusTaskIds.cancelled.length} cancelled
                    </>
                  ) : (
                    <>
                      As of {formatDate(latestPoint.date)}:{' '}
                      <span className="font-medium text-[var(--text-primary)]">
                        {formatMetric(latestPoint.completed ?? 0, mode)} completed
                      </span>
                      {' of '}
                      {formatMetric(latestPoint.total ?? 0, mode)} {report.unitLabel}
                    </>
                  )
                ) : null}
              </div>
              {latestPoint ? (
                <div className="flex flex-wrap gap-2">
                  {view === 'burnup' ? (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setDrillKind('all')}>
                        Scope ({latestPoint.completedTaskIds.length + latestPoint.remainingTaskIds.length})
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setDrillKind('completed')}>
                        Completed ({latestPoint.completedTaskIds.length})
                      </Button>
                    </>
                  ) : view === 'burndown' ? (
                    <Button variant="outline" size="sm" onClick={() => setDrillKind('remaining')}>
                      Remaining ({latestPoint.remainingTaskIds.length})
                    </Button>
                  ) : (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setDrillKind('todo')}>
                        To do ({latestPoint.statusTaskIds.todo.length})
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setDrillKind('inProgress')}>
                        In progress ({latestPoint.statusTaskIds.inProgress.length})
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setDrillKind('completed')}>
                        Done ({latestPoint.statusTaskIds.done.length})
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setDrillKind('cancelled')}>
                        Cancelled ({latestPoint.statusTaskIds.cancelled.length})
                      </Button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
            {view === 'status' ? (
              <details className="text-xs text-[var(--text-tertiary)]">
                <summary className="cursor-pointer select-none font-medium text-[var(--text-secondary)]">
                  Status history data
                </summary>
                <div className="mt-2 max-h-64 overflow-auto rounded-[var(--radius-md)] border border-[var(--border)]">
                  <table className="w-full border-collapse text-left">
                    <caption className="sr-only">End-of-day task counts by status</caption>
                    <thead className="sticky top-0 bg-[var(--surface-1)] text-[var(--text-secondary)]">
                      <tr>
                        {['Date', 'To do', 'In progress', 'Done', 'Cancelled'].map((heading) => (
                          <th
                            key={heading}
                            scope="col"
                            className="border-b border-[var(--border)] px-3 py-2 font-medium"
                          >
                            {heading}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayedPoints.map((point) => (
                        <tr key={point.date}>
                          <th scope="row" className="border-b border-[var(--border-subtle)] px-3 py-2 font-normal">
                            {point.date}
                          </th>
                          {[point.todo, point.inProgress, point.completed, point.cancelled].map((value, index) => (
                            <td key={index} className="border-b border-[var(--border-subtle)] px-3 py-2">
                              {value === null ? '—' : formatMetric(value, mode)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}
            {drillKind && latestPoint ? (
              <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-0)] p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium capitalize text-[var(--text-primary)]">
                      {drillKind === 'inProgress' ? 'In progress' : drillKind} tasks
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                      Snapshot as of {formatDate(latestPoint.date)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setDrillKind(null)}
                      className="min-h-8 px-2 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                      Close
                    </button>
                  </div>
                </div>
                {selectedTaskIds.length === 0 ? (
                  <p className="mt-3 text-sm text-[var(--text-tertiary)]">No tasks in this snapshot.</p>
                ) : (
                  <div className="mt-3 max-h-48 space-y-1 overflow-y-auto">
                    {selectedTaskIds.map((taskId) => (
                      <button
                        key={taskId}
                        type="button"
                        onClick={() => onTaskSelect(taskId)}
                        className="flex min-h-9 w-full items-center rounded-[var(--radius-sm)] px-3 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                      >
                        {taskMap.get(taskId) ?? `Task ${taskId}`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
            <details className="text-xs text-[var(--text-tertiary)]">
              <summary className="cursor-pointer select-none font-medium text-[var(--text-secondary)]">
                How this report is calculated
              </summary>
              <p className="mt-2 max-w-3xl leading-5">
                Burnup compares completed work with total scope. Burndown shows work still remaining.
                Status shows end-of-day task counts by workflow state, including cancelled work.
                Initial project scope begins on each task&apos;s creation date. Known completion dates
                are reflected when available; later removals, re-additions, reopened tasks, recompletion,
                and effort changes are applied when observed. Ideal lines appear only when both schedule
                dates are available.
              </p>
              {!report.ideal.available && report.ideal.message ? (
                <p className="mt-1">{report.ideal.message}</p>
              ) : null}
            </details>
          </>
        ) : null}
      </CardContent>
    </>
  );

  if (embedded) {
    return (
      <section
        className="border-t border-[var(--border)] bg-[var(--surface-1)]/70"
        aria-label={`${scopeName} progress report`}
      >
        {content}
      </section>
    );
  }

  return <Card>{content}</Card>;
}
