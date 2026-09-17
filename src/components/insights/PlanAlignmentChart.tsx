'use client';

import { useId, useMemo } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PlanAlignmentInsights } from '@/lib/stats/insights';

interface Props {
  data: PlanAlignmentInsights;
}

function formatChartDate(date: string, weekday: boolean) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, weekday
    ? { weekday: 'short' }
    : { month: 'short', day: 'numeric' });
}

export function PlanAlignmentChart({ data }: Props) {
  const titleId = useId();
  const chartData = useMemo(() => data.points.map(point => ({
    ...point,
    label: formatChartDate(point.date, data.points.length <= 7),
  })), [data.points]);
  const hasActivity = data.totals.committed > 0
    || data.totals.plannedCompleted > 0
    || data.totals.unplannedCompleted > 0;
  const tickInterval = Math.max(0, Math.ceil(data.points.length / 7) - 1);

  return (
    <section aria-labelledby={titleId}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 id={titleId} className="text-sm font-semibold">Plan Alignment</h3>
          <p className="mt-1 text-xs text-slate-500">
            Completions count as planned only when explicitly committed to My Day at completion.
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
          <div>
            <dt className="text-slate-500">Plan coverage</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-emerald-400">{data.planCoverage}%</dd>
          </div>
          <div>
            <dt className="text-slate-500">Commitment rate</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-blue-400">{data.commitmentRate}%</dd>
          </div>
          <div>
            <dt className="text-slate-500">Unplanned done</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-amber-400">
              {data.totals.unplannedCompleted.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Carryovers</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-slate-300">
              {data.totals.carryover.toLocaleString()}
            </dd>
          </div>
        </dl>
      </div>

      {!hasActivity ? (
        <div className="flex h-[200px] items-center justify-center text-center text-sm text-slate-500">
          No My Day commitments or task completions in this period.
        </div>
      ) : (
        <figure>
          <figcaption className="sr-only">
            Daily plan alignment. Bars compare My Day commitments with planned and unplanned
            completions. The line shows commitments left open at day end.
          </figcaption>
          <div
            className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-300"
            role="group"
            aria-label="Chart legend"
          >
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-blue-500/55" /> Explicitly committed
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" /> Planned done
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-500" /> Unplanned done
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3 bg-slate-300" /> Carryover
            </span>
          </div>
          <div
            className="h-[220px] w-full"
            role="img"
            aria-label="Daily plan alignment chart"
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={chartData}
                barCategoryGap={data.points.length > 31 ? '18%' : '26%'}
                barGap={1}
                margin={{ top: 8, right: 4, left: -24, bottom: 0 }}
              >
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  interval={tickInterval}
                  minTickGap={12}
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: '#8190a6' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: '#94a3b8' }}
                  labelFormatter={(_label, payload) => {
                    const point = payload?.[0]?.payload as { date?: string } | undefined;
                    return point?.date ? formatChartDate(point.date, false) : '';
                  }}
                  formatter={(value, name) => [
                    Number(value ?? 0).toLocaleString(),
                    name === 'committed'
                      ? 'Explicitly committed'
                      : name === 'plannedCompleted'
                        ? 'Planned done'
                        : name === 'unplannedCompleted'
                          ? 'Unplanned done'
                          : 'Carryover',
                  ]}
                />
                <Bar dataKey="committed" name="committed" fill="#3b82f6" fillOpacity={0.55} radius={[3, 3, 0, 0]} />
                <Bar dataKey="plannedCompleted" name="plannedCompleted" fill="#10b981" radius={[3, 3, 0, 0]} />
                <Bar dataKey="unplannedCompleted" name="unplannedCompleted" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                <Line
                  dataKey="carryover"
                  name="carryover"
                  type="monotone"
                  stroke="#cbd5e1"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <table className="sr-only">
            <caption>Daily My Day commitments, completions, and carryover</caption>
            <thead>
              <tr>
                <th>Date</th>
                <th>Explicitly committed</th>
                <th>Planned completed</th>
                <th>Unplanned completed</th>
                <th>Carryover</th>
              </tr>
            </thead>
            <tbody>
              {data.points.map(point => (
                <tr key={point.date}>
                  <td>{point.date}</td>
                  <td>{point.committed}</td>
                  <td>{point.plannedCompleted}</td>
                  <td>{point.unplannedCompleted}</td>
                  <td>{point.carryover}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      )}
    </section>
  );
}
