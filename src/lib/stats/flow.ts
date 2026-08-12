export type FlowStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';

export interface FlowTaskInput {
  id: string;
  title: string;
  status: string;
  priority: string;
  source: string;
  projectIds: string[];
}

export interface FlowHistoryEventInput {
  id: number;
  taskId: string;
  eventType: string;
  previousValue: string | null;
  newValue: string | null;
  projectId: string | null;
  occurredAt: string;
  provenance?: string;
}

export interface FlowFilters {
  projectId?: string;
  source?: string;
  priority?: string;
  status?: string;
}

export interface CycleTimeItem {
  taskId: string;
  title: string;
  startedAt: string;
  completedAt: string;
  days: number;
  reworkCount: number;
}

export interface CycleTimeBucket {
  label: string;
  count: number;
  minDays: number;
  maxDays: number | null;
}

export interface CycleTimeReport {
  count: number;
  excludedWithoutStart: number;
  medianDays: number | null;
  averageDays: number | null;
  percentile85Days: number | null;
  reworkedCount: number;
  items: CycleTimeItem[];
  distribution: CycleTimeBucket[];
}

export interface CumulativeFlowPoint {
  date: string;
  todo: number;
  inProgress: number;
  done: number;
  cancelled: number;
  knownTasks: number;
  coverage: 'unavailable' | 'partial' | 'complete';
}

export interface CumulativeFlowReport {
  dimension: 'normalized_status';
  points: CumulativeFlowPoint[];
}

export interface AgingWipItem {
  taskId: string;
  title: string;
  status: FlowStatus;
  enteredAt: string;
  ageDays: number;
  stale: boolean;
  priority: string;
  source: string;
}

export interface AgingWipBucket {
  label: string;
  count: number;
  minDays: number;
  maxDays: number | null;
}

export interface AgingWipReport {
  count: number;
  excludedWithoutEntry: number;
  medianAgeDays: number | null;
  staleCount: number;
  staleThresholdDays: number;
  items: AgingWipItem[];
  buckets: AgingWipBucket[];
}

export interface FlowReport {
  start: string;
  end: string;
  generatedAt: string;
  historicalBoundaryAt: string | null;
  partialHistory: boolean;
  cycleTime: CycleTimeReport;
  cumulativeFlow: CumulativeFlowReport;
  agingWip: AgingWipReport;
}

export interface ComputeFlowReportInput {
  tasks: FlowTaskInput[];
  events: FlowHistoryEventInput[];
  start: string;
  end: string;
  now: string;
  staleThresholdDays?: number;
  filters?: FlowFilters;
}

interface ReplayState {
  status: FlowStatus;
  projectIds: Set<string>;
}

interface BaselineValue {
  status?: unknown;
  projectIds?: unknown;
}

const DAY_MS = 86_400_000;

export function normalizeFlowStatus(status: string | null): FlowStatus {
  switch (status) {
    case 'in_progress':
    case 'active':
    case 'doing':
      return 'in_progress';
    case 'done':
    case 'completed':
    case 'closed':
      return 'done';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'todo';
  }
}

function parseBaseline(value: string | null): BaselineValue | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as BaselineValue
      : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function compareEvents(a: FlowHistoryEventInput, b: FlowHistoryEventInput): number {
  return a.occurredAt.localeCompare(b.occurredAt) || a.id - b.id;
}

function groupEvents(events: FlowHistoryEventInput[]): Map<string, FlowHistoryEventInput[]> {
  const grouped = new Map<string, FlowHistoryEventInput[]>();
  for (const event of [...events].sort(compareEvents)) {
    const taskEvents = grouped.get(event.taskId);
    if (taskEvents) taskEvents.push(event);
    else grouped.set(event.taskId, [event]);
  }
  return grouped;
}

