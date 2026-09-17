'use client';

import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowDown, ArrowUp, Clock3, Target } from 'lucide-react';
import type {
  ProductivityInsights,
  ProductivityPeriodComparison,
} from '@/lib/stats/insights';
import { cn } from '@/lib/utils';

interface ProductivityPatternsProps {
  data: ProductivityInsights;
  className?: string;
}

function formatHour(hour: number): string {
  if (hour === 0) return '12a';
  if (hour === 12) return '12p';
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

function comparisonLabel(period: ProductivityPeriodComparison['period']): string {
  return period === 'week' ? 'This week' : 'This month';
}

function ComparisonRow({ comparison }: { comparison: ProductivityPeriodComparison }) {
  const change = comparison.changePercent;
  const increased = change !== null && change >= 0;
  const ChangeIcon = increased ? ArrowUp : ArrowDown;

  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-3 border-t border-slate-800 py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div>
        <div className="text-xs font-medium text-slate-300">{comparisonLabel(comparison.period)}</div>
        <div className="mt-1 text-xs text-slate-500">
          {comparison.current.tasks} tasks + {comparison.current.routines} routines
        </div>
      </div>
      <div className="text-right">
        <div className="text-lg font-semibold tabular-nums text-slate-100">
          {comparison.current.total}
        </div>
        {change === null ? (
          <div className="text-xs text-blue-300">New activity</div>
        ) : (
          <div className={cn(
            'inline-flex items-center gap-1 text-xs tabular-nums',
            increased ? 'text-emerald-400' : 'text-rose-400',
          )}>
            <ChangeIcon className="h-3 w-3" aria-hidden="true" />
            {Math.abs(change)}% vs prior
          </div>
        )}
      </div>
    </div>
  );
}

