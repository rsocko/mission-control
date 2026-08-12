'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Brain,
  Lightbulb,
  Loader2,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { PullToRefreshIndicator } from '@/components/ui/PullToRefreshIndicator';
import { ActivityHeatmap } from '@/components/insights/ActivityHeatmap';
import { usePullToRefresh } from '@/lib/hooks/usePullToRefresh';
import { fadeSlideUp, staggerContainer } from '@/lib/motion';
import type { InsightsPeriod, InsightsSnapshot, PeriodKpi, TrendDataPoint } from '@/lib/stats/insights';
import { cn } from '@/lib/utils';

export interface MobileInsightsScreenProps {
  onBack: () => void;
}

interface ObservationsResponse {
  observations?: ApiObservation[];
  generatedAt?: string;
}

interface ApiObservation {
  id?: string;
  type: string;
  title: string;
  body?: string;
  description?: string;
  sentiment?: 'positive' | 'neutral' | 'warning';
  severity?: 'positive' | 'info' | 'warning';
  confidence?: number;
}

interface InsightObservation {
  id: string;
  type: string;
  title: string;
  body: string;
  sentiment: 'positive' | 'neutral' | 'warning';
  confidence?: number;
}

interface RecommendationItem {
  id: string;
  text: string;
  trend: 'up' | 'down' | 'neutral';
}

interface TrendBarPoint {
  id: string;
  label: string;
  value: number;
}

const PERIOD_OPTIONS: ReadonlyArray<{ label: string; value: InsightsPeriod; rangeLabel: string; comparisonLabel: string }> = [
  { label: 'Week', value: 7, rangeLabel: 'this week', comparisonLabel: 'last week' },
  { label: 'Month', value: 30, rangeLabel: 'this month', comparisonLabel: 'last month' },
  { label: 'Quarter', value: 90, rangeLabel: 'this quarter', comparisonLabel: 'last quarter' },
];

const GLASS_STYLE: React.CSSProperties = {
  background: 'rgba(15, 23, 42, 0.68)',
  border: '1px solid rgba(148, 163, 184, 0.14)',
  boxShadow: '0 18px 40px rgba(2, 6, 23, 0.3)',
  backdropFilter: 'blur(18px)',
  WebkitBackdropFilter: 'blur(18px)',
};

const CHIP_STYLE: React.CSSProperties = {
  border: '1px solid rgba(148, 163, 184, 0.14)',
  background: 'rgba(30, 41, 59, 0.58)',
};

const WEEKDAY_ORDER = [
  { day: 1, label: 'M' },
  { day: 2, label: 'T' },
  { day: 3, label: 'W' },
  { day: 4, label: 'T' },
  { day: 5, label: 'F' },
  { day: 6, label: 'S' },
  { day: 0, label: 'S' },
] as const;

function normalizeObservation(observation: ApiObservation, index: number): InsightObservation {
  const sentiment = observation.sentiment ?? (
    observation.severity === 'positive'
      ? 'positive'
      : observation.severity === 'warning'
        ? 'warning'
        : 'neutral'
  );

  return {
    id: observation.id ?? `${observation.type}-${index}`,
    type: observation.type,
    title: observation.title,
    body: observation.body ?? observation.description ?? '',
    sentiment,
    confidence: observation.confidence,
  };
}

function isInsightDataEmpty(snapshot: InsightsSnapshot | null, observations: InsightObservation[]) {
  if (!snapshot) return false;

  const totalKpiValue = Object.values(snapshot.kpis).reduce((sum, kpi) => sum + Math.abs(kpi.value), 0);
  const totalTrendValue = snapshot.trends.reduce((sum, point) => sum + point.completed + point.created, 0);
  const totalActivity = snapshot.activityHeatmap.reduce(
    (sum, point) => sum + point.taskCompletions + point.routineCompletions,
    0,
  );

  return totalKpiValue === 0 && totalTrendValue === 0 && totalActivity === 0 && observations.length === 0;
}

