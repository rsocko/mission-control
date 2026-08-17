'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowDown, ArrowUp, Flame, Lightbulb } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { fadeSlideUp } from '@/lib/motion';
import { AnimatedCounter } from '@/components/ui/AnimatedCounter';
import { Skeleton } from '@/components/ui/Skeleton';
import { CompletionTrendChart } from '@/components/insights/CompletionTrendChart';
import { SourceBreakdownChart } from '@/components/insights/SourceBreakdownChart';
import { TaskAgeChart } from '@/components/insights/TaskAgeChart';
import { RoutineHeatmap } from '@/components/insights/RoutineHeatmap';
import { ProjectActivity } from '@/components/insights/ProjectActivity';
import { DeliveryTrendChart } from '@/components/insights/DeliveryTrendChart';
import { LeadTimeChart } from '@/components/insights/LeadTimeChart';
import { ActivityHeatmap } from '@/components/insights/ActivityHeatmap';
import type {
  DeliveryInterval,
  InsightsActivitySection,
  InsightsDeliverySection,
  InsightsFlowSection,
  InsightsPeriod,
  InsightsSection,
  InsightsSummarySection,
} from '@/lib/stats/insights';
import {
  FlowInsightsSection,
  type FlowFilterValues,
} from '@/components/insights/FlowInsightsSection';
import type { AIObservation } from '@/app/api/insights/observations/route';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type ReportPeriod = InsightsPeriod | 'custom';
type PeriodOption = { label: string; value: ReportPeriod };
interface InsightsRequestFilters {
  interval?: DeliveryInterval;
  project?: string;
  source?: string;
  timeZone?: string;
  priority?: string;
  status?: string;
  staleDays?: string;
  start?: string;
  end?: string;
}

const PERIODS: PeriodOption[] = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: 'Custom', value: 'custom' },
];
const ALL_DELIVERY_FILTERS = '__all__';

function parsePeriod(rawPeriod: string | null): ReportPeriod {
  if (rawPeriod === 'custom') return 'custom';
  if (rawPeriod === '30') return 30;
  if (rawPeriod === '90') return 90;
  return 7;
}

function parseInterval(rawInterval: string | null, period: ReportPeriod): DeliveryInterval {
  if (rawInterval === 'week' || rawInterval === 'month') return rawInterval;
  return period === 90 ? 'month' : 'week';
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function defaultCustomStart(now = new Date()): string {
  const date = new Date(now);
  date.setDate(date.getDate() - 29);
  return formatLocalDate(date);
}

function defaultCustomEnd(now = new Date()): string {
  return formatLocalDate(now);
}

export default function InsightsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-24">
          <div role="status" aria-label="Loading insights" className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-blue-400" />
        </div>
      }
    >
      <InsightsPageContent />
    </Suspense>
  );
}

function InsightsPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const period = parsePeriod(searchParams.get('period'));
  const customStart = searchParams.get('start') ?? defaultCustomStart();
  const customEnd = searchParams.get('end') ?? defaultCustomEnd();
  const projectFilter = searchParams.get('project') ?? searchParams.get('projectId') ?? '';
  const sourceFilter = searchParams.get('source') ?? '';
  const flowFilters: FlowFilterValues = {
    projectId: projectFilter,
    source: sourceFilter,
    priority: searchParams.get('priority') ?? '',
    status: searchParams.get('status') ?? '',
    staleDays: searchParams.get('staleDays') ?? '14',
  };
  const [summary, setSummary] = useState<InsightsSummarySection | null>(null);
  const [delivery, setDelivery] = useState<InsightsDeliverySection | null>(null);
  const [flow, setFlow] = useState<InsightsFlowSection | null>(null);
  const [activity, setActivity] = useState<InsightsActivitySection | null>(null);
  const [sectionLoading, setSectionLoading] = useState<Record<InsightsSection, boolean>>({
    summary: true,
    delivery: true,
    flow: true,
    activity: true,
  });
  const [sectionErrors, setSectionErrors] = useState<Record<InsightsSection, string | null>>({
    summary: null,
    delivery: null,
    flow: null,
    activity: null,
  });
  const [observations, setObservations] = useState<AIObservation[]>([]);
  const [observationsPeriod, setObservationsPeriod] = useState<InsightsPeriod | null>(null);
  const [observationsLoading, setObservationsLoading] = useState(true);
  const [observationsError, setObservationsError] = useState<string | null>(null);
  const sectionRequestIds = useRef<Record<InsightsSection, number>>({
    summary: 0,
    delivery: 0,
    flow: 0,
    activity: 0,
  });
  const sectionControllers = useRef<Partial<Record<InsightsSection, AbortController>>>({});
  const observationsRequestId = useRef(0);
  const pendingParams = useRef<string | null>(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const interval = parseInterval(searchParams.get('interval'), period);

  const fetchSection = useCallback(async (
    section: InsightsSection,
    p: ReportPeriod,
    filters: InsightsRequestFilters,
  ) => {
    sectionControllers.current[section]?.abort();
    const controller = new AbortController();
    sectionControllers.current[section] = controller;
    const currentRequest = ++sectionRequestIds.current[section];
    const { signal } = controller;
    setSectionLoading(current => ({ ...current, [section]: true }));
    setSectionErrors(current => ({ ...current, [section]: null }));
    if (section === 'summary') setSummary(null);
    if (section === 'delivery') setDelivery(null);
    if (section === 'flow') setFlow(null);
    if (section === 'activity') setActivity(null);
    try {
      const query = new URLSearchParams({
        period: String(p),
        section,
      });
      if (filters.interval) query.set('interval', filters.interval);
      if (filters.timeZone) query.set('timezone', filters.timeZone);
      if (p === 'custom') {
        if (filters.start) query.set('start', filters.start);
        if (filters.end) query.set('end', filters.end);
      }
      if (filters.project) query.set('project', filters.project);
      if (filters.source) query.set('source', filters.source);
      if (filters.priority) query.set('priority', filters.priority);
      if (filters.status) query.set('status', filters.status);
      if (filters.staleDays) query.set('staleDays', filters.staleDays);
      const insightsRes = await fetch(`/api/insights?${query.toString()}`, { signal });
      if (!insightsRes.ok) {
        const body = await insightsRes.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(
          typeof body?.error === 'string' ? body.error : 'Failed to load insights data',
        );
      }
      const insights = await insightsRes.json();
      if (currentRequest !== sectionRequestIds.current[section]) return;
      if (section === 'summary') setSummary(insights as InsightsSummarySection);
      if (section === 'delivery') setDelivery(insights as InsightsDeliverySection);
      if (section === 'flow') setFlow(insights as InsightsFlowSection);
      if (section === 'activity') setActivity(insights as InsightsActivitySection);
    } catch (err) {
      if (signal.aborted || currentRequest !== sectionRequestIds.current[section]) return;
      setSectionErrors(current => ({
        ...current,
        [section]: err instanceof Error ? err.message : `Failed to load ${section} insights`,
      }));
    } finally {
      if (
        !signal.aborted
        && currentRequest === sectionRequestIds.current[section]
        && sectionControllers.current[section] === controller
      ) {
        setSectionLoading(current => ({ ...current, [section]: false }));
      }
    }
  }, []);

  const fetchObservations = useCallback(async (p: InsightsPeriod) => {
    const currentRequest = ++observationsRequestId.current;
    setObservationsLoading(true);
    setObservationsError(null);
    setObservations([]);
    setObservationsPeriod(null);
    try {
      const response = await fetch(`/api/insights/observations?period=${p}`);
      if (!response.ok) throw new Error('Failed to load AI observations');
      const result = await response.json();
      if (currentRequest !== observationsRequestId.current) return;
      setObservations(result.observations ?? []);
      setObservationsPeriod(p);
    } catch {
      if (currentRequest !== observationsRequestId.current) return;
      setObservations([]);
      setObservationsPeriod(p);
      setObservationsError('AI observations are temporarily unavailable.');
    } finally {
      if (currentRequest === observationsRequestId.current) setObservationsLoading(false);
    }
  }, [setObservations, setObservationsError, setObservationsLoading, setObservationsPeriod]);

  useEffect(() => {
    const filters = { start: customStart, end: customEnd };
    fetchSection('summary', period, filters);
    fetchSection('activity', period, filters);
    const summaryController = sectionControllers.current.summary;
    const activityController = sectionControllers.current.activity;
    return () => {
      summaryController?.abort();
      activityController?.abort();
    };
  }, [period, customStart, customEnd, fetchSection]);

  useEffect(() => {
    fetchSection('delivery', period, {
      interval,
      project: projectFilter,
      source: sourceFilter,
      timeZone,
      start: customStart,
      end: customEnd,
    });
    const controller = sectionControllers.current.delivery;
    return () => controller?.abort();
  }, [period, interval, projectFilter, sourceFilter, timeZone, customStart, customEnd, fetchSection]);

  useEffect(() => {
    fetchSection('flow', period, {
      project: projectFilter,
      source: sourceFilter,
      timeZone,
      priority: flowFilters.priority,
      status: flowFilters.status,
      staleDays: flowFilters.staleDays,
      start: customStart,
      end: customEnd,
    });
    const controller = sectionControllers.current.flow;
    return () => controller?.abort();
  }, [
    period,
    projectFilter,
    sourceFilter,
    timeZone,
    customStart,
    customEnd,
    flowFilters.priority,
    flowFilters.status,
    flowFilters.staleDays,
    fetchSection,
  ]);

  useEffect(() => {
    queueMicrotask(() => {
      if (period === 'custom') {
        observationsRequestId.current += 1;
        setObservations([]);
        setObservationsPeriod(null);
        setObservationsError(null);
        setObservationsLoading(false);
      } else {
        fetchObservations(period);
      }
    });
  }, [period, fetchObservations]);

  useEffect(() => {
    pendingParams.current = searchParams.toString();
  }, [searchParams]);

  const replaceSearchParams = (update: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(pendingParams.current ?? searchParams.toString());
    update(params);
    const query = params.toString();
    pendingParams.current = query;
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const updatePeriod = (nextPeriod: ReportPeriod) => {
    replaceSearchParams(params => {
      if (nextPeriod === 7) params.delete('period');
      else params.set('period', String(nextPeriod));
      if (nextPeriod === 'custom') {
        if (!params.has('start')) params.set('start', customStart);
        if (!params.has('end')) params.set('end', customEnd);
      } else {
        params.delete('start');
        params.delete('end');
      }
    });
  };

  const updateDeliveryFilter = (name: 'interval' | 'project' | 'source', value: string) => {
    replaceSearchParams(params => {
      if (value) params.set(name, value);
      else params.delete(name);
      if (name === 'project') params.delete('projectId');
    });
  };

  const updateCustomDate = (name: 'start' | 'end', value: string) => {
    replaceSearchParams(params => {
      params.set('period', 'custom');
      params.set(name, value);
    });
  };

  const updateFlowFilter = (name: keyof FlowFilterValues, value: string) => {
    const queryName = name === 'projectId' ? 'project' : name;
    replaceSearchParams(params => {
      if (value) params.set(queryName, value);
      else params.delete(queryName);
      if (name === 'projectId') params.delete('projectId');
    });
  };

  const retrySection = (section: InsightsSection) => fetchSection(section, period, {
    interval,
    project: projectFilter,
    source: sourceFilter,
    timeZone,
    priority: flowFilters.priority,
    status: flowFilters.status,
    staleDays: flowFilters.staleDays,
    start: customStart,
    end: customEnd,
  });

  return (
    <div className="h-full overflow-y-auto bg-[#020617] text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-6 pb-12 sm:px-6">
        {/* Page Header */}
        <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-xl font-bold">Insights</h2>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <div className="flex items-center gap-1 rounded-lg bg-slate-800/60 p-1">
              {PERIODS.map(p => (
                <button
                  key={p.value}
                  aria-pressed={period === p.value}
                  onClick={() => updatePeriod(p.value)}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                    period === p.value
                      ? 'bg-blue-900/60 text-blue-400'
                      : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {period === 'custom' && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <label className="flex items-center gap-1.5">
                  From
                  <input
                    aria-label="Custom range start"
                    type="date"
                    value={customStart}
                    max={customEnd}
                    onChange={event => updateCustomDate('start', event.target.value)}
                    className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  To
                  <input
                    aria-label="Custom range end"
                    type="date"
                    value={customEnd}
                    min={customStart}
                    onChange={event => updateCustomDate('end', event.target.value)}
                    className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200"
                  />
                </label>
              </div>
            )}
          </div>
        </div>

        <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.05 } } }}>
            {/* Zone 1: Summary KPIs */}
            {sectionLoading.summary ? (
              <SummaryKpiSkeleton />
            ) : sectionErrors.summary ? (
              <SectionError message={sectionErrors.summary} onRetry={() => retrySection('summary')} />
            ) : summary ? (
              <motion.div variants={fadeSlideUp} className="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-3 lg:grid-cols-5">
                <KpiStatCard
                  label="Completed"
                  value={summary.kpis.completed.value}
                  unit="tasks"
                  delta={summary.kpis.completed.delta}
                  accent="emerald"
                />
                <KpiStatCard
                  label="Created"
                  value={summary.kpis.created.value}
                  unit="tasks"
                  delta={summary.kpis.created.delta}
                  accent="blue"
                />
                <KpiStatCard
                  label="Net Change"
                  value={summary.kpis.netChange.value}
                  accent={summary.kpis.netChange.value <= 0 ? 'green' : 'red'}
                  detail={summary.kpis.netChange.value <= 0 ? 'Backlog shrinking 📉' : 'Backlog growing 📈'}
                />
                <KpiStatCard
                  label="Avg Task Age"
                  value={summary.kpis.avgTaskAge.value}
                  unit="days"
                  delta={summary.kpis.avgTaskAge.delta}
                  invertDelta
                  accent="purple"
                />
                <KpiStatCard
                  label="Streak"
                  value={summary.kpis.streak.value}
                  unit="days"
                  accent="amber"
                  icon={<Flame className="w-4 h-4 text-amber-400" />}
                />
              </motion.div>
            ) : null}

            {/* Delivery reporting */}
            {sectionLoading.delivery ? (
              <GroupSkeleton label="Loading delivery insights" className="mb-6 h-80" />
            ) : sectionErrors.delivery ? (
              <SectionError message={sectionErrors.delivery} onRetry={() => retrySection('delivery')} />
            ) : delivery ? (
            <motion.section variants={fadeSlideUp} className="mb-6" aria-labelledby="delivery-heading">
              <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h3 id="delivery-heading" className="text-base font-semibold">Delivery</h3>
                  <p className="mt-1 max-w-3xl text-xs text-slate-400">
                    Throughput is final completions per calendar interval. Velocity is the rolling three-interval
                    completion rate, normalized when an interval is partial. Lead time runs from creation to final completion.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <label className="text-xs text-slate-400">
                    Project
                    <Select
                      value={projectFilter || ALL_DELIVERY_FILTERS}
                      onValueChange={value => updateDeliveryFilter('project', value === ALL_DELIVERY_FILTERS ? '' : value)}
                    >
                      <SelectTrigger aria-label="Filter delivery by project" className="mt-1 h-9 min-h-0 w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL_DELIVERY_FILTERS}>All projects</SelectItem>
                      {delivery.deliveryFilters.projects.map(project => (
                          <SelectItem key={project.value} value={project.value}>{project.label}</SelectItem>
                      ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="text-xs text-slate-400">
                    Source
                    <Select
                      value={sourceFilter || ALL_DELIVERY_FILTERS}
                      onValueChange={value => updateDeliveryFilter('source', value === ALL_DELIVERY_FILTERS ? '' : value)}
                    >
                      <SelectTrigger aria-label="Filter delivery by source" className="mt-1 h-9 min-h-0 w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL_DELIVERY_FILTERS}>All sources</SelectItem>
                      {delivery.deliveryFilters.sources.filter(source => source.value.trim()).map(source => (
                          <SelectItem key={source.value} value={source.value}>{source.label}</SelectItem>
                      ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="text-xs text-slate-400">
                    Interval
                    <Select
                      value={interval}
                      onValueChange={value => updateDeliveryFilter('interval', value)}
                    >
                      <SelectTrigger aria-label="Delivery interval" className="mt-1 h-9 min-h-0 w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="week">Weekly</SelectItem>
                        <SelectItem value="month">Monthly</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                </div>
              </div>

              <p className="mb-3 text-[0.7rem] text-slate-500">
                {delivery.deliverySemantics.intervals} {delivery.deliverySemantics.exclusions}
              </p>
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-semibold">Throughput &amp; Velocity</h4>
                      <p className="mt-1 text-xs text-slate-500">Count-based; zero bars mean no completions, not missing data.</p>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-semibold tabular-nums text-emerald-400">{delivery.delivery.throughput.total}</div>
                      <div className="text-[0.65rem] text-slate-500">
                        {delivery.delivery.throughput.averagePerInterval} average / {interval}
                      </div>
                    </div>
                  </div>
                  <DeliveryTrendChart throughput={delivery.delivery.throughput} />
                </div>
                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
                  <div className="mb-3">
                    <h4 className="text-sm font-semibold">Lead Time</h4>
                    <p className="mt-1 text-xs text-slate-500">
                      Median and percentiles avoid relying on a potentially misleading average.
                    </p>
                  </div>
                  <LeadTimeChart leadTime={delivery.delivery.leadTime} />
                </div>
              </div>
            </motion.section>
            ) : null}

            {sectionLoading.activity ? (
              <GroupSkeleton label="Loading activity insights" className="mb-6 h-44" />
            ) : sectionErrors.activity ? (
              <SectionError message={sectionErrors.activity} onRetry={() => retrySection('activity')} />
            ) : activity ? (
              <motion.div variants={fadeSlideUp} className="mb-6 rounded-2xl border border-slate-800 bg-slate-900 p-5">
                <ActivityHeatmap data={activity.activityHeatmap} />
              </motion.div>
            ) : null}

            {/* Completion Trend + Source Breakdown */}
            {sectionLoading.summary ? (
              <GroupSkeleton label="Loading trend insights" className="mb-6 h-72" />
            ) : summary ? (
            <motion.div variants={fadeSlideUp} className="grid grid-cols-1 gap-5 mb-6 lg:grid-cols-3">
              <div className="lg:col-span-2 rounded-2xl bg-slate-900 border border-slate-800 p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold">Completion Trend</h3>
                  <div className="flex items-center gap-4 text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" /> Completed
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm bg-blue-500/50 inline-block" /> Created
                    </span>
                  </div>
                </div>
                <CompletionTrendChart data={summary.trends} period={period === 'custom' ? 30 : period} />
              </div>
              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
                <h3 className="text-sm font-semibold mb-4">Completions by Source</h3>
                <SourceBreakdownChart
                  data={summary.sourceBreakdown}
                  period={period === 'custom' ? 30 : period}
                />
              </div>
            </motion.div>
            ) : null}

            {sectionLoading.flow ? (
              <GroupSkeleton label="Loading flow insights" className="mb-6 h-64" />
            ) : sectionErrors.flow ? (
              <SectionError message={sectionErrors.flow} onRetry={() => retrySection('flow')} />
            ) : flow ? (
              <motion.div variants={fadeSlideUp}>
              {flow.flow && (
                <FlowInsightsSection
                  data={flow.flow}
                  filters={flowFilters}
                  onFilterChange={updateFlowFilter}
                />
              )}
              </motion.div>
            ) : null}

            {/* Zone 3: Task Age + AI Observations */}
            <motion.div variants={fadeSlideUp} className="grid grid-cols-1 gap-5 mb-6 lg:grid-cols-3">
              {sectionLoading.summary ? (
                <GroupSkeleton label="Loading task age insights" className="h-64" />
              ) : summary ? (
                <div className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
                  <h3 className="text-sm font-semibold mb-4">Open Task Age</h3>
                  <TaskAgeChart data={summary.taskAge} period={period === 'custom' ? 30 : period} />
                </div>
              ) : (
                <SectionError
                  message={sectionErrors.summary ?? 'Summary insights are unavailable'}
                  onRetry={() => retrySection('summary')}
                />
              )}
              <div className="lg:col-span-2 rounded-2xl bg-slate-900 border border-slate-800 p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Lightbulb className="w-4 h-4 text-amber-300" />
                    <h3 className="text-sm font-semibold">AI Observations</h3>
                    <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-400/20">
                      {observations.length}
                    </span>
                  </div>
                </div>
                <div
                  className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
                  aria-busy={period !== 'custom' && (observationsLoading || observationsPeriod !== period)}
                >
                  {period !== 'custom' && (observationsLoading || observationsPeriod !== period) && (
                    <p className="col-span-3 text-center text-sm text-slate-500 py-6">
                      Loading observations...
                    </p>
                  )}
                  {period === 'custom' && (
                    <p className="col-span-3 text-center text-sm text-slate-500 py-6">
                      AI observations are available for 7, 30, and 90-day periods.
                    </p>
                  )}
                  {period !== 'custom' && !observationsLoading && observationsPeriod === period && observationsError && (
                    <p role="alert" className="col-span-3 text-center text-sm text-amber-400 py-6">
                      {observationsError}
                    </p>
                  )}
                  {period !== 'custom' && !observationsLoading && observationsPeriod === period && !observationsError
                    && observations.map(obs => (
                      <ObservationCard key={obs.id} observation={obs} />
                    ))}
                  {period !== 'custom' && !observationsLoading && observationsPeriod === period
                    && !observationsError && observations.length === 0 && (
                    <p className="col-span-3 text-sm text-slate-500 text-center py-6">
                      No observations yet — complete more tasks to unlock AI insights.
                    </p>
                  )}
                </div>
              </div>
            </motion.div>

            {/* Routine Heatmap + Project Activity */}
            {sectionLoading.activity ? (
              <GroupSkeleton label="Loading routine and project activity" className="h-64" />
            ) : activity ? (
            <motion.div variants={fadeSlideUp} className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
                <h3 className="text-sm font-semibold mb-4">Routine Completion (This Week)</h3>
                <RoutineHeatmap data={activity.routineHeatmap} />
              </div>
              <div className="rounded-2xl bg-slate-900 border border-slate-800 p-5">
                <h3 className="text-sm font-semibold mb-4">Project Activity</h3>
                <ProjectActivity data={activity.projectActivity} />
              </div>
            </motion.div>
            ) : null}
          </motion.div>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function GroupSkeleton({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn('rounded-2xl border border-slate-800 bg-slate-900 p-5', className)}
    >
      <Skeleton className="mb-5 h-4 w-32 bg-slate-800" />
      <div className="grid h-[calc(100%-2.25rem)] grid-cols-3 items-end gap-3">
        <Skeleton className="h-2/3 bg-slate-800" />
        <Skeleton className="h-full bg-slate-800" />
        <Skeleton className="h-1/2 bg-slate-800" />
      </div>
    </div>
  );
}

function SummaryKpiSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading summary insights"
      className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
    >
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <Skeleton className="mb-3 h-3 w-20 bg-slate-800" />
          <Skeleton className="h-8 w-16 bg-slate-800" />
        </div>
      ))}
    </div>
  );
}

function SectionError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="mb-6 flex min-h-32 flex-col items-center justify-center gap-3 rounded-2xl border border-red-950 bg-slate-900 p-5">
      <p className="text-sm text-red-400">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 hover:text-white"
      >
        Retry
      </button>
    </div>
  );
}