function stateAt(events: FlowHistoryEventInput[], at: string): ReplayState | null {
  const baseline = events.find(event => event.eventType === 'baseline' && event.occurredAt < at);
  if (!baseline) return null;

  const value = parseBaseline(baseline.newValue);
  if (!value || typeof value.status !== 'string') return null;

  const state: ReplayState = {
    status: normalizeFlowStatus(value.status),
    projectIds: new Set(stringArray(value.projectIds)),
  };

  for (const event of events) {
    if (compareEvents(event, baseline) <= 0 || event.occurredAt >= at) continue;
    if (event.eventType === 'status_changed' && event.newValue !== null) {
      state.status = normalizeFlowStatus(event.newValue);
    } else if (event.eventType === 'project_added' && event.projectId) {
      state.projectIds.add(event.projectId);
    } else if (event.eventType === 'project_removed' && event.projectId) {
      state.projectIds.delete(event.projectId);
    }
  }
  return state;
}

function stateThroughEvent(
  events: FlowHistoryEventInput[],
  through: FlowHistoryEventInput,
): ReplayState | null {
  const baseline = events.find(event => (
    event.eventType === 'baseline' && compareEvents(event, through) <= 0
  ));
  if (!baseline) return null;

  const value = parseBaseline(baseline.newValue);
  if (!value || typeof value.status !== 'string') return null;
  const state: ReplayState = {
    status: normalizeFlowStatus(value.status),
    projectIds: new Set(stringArray(value.projectIds)),
  };
  for (const event of events) {
    if (compareEvents(event, baseline) <= 0 || compareEvents(event, through) > 0) continue;
    if (event.eventType === 'status_changed' && event.newValue !== null) {
      state.status = normalizeFlowStatus(event.newValue);
    } else if (event.eventType === 'project_added' && event.projectId) {
      state.projectIds.add(event.projectId);
    } else if (event.eventType === 'project_removed' && event.projectId) {
      state.projectIds.delete(event.projectId);
    }
  }
  return state;
}

function taskMatchesStaticFilters(task: FlowTaskInput, filters: FlowFilters): boolean {
  return (!filters.source || task.source === filters.source)
    && (!filters.priority || task.priority === filters.priority)
    && (!filters.status || normalizeFlowStatus(task.status) === normalizeFlowStatus(filters.status));
}

function stateMatchesProject(state: ReplayState, filters: FlowFilters): boolean {
  return !filters.projectId || state.projectIds.has(filters.projectId);
}

function roundDays(value: number): number {
  return Math.round(value * 10) / 10;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return roundDays(sorted[Math.max(0, index)]);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return roundDays(values.reduce((total, value) => total + value, 0) / values.length);
}

function cycleDistribution(items: CycleTimeItem[]): CycleTimeBucket[] {
  const buckets: CycleTimeBucket[] = [
    { label: '< 1 day', count: 0, minDays: 0, maxDays: 1 },
    { label: '1-3 days', count: 0, minDays: 1, maxDays: 4 },
    { label: '4-7 days', count: 0, minDays: 4, maxDays: 8 },
    { label: '8-14 days', count: 0, minDays: 8, maxDays: 15 },
    { label: '15-30 days', count: 0, minDays: 15, maxDays: 31 },
    { label: '> 30 days', count: 0, minDays: 31, maxDays: null },
  ];
  for (const item of items) {
    const bucket = buckets.find(candidate => (
      item.days >= candidate.minDays
      && (candidate.maxDays === null || item.days < candidate.maxDays)
    ));
    if (bucket) bucket.count++;
  }
  return buckets;
}

