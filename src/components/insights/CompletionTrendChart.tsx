'use client';

import { useId, useMemo } from 'react';
import { BarChart, Bar, CartesianGrid, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts';
import type { TrendDataPoint } from '@/lib/stats/insights';

interface Props {
  data: TrendDataPoint[];
}

function formatChartDate(date: string, weekday: boolean) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, weekday
    ? { weekday: 'short' }
    : { month: 'short', day: 'numeric' });
}

export function CompletionTrendChart({ data }: Props) {
  const titleId = useId();
  const chartData = useMemo(() => data.map(point => ({
    ...point,
    label: formatChartDate(point.date, data.length <= 7),
  })), [data]);
  const hasActivity = data.some(point => point.completed > 0 || point.created > 0);
  const tickInterval = Math.max(0, Math.ceil(data.length / 7) - 1);

  if (!hasActivity) {
    return (
      <div className="flex h-[180px] items-center justify-center text-center text-sm text-slate-500">
        No tasks created or completed in this period.
      </div>
    );
  }

  return (
    <figure aria-labelledby={titleId}>
      <figcaption id={titleId} className="sr-only">
        Daily task activity. Green bars show completed tasks and blue bars show created tasks.
      </figcaption>
      <div className="h-[180px] w-full" role="img" aria-label="Daily completed and created task chart">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            barCategoryGap={data.length > 31 ? '20%' : '28%'}
            barGap={1}
            margin={{ top: 8, right: 0, left: -24, bottom: 0 }}
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
                const point = payload?.[0]?.payload as TrendDataPoint | undefined;
                return point?.date ? formatChartDate(point.date, false) : '';
              }}
              formatter={(value, name) => [
                Number(value ?? 0).toLocaleString(),
                name === 'completed' ? 'Completed' : 'Created',
              ]}
            />
            <Bar dataKey="completed" name="completed" fill="#10b981" radius={[3, 3, 0, 0]} />
            <Bar dataKey="created" name="created" fill="#3b82f6" fillOpacity={0.55} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>Daily completed and created task counts</caption>
        <thead>
          <tr><th>Date</th><th>Completed</th><th>Created</th></tr>
        </thead>
        <tbody>
          {data.map(point => (
            <tr key={point.date}>
              <td>{point.date}</td>
              <td>{point.completed}</td>
              <td>{point.created}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
