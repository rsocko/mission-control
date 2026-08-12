'use client';

import { useId } from 'react';
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
import type { DeliveryMetrics } from '@/lib/stats/insights';

interface Props {
  throughput: DeliveryMetrics['throughput'];
}

export function DeliveryTrendChart({ throughput }: Props) {
  const titleId = useId();
  const hasCompletions = throughput.points.some(point => point.count > 0);

  if (!hasCompletions) {
    return (
      <div className="flex h-[240px] items-center justify-center text-center text-sm text-slate-500">
        Zero completed tasks in this period.
      </div>
    );
  }

  return (
    <figure aria-labelledby={titleId}>
      <figcaption id={titleId} className="sr-only">
        Throughput and velocity trend. Bars show completed task count per {throughput.interval};
        the line shows the rolling three-interval rate normalized for partial intervals.
      </figcaption>
      <div className="h-[240px] w-full" role="img" aria-label="Throughput and velocity chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={throughput.points} margin={{ top: 8, right: 8, left: -20, bottom: 0 }} accessibilityLayer>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: '#94a3b8' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 10, fill: '#64748b' }}
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
              labelFormatter={(label, payload) => {
                const point = payload?.[0]?.payload as { start?: string; end?: string; isPartial?: boolean } | undefined;
                if (!point?.start || !point.end) return String(label);
                return `${point.start} to ${point.end}${point.isPartial ? ' (partial)' : ''}`;
              }}
              formatter={(value, name) => [
                Number(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 }),
                name === 'count' ? 'Throughput' : 'Normalized 3-interval velocity',
              ]}
            />
            <Bar dataKey="count" name="count" fill="#10b981" radius={[4, 4, 0, 0]} />
            <Line
              dataKey="rollingAverage"
              name="rollingAverage"
              type="monotone"
              stroke="#60a5fa"
              strokeWidth={2}
              dot={{ r: 3, fill: '#60a5fa' }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>Throughput and normalized rolling velocity values</caption>
        <thead>
          <tr><th>Interval</th><th>Completed</th><th>Rolling average</th></tr>
        </thead>
        <tbody>
          {throughput.points.map(point => (
            <tr key={point.start}>
              <td>{point.start} to {point.end}{point.isPartial ? ', partial' : ''}</td>
              <td>{point.count}</td>
              <td>{point.rollingAverage}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