function computeCycleTime(
  tasks: FlowTaskInput[],
  eventGroups: Map<string, FlowHistoryEventInput[]>,
  start: string,
  end: string,
  now: string,
  filters: FlowFilters,
): CycleTimeReport {
  const items: CycleTimeItem[] = [];
  let excludedWithoutStart = 0;

  for (const task of tasks) {
    if (!taskMatchesStaticFilters(task, filters)) continue;
    const events = eventGroups.get(task.id) ?? [];
    const completions = events.filter(event => (
      event.eventType === 'status_changed'
      && normalizeFlowStatus(event.newValue) === 'done'
      && event.occurredAt < now
    ));
    const finalCompletion = completions.at(-1);
    if (!finalCompletion || finalCompletion.occurredAt < start || finalCompletion.occurredAt >= end) continue;

    const finalState = stateAt(events, now);
    if (!finalState || finalState.status !== 'done') continue;
    const completionState = stateThroughEvent(events, finalCompletion);
    if (!completionState || !stateMatchesProject(completionState, filters)) continue;

    const firstStart = events.find(event => (
      event.eventType === 'status_changed'
      && normalizeFlowStatus(event.previousValue) !== 'in_progress'
      && normalizeFlowStatus(event.newValue) === 'in_progress'
      && compareEvents(event, finalCompletion) < 0
    ));
    if (!firstStart) {
      excludedWithoutStart++;
      continue;
    }

    const reworkCount = events.filter(event => (
      event.eventType === 'reopened'
      && compareEvents(event, finalCompletion) < 0
    )).length;
    items.push({
      taskId: task.id,
      title: task.title,
      startedAt: firstStart.occurredAt,
      completedAt: finalCompletion.occurredAt,
      days: roundDays(
        (Date.parse(finalCompletion.occurredAt) - Date.parse(firstStart.occurredAt)) / DAY_MS,
      ),
      reworkCount,
    });
  }

  items.sort((a, b) => b.days - a.days || a.taskId.localeCompare(b.taskId));
  const durations = items.map(item => item.days);
  return {
    count: items.length,
    excludedWithoutStart,
    medianDays: percentile(durations, 0.5),
    averageDays: average(durations),
    percentile85Days: percentile(durations, 0.85),
    reworkedCount: items.filter(item => item.reworkCount > 0).length,
    items,
    distribution: cycleDistribution(items),
  };
}

function addUtcDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + (days * DAY_MS)).toISOString();
}

function computeCumulativeFlow(
  tasks: FlowTaskInput[],
  eventGroups: Map<string, FlowHistoryEventInput[]>,
  start: string,
  end: string,
  now: string,
  filters: FlowFilters,
  migrationBoundaries: string[],
): CumulativeFlowReport {
  const points: CumulativeFlowPoint[] = [];
  const earliestBoundary = migrationBoundaries.at(0);
  const latestBoundary = migrationBoundaries.at(-1);
  const currentDayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
  const lastCompletedDayEnd = end < currentDayStart ? end : currentDayStart;
  const replayTasks = tasks
    .filter(task => taskMatchesStaticFilters(task, filters))
    .map(task => ({
      events: eventGroups.get(task.id) ?? [],
      cursor: 0,
      state: null as ReplayState | null,
    }));

  for (
    let pointAt = addUtcDays(start, 1);
    pointAt <= lastCompletedDayEnd;
    pointAt = addUtcDays(pointAt, 1)
  ) {
    const counts = { todo: 0, inProgress: 0, done: 0, cancelled: 0 };
    let knownTasks = 0;

    for (const replay of replayTasks) {
      while (
        replay.cursor < replay.events.length
        && replay.events[replay.cursor].occurredAt < pointAt
      ) {
        const event = replay.events[replay.cursor++];
        if (event.eventType === 'baseline' && replay.state === null) {
          const value = parseBaseline(event.newValue);
          if (value && typeof value.status === 'string') {
            replay.state = {
              status: normalizeFlowStatus(value.status),
              projectIds: new Set(stringArray(value.projectIds)),
            };
          }
        } else if (replay.state) {
          if (event.eventType === 'status_changed' && event.newValue !== null) {
            replay.state.status = normalizeFlowStatus(event.newValue);
          } else if (event.eventType === 'project_added' && event.projectId) {
            replay.state.projectIds.add(event.projectId);
          } else if (event.eventType === 'project_removed' && event.projectId) {
            replay.state.projectIds.delete(event.projectId);
          }
        }
      }
      if (!replay.state || !stateMatchesProject(replay.state, filters)) continue;
      knownTasks++;
      if (replay.state.status === 'in_progress') counts.inProgress++;
      else counts[replay.state.status]++;
    }

    const coverage = !earliestBoundary || pointAt > latestBoundary!
      ? 'complete'
      : pointAt <= earliestBoundary
        ? 'unavailable'
        : 'partial';
    points.push({
      date: addUtcDays(pointAt, -1).slice(0, 10),
      ...counts,
      knownTasks,
      coverage,
    });
  }

  return { dimension: 'normalized_status', points };
}