function aggregateTrendData(trends: TrendDataPoint[], period: InsightsPeriod): TrendBarPoint[] {
  const recent = period === 7 ? trends.slice(-7) : trends;

  if (period === 7) {
    const valuesByDay = new Map<number, number>();

    recent.forEach((point) => {
      const day = new Date(`${point.date}T12:00:00`).getDay();
      valuesByDay.set(day, (valuesByDay.get(day) ?? 0) + point.completed);
    });

    return WEEKDAY_ORDER.map(({ day, label }) => ({
      id: `weekday-${day}`,
      label,
      value: valuesByDay.get(day) ?? 0,
    }));
  }

  const buckets: TrendBarPoint[] = [];
  for (let index = 0; index < recent.length; index += 7) {
    const slice = recent.slice(index, index + 7);
    if (!slice.length) continue;
    buckets.push({
      id: `week-${buckets.length + 1}`,
      label: `W${buckets.length + 1}`,
      value: slice.reduce((sum, point) => sum + point.completed, 0),
    });
  }

  return buckets;
}

function getPeriodMeta(period: InsightsPeriod) {
  return PERIOD_OPTIONS.find((option) => option.value === period) ?? PERIOD_OPTIONS[0];
}

function formatNumber(value: number, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat('en-US', options).format(value);
}

function formatDecimal(value: number) {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}

function formatGridValue(key: keyof InsightsSnapshot['kpis'], kpi: PeriodKpi) {
  if (key === 'avgTaskAge') return `${formatDecimal(kpi.value)}d`;
  if (key === 'netChange' && kpi.value > 0) return `+${formatNumber(kpi.value)}`;
  return formatNumber(kpi.value);
}

function getObservationAccent(sentiment: InsightObservation['sentiment']) {
  if (sentiment === 'positive') return 'bg-emerald-400';
  if (sentiment === 'warning') return 'bg-rose-400';
  return 'bg-amber-400';
}

function buildRecommendations(snapshot: InsightsSnapshot | null, observations: InsightObservation[]): RecommendationItem[] {
  if (!snapshot) return [];

  const items: RecommendationItem[] = [];

  if (snapshot.kpis.netChange.value > 0) {
    items.push({
      id: 'backlog-intake',
      text: 'New work is outpacing completions. Trim intake or close one stale task next.',
      trend: 'down',
    });
  }

  if (snapshot.kpis.avgTaskAge.value > 7) {
    items.push({
      id: 'task-age',
      text: 'Average task age is climbing. Re-triage aging work and split anything blocked.',
      trend: 'down',
    });
  }

  if ((snapshot.kpis.completed.delta ?? 0) < 0) {
    items.push({
      id: 'focus-recovery',
      text: 'Completion pace dipped versus the prior period. Protect a single uninterrupted focus block.',
      trend: 'down',
    });
  }

  if (snapshot.kpis.streak.value >= 3) {
    items.push({
      id: 'streak-protect',
      text: 'You have momentum. Start tomorrow with one fast win to keep the streak alive.',
      trend: 'up',
    });
  }

  observations
    .filter((observation) => observation.sentiment !== 'positive')
    .slice(0, 2)
    .forEach((observation) => {
      items.push({
        id: `observation-${observation.id}`,
        text: observation.body || observation.title,
        trend: observation.sentiment === 'warning' ? 'down' : 'neutral',
      });
    });

  return items.filter((item, index, array) => array.findIndex((candidate) => candidate.text === item.text) === index).slice(0, 4);
}

function InsightSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="rounded-[22px] p-5" style={GLASS_STYLE}>
        <div className="mx-auto h-10 w-20 rounded-full bg-slate-700/60" />
        <div className="mx-auto mt-3 h-3 w-36 rounded-full bg-slate-800/80" />
        <div className="mx-auto mt-3 h-3 w-24 rounded-full bg-slate-800/70" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-[18px] p-4" style={GLASS_STYLE}>
            <div className="h-7 w-16 rounded-full bg-slate-700/60" />
            <div className="mt-3 h-3 w-24 rounded-full bg-slate-800/80" />
          </div>
        ))}
      </div>
      <div className="rounded-[22px] p-4" style={GLASS_STYLE}>
        <div className="h-3 w-32 rounded-full bg-slate-800/80" />
        <div className="mt-5 flex h-20 items-end gap-2">
          {Array.from({ length: 7 }).map((_, index) => (
            <div key={index} className="flex flex-1 flex-col items-center justify-end gap-2">
              <div className="w-full rounded-[4px] bg-slate-700/60" style={{ height: `${28 + (index % 4) * 10}px` }} />
              <div className="h-2 w-3 rounded-full bg-slate-800/80" />
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-[22px] p-4" style={GLASS_STYLE}>
        <div className="h-3 w-28 rounded-full bg-slate-800/80" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="rounded-2xl bg-slate-900/40 p-4">
              <div className="h-3 w-28 rounded-full bg-slate-700/60" />
              <div className="mt-3 h-3 w-full rounded-full bg-slate-800/80" />
              <div className="mt-2 h-3 w-5/6 rounded-full bg-slate-800/70" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function HeadlineDelta({ delta, comparisonLabel }: { delta?: number; comparisonLabel: string }) {
  if (delta == null || Number.isNaN(delta)) return null;

  const positive = delta >= 0;
  const Icon = positive ? ArrowUp : ArrowDown;
  const tone = positive ? 'text-emerald-400' : 'text-rose-400';

  return (
    <p className={cn('mt-1 inline-flex items-center justify-center text-xs', tone)}>
      <Icon className="mr-1 h-3.5 w-3.5" />
      {Math.abs(Math.round(delta))}% vs {comparisonLabel}
    </p>
  );
}

function TrendBarChart({ data, prefersReducedMotion }: { data: TrendBarPoint[]; prefersReducedMotion: boolean }) {
  const maxValue = Math.max(...data.map((point) => point.value), 1);

  return (
    <div className="flex items-end justify-between gap-1.5 px-1" style={{ height: 80 }}>
      {data.map((point) => {
        const height = point.value === 0 ? 8 : Math.max((point.value / maxValue) * 72, 12);
        return (
          <div key={point.id} className="flex flex-1 flex-col items-center gap-1">
            <motion.div
              className="w-full rounded-[4px] bg-emerald-500/60"
              initial={prefersReducedMotion ? undefined : { height: 0, opacity: 0.5 }}
              animate={{ height, opacity: 1 }}
              transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.35, ease: 'easeOut' }}
            />
            <span className="text-[0.5625rem] text-[var(--text-muted)]">{point.label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function MobileInsightsScreen({ onBack }: MobileInsightsScreenProps) {
  const [period, setPeriod] = useState<InsightsPeriod>(7);
  const [snapshot, setSnapshot] = useState<InsightsSnapshot | null>(null);
  const [observations, setObservations] = useState<InsightObservation[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefersReducedMotion = useReducedMotion() ?? false;

  const loadData = useCallback(async (nextPeriod: InsightsPeriod, refresh = false) => {
    if (refresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    setError(null);

    try {
      const [insightsResponse, observationsResponse] = await Promise.all([
        fetch(`/api/insights?period=${nextPeriod}`, { cache: 'no-store' }),
        fetch(`/api/insights/observations?period=${nextPeriod}`, { cache: 'no-store' }),
      ]);

      if (!insightsResponse.ok) {
        throw new Error('Failed to load insights.');
      }

      if (!observationsResponse.ok) {
        throw new Error('Failed to load AI observations.');
      }

      const nextSnapshot = await insightsResponse.json() as InsightsSnapshot;
      const observationPayload = await observationsResponse.json() as ObservationsResponse;

      setSnapshot(nextSnapshot);
      setObservations((observationPayload.observations ?? []).map(normalizeObservation));
      setGeneratedAt(observationPayload.generatedAt ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load insights right now.');
      if (!refresh) {
        setSnapshot(null);
        setObservations([]);
        setGeneratedAt(null);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadData(period);
    });
  }, [loadData, period]);

  const onRefresh = useCallback(async () => {
    await loadData(period, true);
  }, [loadData, period]);

  const { containerRef, isRefreshing, pullDistance, containerProps, contentStyle } = usePullToRefresh({
    onRefresh,
    enabled: !loading,
  });

  const periodMeta = getPeriodMeta(period);
  const chartData = useMemo(() => (snapshot ? aggregateTrendData(snapshot.trends, period) : []), [period, snapshot]);
  const recommendations = useMemo(() => buildRecommendations(snapshot, observations), [observations, snapshot]);
  const empty = isInsightDataEmpty(snapshot, observations);
  const headlineDelta = snapshot?.kpis.completed.delta;

  return (
    <div className="flex h-full min-h-screen min-h-0 flex-col bg-[#020617] text-white" aria-label="Insights screen">
      <div
        ref={containerRef}
        className="relative flex-1 overflow-y-auto overscroll-y-contain"
        {...containerProps}
      >
        <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing || refreshing} />

        <div style={contentStyle} className="px-5 pb-28 pt-4">
          {/* Header — always visible */}
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <motion.button
                type="button"
                onClick={onBack}
                whileTap={{ scale: 0.96 }}
                className="relative mt-1 flex h-10 w-10 items-center justify-center rounded-full text-slate-200"
                style={GLASS_STYLE}
                aria-label="Go back"
              >
                <ArrowLeft className="h-[14px] w-[14px]" />
              </motion.button>
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.24em] text-sky-400/90">Analytics</p>
                <h1 className="mt-1 text-[1.75rem] font-semibold text-white">Insights</h1>
              </div>
            </div>

            <div className="flex gap-2">
              {PERIOD_OPTIONS.map((option) => {
                const active = option.value === period;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setPeriod(option.value)}
                    className={cn(
                      'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                      active ? 'text-white ring-1 ring-inset ring-sky-400/30' : 'text-slate-400'
                    )}
                    style={active ? { ...CHIP_STYLE, background: 'rgba(10, 132, 255, 0.20)' } : CHIP_STYLE}
                    aria-pressed={active}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {error ? (
              <motion.div
                key="error"
                variants={fadeSlideUp}
                initial={prefersReducedMotion ? 'show' : 'hidden'}
                animate="show"
                exit={prefersReducedMotion ? undefined : 'exit'}
                className="rounded-[22px] p-5"
                style={GLASS_STYLE}
              >
                <p className="text-sm text-rose-200">{error}</p>
                <button
                  type="button"
                  onClick={() => {
                    void loadData(period);
                  }}
                  className="mt-4 inline-flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-medium text-white"
                  style={CHIP_STYLE}
                >
                  Try again
                </button>
              </motion.div>
            ) : loading && !snapshot ? (
              <motion.div
                key="loading"
                variants={staggerContainer}
                initial={prefersReducedMotion ? 'show' : 'hidden'}
                animate="show"
                exit={prefersReducedMotion ? undefined : 'hidden'}
              >
                <InsightSkeleton />
              </motion.div>
            ) : empty ? (
              <motion.div
                key="empty"
                variants={fadeSlideUp}
                initial={prefersReducedMotion ? 'show' : 'hidden'}
                animate="show"
                exit={prefersReducedMotion ? undefined : 'exit'}
                className="rounded-[22px] px-6 py-10 text-center"
                style={GLASS_STYLE}
              >
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-900/70">
                  <Brain className="h-6 w-6 text-sky-300" />
                </div>
                <h2 className="mt-4 text-lg font-semibold text-white">No insights yet</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  Complete a few tasks, then pull to refresh for trends, observations, and next-step suggestions.
                </p>
              </motion.div>
            ) : snapshot ? (
              <motion.div
                key={`content-${period}`}
                variants={staggerContainer}
                initial={prefersReducedMotion ? 'show' : 'hidden'}
                animate="show"
                exit={prefersReducedMotion ? undefined : 'hidden'}
                className=""
              >

                <motion.section variants={fadeSlideUp} className="mt-5 rounded-[22px] p-5 text-center" style={GLASS_STYLE}>
                  <p className="text-[2.5rem] font-bold text-white">{formatNumber(snapshot.kpis.completed.value)}</p>
                  <p className="text-sm text-slate-400">tasks completed {periodMeta.rangeLabel}</p>
                  <HeadlineDelta delta={headlineDelta} comparisonLabel={periodMeta.comparisonLabel} />
                </motion.section>

                <motion.section variants={fadeSlideUp} className="mt-3 grid grid-cols-2 gap-3">
                  {[
                    { key: 'created' as const, label: 'Tasks created', valueClassName: 'text-sky-400' },
                    { key: 'netChange' as const, label: 'Net change', valueClassName: 'text-amber-400' },
                    { key: 'avgTaskAge' as const, label: 'Avg. task age', valueClassName: 'text-violet-400' },
                    { key: 'streak' as const, label: 'Streak', valueClassName: 'text-emerald-400' },
                  ].map((item) => (
                    <div key={item.key} className="rounded-[18px] p-4 text-center" style={GLASS_STYLE}>
                      <p className={cn('text-2xl font-bold', item.valueClassName)}>
                        {formatGridValue(item.key, snapshot.kpis[item.key])}
                      </p>
                      <p className="text-xs text-[var(--text-muted)]">{item.label}</p>
                    </div>
                  ))}
                </motion.section>

                <motion.section variants={fadeSlideUp} className="mt-3 rounded-[22px] p-4" style={GLASS_STYLE}>
                  <ActivityHeatmap data={snapshot.activityHeatmap} compact />
                </motion.section>

                <motion.section variants={fadeSlideUp} className="mt-3 rounded-[22px] p-4" style={GLASS_STYLE}>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)]">Productivity by Day</p>
                    {(refreshing || isRefreshing) ? <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" /> : null}
                  </div>
                  <TrendBarChart data={chartData} prefersReducedMotion={prefersReducedMotion} />
                </motion.section>

                <motion.section variants={fadeSlideUp} className="mt-3 rounded-[22px] p-4" style={GLASS_STYLE}>
                  <div className="mb-3 flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-sky-300" />
                    <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)]">AI Observations</p>
                  </div>

                  {observations.length === 0 ? (
                    <p className="text-sm leading-6 text-slate-400">
                      No observations yet - complete more work to unlock AI insights.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {observations.map((observation, index) => (
                        <div
                          key={observation.id}
                          className={cn('flex gap-3', index > 0 && 'border-t border-slate-800/80 pt-3')}
                        >
                          <div className={cn('mt-1 h-10 w-1 shrink-0 rounded-full', getObservationAccent(observation.sentiment))} />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-white">{observation.title}</p>
                            <p className="mt-1 text-sm leading-5 text-slate-400">{observation.body || 'No additional context provided.'}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {generatedAt ? (
                    <p className="mt-3 text-[0.625rem] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                      Updated {new Date(generatedAt).toLocaleString()}
                    </p>
                  ) : null}
                </motion.section>

                <motion.section variants={fadeSlideUp} className="mt-3 rounded-[22px] p-4" style={GLASS_STYLE}>
                  <div className="mb-3 flex items-center gap-2">
                    <Lightbulb className="h-4 w-4 text-amber-300" />
                    <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)]">Recommendations</p>
                  </div>

                  {recommendations.length === 0 ? (
                    <p className="text-sm leading-6 text-slate-400">
                      Everything looks steady right now - keep the pace and check back tomorrow.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {recommendations.map((recommendation, index) => {
                        const TrendIcon = recommendation.trend === 'up'
                          ? TrendingUp
                          : recommendation.trend === 'down'
                            ? TrendingDown
                            : Lightbulb;

                        return (
                          <div
                            key={recommendation.id}
                            className={cn('flex items-start justify-between gap-3', index > 0 && 'border-t border-slate-800/80 pt-3')}
                          >
                            <p className="flex min-w-0 items-start gap-3 text-sm leading-5 text-slate-300">
                              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                              <span>{recommendation.text}</span>
                            </p>
                            <TrendIcon
                              className={cn(
                                'mt-0.5 h-4 w-4 shrink-0',
                                recommendation.trend === 'up'
                                  ? 'text-emerald-400'
                                  : recommendation.trend === 'down'
                                    ? 'text-rose-400'
                                    : 'text-[var(--text-muted)]'
                              )}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </motion.section>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
