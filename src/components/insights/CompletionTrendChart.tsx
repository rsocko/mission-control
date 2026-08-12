'use client';

import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts';
import type { TrendDataPoint, InsightsPeriod } from '@/lib/stats/insights';

interface Props {
  data: TrendDataPoint[];
  period: InsightsPeriod;
}

export function CompletionTrendChart({ data, period }: Props) {
  const chartData = useMemo(() => {
    if (period === 7) {
      return data.map(d => ({
        ...d,
        label: new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }),
      }));
    }
    // For 30/90 days, aggregate by week
    if (period >= 30) {
      const weeks: { label: string; completed: number; created: number }[] = [];
      let weekCompleted = 0;
      let weekCreated = 0;
      let weekStart = '';

      for (let i = 0; i < data.length; i++) {
        if (i % 7 === 0) {
          if (i > 0) {
            weeks.push({ label: weekStart, completed: weekCompleted, created: weekCreated });
          }
          weekStart = new Date(data[i].date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          weekCompleted = 0;
          weekCreated = 0;
        }
        weekCompleted += data[i].completed;
        weekCreated += data[i].created;
      }
      if (weekCompleted > 0 || weekCreated > 0) {
        weeks.push({ label: weekStart, completed: weekCompleted, created: weekCreated });
      }
      return weeks;
    }
    return data.map(d => ({ ...d, label: d.date.slice(5) }));
  }, [data, period]);

  if (chartData.length === 0) {
    return <div className="h-[140px] flex items-center justify-center text-sm text-slate-500">No data yet</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={140}>
      <BarChart data={chartData} barGap={2}>
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: '#64748b' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis hide />
        <Tooltip
          contentStyle={{
            backgroundColor: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: '#94a3b8' }}
          formatter={(value, name) => [
            Number(value ?? 0).toLocaleString(),
            name === 'completed' ? 'Completed' : 'Created',
          ]}
        />
        <Bar dataKey="completed" fill="#10b981" radius={[3, 3, 0, 0]} />
        <Bar dataKey="created" fill="rgba(59,130,246,0.4)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