function agingBuckets(items: AgingWipItem[]): AgingWipBucket[] {
  const buckets: AgingWipBucket[] = [
    { label: '< 3 days', count: 0, minDays: 0, maxDays: 3 },
    { label: '3-7 days', count: 0, minDays: 3, maxDays: 8 },
    { label: '8-14 days', count: 0, minDays: 8, maxDays: 15 },
    { label: '15-30 days', count: 0, minDays: 15, maxDays: 31 },
    { label: '> 30 days', count: 0, minDays: 31, maxDays: null },
  ];
  for (const item of items) {
    const bucket = buckets.find(candidate => (
      item.ageDays >= candidate.minDays
      && (candidate.maxDays === null || item.ageDays < candidate.maxDays)
    ));
    if (bucket) bucket.count++;
  }
  return buckets;
}

function computeAgingWip(
  tasks: FlowTaskInput[],
  eventGroups: Map<string, FlowHistoryEventInput[]>,
  now: string,
  filters: FlowFilters,
  staleThresholdDays: number,
): AgingWipReport {
  const items: AgingWipItem[] = [];
  let excludedWithoutEntry = 0;

  for (const task of tasks) {
    if (normalizeFlowStatus(task.status) !== 'in_progress') continue;
    if (!taskMatchesStaticFilters(task, filters)) continue;
    if (filters.projectId && !task.projectIds.includes(filters.projectId)) continue;

    const events = eventGroups.get(task.id) ?? [];
    const latestEntry = events
      .filter(event => (
        event.eventType === 'status_changed'
        && normalizeFlowStatus(event.previousValue) !== 'in_progress'
        && normalizeFlowStatus(event.newValue) === 'in_progress'
        && event.occurredAt < now
      ))
      .at(-1);
    if (!latestEntry) {
      excludedWithoutEntry++;
      continue;
    }

    const ageDays = roundDays((Date.parse(now) - Date.parse(latestEntry.occurredAt)) / DAY_MS);
    items.push({
      taskId: task.id,
      title: task.title,
      status: 'in_progress',
      enteredAt: latestEntry.occurredAt,
      ageDays,
      stale: ageDays >= staleThresholdDays,
      priority: task.priority,
      source: task.source,
    });
  }

  items.sort((a, b) => b.ageDays - a.ageDays || a.taskId.localeCompare(b.taskId));
  return {
    count: items.length,
    excludedWithoutEntry,
    medianAgeDays: percentile(items.map(item => item.ageDays), 0.5),
    staleCount: items.filter(item => item.stale).length,
    staleThresholdDays,
    items,
    buckets: agingBuckets(items),
  };
}

export function computeFlowReport(input: ComputeFlowReportInput): FlowReport {
  const filters = input.filters ?? {};
  const staleThresholdDays = Math.max(1, Math.round(input.staleThresholdDays ?? 14));
  const eventGroups = groupEvents(input.events);
  const migrationBoundaries = input.events
    .filter(event => event.eventType === 'baseline' && event.provenance === 'migration_baseline')
    .map(event => event.occurredAt)
    .sort();
  const historicalBoundaryAt = migrationBoundaries.at(-1) ?? null;

  return {
    start: input.start,
    end: input.end,
    generatedAt: input.now,
    historicalBoundaryAt,
    partialHistory: historicalBoundaryAt !== null && input.start < historicalBoundaryAt,
    cycleTime: computeCycleTime(
      input.tasks,
      eventGroups,
      input.start,
      input.end,
      input.now,
      filters,
    ),
    cumulativeFlow: computeCumulativeFlow(
      input.tasks,
      eventGroups,
      input.start,
      input.end,
      input.now,
      filters,
      migrationBoundaries,
    ),
    agingWip: computeAgingWip(
      input.tasks,
      eventGroups,
      input.now,
      filters,
      staleThresholdDays,
    ),
  };
}