function KpiStatCard({
  label,
  value,
  unit,
  delta,
  invertDelta,
  accent,
  detail,
  icon,
}: {
  label: string;
  value: number;
  unit?: string;
  delta?: number;
  invertDelta?: boolean;
  accent: string;
  detail?: string;
  icon?: React.ReactNode;
}) {
  const isPositive = invertDelta ? (delta ?? 0) < 0 : (delta ?? 0) > 0;
  const accentColors: Record<string, string> = {
    emerald: 'text-emerald-400',
    blue: 'text-blue-400',
    green: 'text-green-400',
    red: 'text-red-400',
    purple: 'text-purple-400',
    amber: 'text-amber-400',
  };
  const glowColors: Record<string, string> = {
    emerald: 'bg-emerald-500',
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    red: 'bg-red-500',
    purple: 'bg-purple-500',
    amber: 'bg-amber-500',
  };

  return (
    <div className="relative overflow-hidden rounded-xl bg-slate-900 border border-slate-800 p-5">
      <div className={cn('absolute -top-2 -right-2 w-16 h-16 rounded-full blur-[28px] opacity-40', glowColors[accent])} />
      <div className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <AnimatedCounter value={value} className={cn('text-2xl font-bold tabular-nums', accentColors[accent])} />
        {unit && <span className="text-sm text-slate-500">{unit}</span>}
        {icon}
      </div>
      {delta !== undefined && delta !== 0 && (
        <div className="flex items-center gap-1 mt-2">
          {isPositive ? (
            <ArrowUp className="w-3 h-3 text-emerald-400" />
          ) : (
            <ArrowDown className="w-3 h-3 text-red-400" />
          )}
          <span className={cn('text-xs', isPositive ? 'text-emerald-400' : 'text-red-400')}>
            {delta > 0 ? '+' : ''}{delta}% vs last period
          </span>
        </div>
      )}
      {detail && <div className="text-xs text-slate-500 mt-2">{detail}</div>}
    </div>
  );
}

function ObservationCard({ observation }: { observation: AIObservation }) {
  const typeConfig: Record<string, { label: string; color: string }> = {
    pattern: { label: 'Pattern', color: 'text-emerald-300' },
    stale: { label: 'Stale Work', color: 'text-amber-300' },
    balance: { label: 'Balance', color: 'text-blue-300' },
    streak: { label: 'Streak', color: 'text-orange-300' },
    workload: { label: 'Workload', color: 'text-purple-300' },
  };
  const config = typeConfig[observation.type] ?? { label: 'Insight', color: 'text-slate-300' };

  return (
    <div className="rounded-xl bg-slate-800 border border-slate-700/70 p-4 hover:border-blue-500/20 transition-colors">
      <div className={cn('text-[0.6rem] font-bold uppercase tracking-widest mb-2', config.color)}>
        {config.label}
      </div>
      <h4 className="text-sm font-semibold">{observation.title}</h4>
      <p className="text-xs text-slate-400 mt-2">{observation.description}</p>
    </div>
  );
}