export function ProductivityPatterns({ data, className }: ProductivityPatternsProps) {
  const totalTaskCompletions = useMemo(
    () => data.hourly.reduce((sum, entry) => sum + entry.taskCompletions, 0),
    [data.hourly],
  );
  const peakHour = useMemo(
    () => data.hourly.reduce((peak, entry) => (
      entry.taskCompletions > peak.taskCompletions ? entry : peak
    ), data.hourly[0] ?? { hour: 0, taskCompletions: 0 }),
    [data.hourly],
  );
  const peakWeekday = useMemo(
    () => data.weekdays.reduce((peak, entry) => (
      entry.total > peak.total ? entry : peak
    ), data.weekdays[0] ?? {
      day: 1,
      label: 'Mon',
      taskCompletions: 0,
      routineCompletions: 0,
      total: 0,
    }),
    [data.weekdays],
  );
  const maxWeekdayTotal = Math.max(1, ...data.weekdays.map(entry => entry.total));
  const dueDatedCompletions = data.timeliness.onTime + data.timeliness.late;

  return (
    <section
      className={cn(
        'mb-6 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900',
        className,
      )}
      aria-labelledby="productivity-patterns-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div>
          <h3 id="productivity-patterns-heading" className="text-sm font-semibold text-slate-100">
            Productivity patterns
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Task and routine activity from {data.periodStart} through {data.periodEnd}
          </p>
        </div>
        <span className="rounded-md border border-slate-700 bg-slate-950/60 px-2 py-1 text-xs text-slate-400">
          {data.timeZone.replaceAll('_', ' ')}
        </span>
      </div>

      <div className="grid xl:grid-cols-[minmax(0,1.55fr)_minmax(18rem,0.85fr)]">
        <div className="border-b border-slate-800 p-5 xl:border-b-0 xl:border-r">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                <Clock3 className="h-3.5 w-3.5 text-blue-400" aria-hidden="true" />
                Time-of-day completion curve
              </h4>
              <p className="mt-1 text-xs text-slate-500">Task completions by local hour</p>
            </div>
            {totalTaskCompletions > 0 && (
              <p className="text-right text-xs text-slate-400">
                Peak at <span className="font-medium text-blue-300">{formatHour(peakHour.hour)}</span>
                <span className="ml-1 text-slate-600">({peakHour.taskCompletions})</span>
              </p>
            )}
          </div>
          {totalTaskCompletions === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-slate-500">
              Complete tasks to reveal your focus curve
            </div>
          ) : (
            <div
              className="h-40"
              role="img"
              aria-label={`Hourly task completion curve. Peak hour ${formatHour(peakHour.hour)} with ${peakHour.taskCompletions} completions.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.hourly} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                  <defs>
                    <linearGradient id="productivity-hour-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#60a5fa" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="hour"
                    axisLine={false}
                    tickLine={false}
                    ticks={[0, 6, 12, 18, 23]}
                    tickFormatter={formatHour}
                    tick={{ fontSize: 10, fill: '#8190a6' }}
                  />
                  <YAxis hide allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1e293b',
                      border: '1px solid #334155',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={value => formatHour(Number(value))}
                    formatter={value => [
                      Number(value ?? 0).toLocaleString(),
                      'Tasks completed',
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey="taskCompletions"
                    stroke="#60a5fa"
                    strokeWidth={2}
                    fill="url(#productivity-hour-fill)"
                    activeDot={{ r: 4, fill: '#bfdbfe', stroke: '#2563eb', strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="grid sm:grid-cols-2 xl:grid-cols-1">
          <div className="border-b border-slate-800 p-5 sm:border-b-0 sm:border-r xl:border-b xl:border-r-0">
            <h4 className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <Target className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              Due-date reliability
            </h4>
            {data.timeliness.onTimeRate === null ? (
              <p className="mt-5 text-sm text-slate-500">No due-dated completions in this period</p>
            ) : (
              <>
                <div className="mt-4 flex items-baseline gap-2">
                  <span className="text-3xl font-semibold tabular-nums text-emerald-400">
                    {data.timeliness.onTimeRate}%
                  </span>
                  <span className="text-xs text-slate-500">on time</span>
                </div>
                <div
                  className="mt-3 flex h-2 overflow-hidden rounded-full bg-slate-800"
                  role="img"
                  aria-label={`${data.timeliness.onTime} on-time and ${data.timeliness.late} late task completions`}
                >
                  <span
                    className="bg-emerald-500"
                    style={{ width: `${(data.timeliness.onTime / dueDatedCompletions) * 100}%` }}
                  />
                  <span className="flex-1 bg-amber-500" />
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {data.timeliness.onTime} on time · {data.timeliness.late} late
                  {data.timeliness.withoutDueDate > 0
                    ? ` · ${data.timeliness.withoutDueDate} without due dates`
                    : ''}
                </p>
              </>
            )}
          </div>
          <div className="p-5">
            <h4 className="mb-3 text-xs font-semibold text-slate-300">Momentum</h4>
            {data.comparisons.map(comparison => (
              <ComparisonRow key={comparison.period} comparison={comparison} />
            ))}
            <p className="mt-3 text-xs leading-relaxed text-slate-600">
              Compared with the same elapsed days in the prior week or month.
            </p>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-800 p-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h4 className="text-xs font-semibold text-slate-300">Day-of-week rhythm</h4>
            <p className="mt-1 text-xs text-slate-500">Tasks and routines share one activity signal</p>
          </div>
          {peakWeekday.total > 0 && (
            <p className="text-xs text-slate-400">
              Strongest day <span className="font-medium text-cyan-300">{peakWeekday.label}</span>
            </p>
          )}
        </div>
        <div className="grid grid-cols-7 gap-2" role="list" aria-label="Activity by day of week">
          {data.weekdays.map(day => {
            const taskWidth = (day.taskCompletions / maxWeekdayTotal) * 100;
            const routineWidth = (day.routineCompletions / maxWeekdayTotal) * 100;
            return (
              <div
                key={day.day}
                role="listitem"
                className="min-w-0"
                title={`${day.label}: ${day.taskCompletions} tasks, ${day.routineCompletions} routines`}
              >
                <div className="flex h-20 items-end gap-px overflow-hidden rounded-md bg-slate-950/50 px-1.5 pt-2">
                  <span
                    className="min-h-px flex-1 rounded-t-sm bg-emerald-500"
                    style={{ height: `${taskWidth}%` }}
                  />
                  <span
                    className="min-h-px flex-1 rounded-t-sm bg-violet-400"
                    style={{ height: `${routineWidth}%` }}
                  />
                </div>
                <div className="mt-2 text-center text-xs font-medium text-slate-400">{day.label}</div>
                <div className="text-center text-xs tabular-nums text-slate-600">{day.total}</div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex items-center justify-end gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-emerald-500" /> Tasks
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-violet-400" /> Routines
          </span>
        </div>
      </div>
    </section>
  );
}
