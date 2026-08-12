'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { addInsightsReturnContext, rememberInsightsDrilldown } from '@/lib/navigation/insights';
import type { InsightsPeriod, TaskAgeBucket } from '@/lib/stats/insights';

const BUCKET_COLORS = ['text-emerald-400', 'text-blue-400', 'text-amber-400', 'text-orange-400', 'text-rose-400', 'text-red-400'];
const BAR_COLORS = ['bg-emerald-500', 'bg-blue-500', 'bg-amber-500', 'bg-orange-500', 'bg-rose-500', 'bg-red-500'];

interface Props {
  data: TaskAgeBucket[];
  period: InsightsPeriod;
}

export function TaskAgeChart({ data, period }: Props) {
  const router = useRouter();
  const maxCount = Math.max(...data.map(d => d.count), 1);
  const total = data.reduce((sum, d) => sum + d.count, 0);
  const staleCount = data.filter(b => b.minDays >= 31).reduce((sum, b) => sum + b.count, 0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const handleBucketClick = (bucket: TaskAgeBucket) => {
    const params = new URLSearchParams();
    params.set('ageMin', String(bucket.minDays));
    if (bucket.maxDays !== null) params.set('ageMax', String(bucket.maxDays));
    addInsightsReturnContext(params, period);
    const href = `/?${params.toString()}`;
    rememberInsightsDrilldown(href);
    router.push(href);
  };

  return (
    <div className="space-y-3">
      {data.map((bucket, i) => (
        <button
          type="button"
          key={bucket.label}
          className="flex w-full items-center gap-3 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-slate-800/60"
          onClick={() => handleBucketClick(bucket)}
          onMouseEnter={() => setHoveredIndex(i)}
          onMouseLeave={() => setHoveredIndex(null)}
          title={`${bucket.label}: ${bucket.count.toLocaleString()} task${bucket.count !== 1 ? 's' : ''} — Click to filter`}
        >
          <span className="text-xs text-slate-400 w-20 flex-shrink-0">{bucket.label}</span>
          <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${BAR_COLORS[i]} ${hoveredIndex === i ? 'opacity-100' : 'opacity-80'}`}
              style={{ width: `${(bucket.count / maxCount) * 100}%` }}
            />
          </div>
          <span className={`text-xs tabular-nums w-10 text-right ${BUCKET_COLORS[i]}`}>
            {bucket.count.toLocaleString()}
          </span>
        </button>
      ))}
      {staleCount > 0 && (
        <div className="text-xs text-slate-500 mt-3 pt-3 border-t border-slate-800">
          {staleCount.toLocaleString()} task{staleCount !== 1 ? 's' : ''} older than 30 days
        </div>
      )}
      {total === 0 && (
        <div className="text-sm text-slate-500 text-center py-4">No open tasks</div>
      )}
    </div>
  );
}
