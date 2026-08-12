'use client';

import Link from 'next/link';
import { useId } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DeliveryMetrics } from '@/lib/stats/insights';

interface Props {
  leadTime: DeliveryMetrics['leadTime'];
}

function formatDays(value: number | null): string {
  return value === null ? 'No data' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} days`;
}

export function LeadTimeChart({ leadTime }: Props) {
  const distributionTitleId = useId();
  const trendTitleId = useId();

  if (leadTime.summary.count === 0) {
    return (
      <div className="flex min-h-[240px] items-center justify-center text-center text-sm text-slate-500">
        No completed tasks with valid creation and completion timestamps.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Median', leadTime.summary.medianDays],
          ['Average', leadTime.summary.averageDays],
          ['P85', leadTime.summary.p85Days],
          ['P95', leadTime.summary.p95Days],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-lg bg-slate-800/70 p-3">
            <dt className="text-[0.65rem] font-medium uppercase tracking-wide text-slate-500">{label}</dt>
            <dd className="mt-1 text-sm font-semibold tabular-nums text-slate-200">
              {formatDays(value as number | null)}
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-5 xl:grid-cols-2">
        <figure aria-labelledby={distributionTitleId}>
          <figcaption id={distributionTitleId} className="mb-2 text-xs font-medium text-slate-400">
            Distribution
          </figcaption>
          <div className="h-[210px] w-full" role="img" aria-label="Lead-time distribution chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={leadTime.distribution} margin={{ top: 8, right: 8, left: -20, bottom: 0 }} accessibilityLayer>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                  formatter={value => [Number(value ?? 0).toLocaleString(), 'Tasks']}
                />
                <Bar dataKey="count" fill="#a78bfa" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <table className="sr-only">
            <caption>Lead-time distribution values</caption>
            <thead><tr><th>Duration</th><th>Tasks</th></tr></thead>
            <tbody>
              {leadTime.distribution.map(bucket => (
                <tr key={bucket.label}><td>{bucket.label}</td><td>{bucket.count}</td></tr>
              ))}
            </tbody>
          </table>
        </figure>

        <figure aria-labelledby={trendTitleId}>
          <figcaption id={trendTitleId} className="mb-2 text-xs font-medium text-slate-400">
            Trend
          </figcaption>
          <div className="h-[210px] w-full" role="img" aria-label="Lead-time trend chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={leadTime.trend} margin={{ top: 8, right: 8, left: -20, bottom: 0 }} accessibilityLayer>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis unit="d" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                  formatter={(value, name) => [
                    value === null || value === undefined ? 'No data' : `${Number(value).toLocaleString()} days`,
                    name === 'medianDays' ? 'Median' : 'P85',
                  ]}
                />
                <Line dataKey="medianDays" connectNulls={false} stroke="#a78bfa" strokeWidth={2} dot={{ r: 3 }} />
                <Line dataKey="p85Days" connectNulls={false} stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <table className="sr-only">
            <caption>Lead-time trend values</caption>
            <thead><tr><th>Interval</th><th>Median days</th><th>P85 days</th></tr></thead>
            <tbody>
              {leadTime.trend.map(point => (
                <tr key={point.start}>
                  <td>{point.start} to {point.end}</td>
                  <td>{point.medianDays ?? 'No data'}</td>
                  <td>{point.p85Days ?? 'No data'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      </div>

      {leadTime.outliers.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-slate-400">Slowest completed tasks</h4>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {leadTime.outliers.map(task => (
              <li key={task.taskId}>
                <Link
                  href={`/?taskId=${encodeURIComponent(task.taskId)}`}
                  className="flex items-center justify-between gap-3 rounded-lg bg-slate-800/60 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 hover:text-white"
                >
                  <span className="truncate">{task.title}</span>
                  <span className="shrink-0 tabular-nums text-amber-300">{formatDays(task.leadTimeDays)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
