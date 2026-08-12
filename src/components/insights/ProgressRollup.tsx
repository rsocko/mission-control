'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, Crosshair, Flame, Repeat, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RollupData {
  thisWeek: { done: number; total: number };
  routinesKept: number;
  streak: number;
  focus3HitRate: { hit: number; total: number };
  dailyAvg: number;
}

export function ProgressRollup() {
  const [data, setData] = useState<RollupData | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard/kpis?slugs=this-week-progress,routines-kept,streak,focus-3,daily-avg');
      const json = await res.json();
      // The API returns { cards: KpiCardData[] }
      const cards = json.cards ?? [];
      const kpis: Record<string, { value: number; max?: number }> = {};
      for (const card of cards) {
        kpis[card.slug] = card;
      }

      setData({
        thisWeek: {
          done: kpis['this-week-progress']?.value ?? 0,
          total: kpis['this-week-progress']?.max ?? 0,
        },
        routinesKept: kpis['routines-kept']?.value ?? 0,
        streak: kpis['streak']?.value ?? 0,
        focus3HitRate: {
          hit: kpis['focus-3']?.value ?? 0,
          total: kpis['focus-3']?.max ?? 3,
        },
        dailyAvg: kpis['daily-avg']?.value ?? 0,
      } as RollupData);
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (!data) return null;

  const weekPct = data.thisWeek.total > 0 ? Math.round((data.thisWeek.done / data.thisWeek.total) * 100) : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="grid grid-cols-5 gap-3"
    >
      {/* This Week */}
      <RollupCard
        icon={<CheckCircle2 className="w-4 h-4 text-blue-600" />}
        label="This Week"
        value={`${data.thisWeek.done}/${data.thisWeek.total}`}
        sub="tasks done"
        progress={weekPct}
        progressColor="bg-blue-500"
      />

      {/* Routines */}
      <RollupCard
        icon={<Repeat className="w-4 h-4 text-green-600" />}
        label="Routines"
        value={`${data.routinesKept}%`}
        sub="kept this week"
        progress={data.routinesKept}
        progressColor="bg-green-500"
      />

      {/* Streak */}
      <RollupCard
        icon={<Flame className="w-4 h-4 text-orange-500" />}
        label="Streak"
        value={`${data.streak} days`}
        sub="showing up"
        streakDots={data.streak}
      />

      {/* Focus 3 */}
      <RollupCard
        icon={<Crosshair className="w-4 h-4 text-blue-600" />}
        label="Focus 3"
        value={`${data.focus3HitRate.hit}/${data.focus3HitRate.total}`}
        sub="today"
        focusDots={[
          ...Array(data.focus3HitRate.hit).fill(true),
          ...Array(Math.max(0, data.focus3HitRate.total - data.focus3HitRate.hit)).fill(false),
        ]}
      />

      {/* Daily Avg */}
      <RollupCard
        icon={<TrendingUp className="w-4 h-4 text-purple-600" />}
        label="Daily Avg"
        value={`${data.dailyAvg}`}
        sub="tasks/day"
      />
    </motion.div>
  );
}

function RollupCard({
  icon,
  label,
  value,
  sub,
  progress,
  progressColor,
  streakDots,
  focusDots,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  progress?: number;
  progressColor?: string;
  streakDots?: number;
  focusDots?: boolean[];
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-sm text-gray-500">{label}</p>
          <p className="text-xl font-bold tabular-nums">{value}</p>
          <p className="text-xs text-gray-500">{sub}</p>
        </div>
        {icon}
      </div>
      {progress !== undefined && (
        <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all', progressColor)}
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      )}
      {streakDots !== undefined && (
        <div className="flex gap-1">
          {Array.from({ length: 7 }, (_, i) => (
            <span
              key={i}
              className={cn(
                'w-2.5 h-2.5 rounded-full',
                i < Math.min(streakDots, 7) ? 'bg-green-500' : 'bg-gray-200',
              )}
            />
          ))}
        </div>
      )}
      {focusDots && (
        <div className="flex gap-1.5">
          {focusDots.slice(0, 3).map((done, i) => (
            <span
              key={i}
              className={cn('w-3 h-3 rounded-full', done ? 'bg-green-500' : 'bg-gray-200')}
            />
          ))}
        </div>
      )}
    </div>
  );
}
