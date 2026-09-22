import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { FlowAnalyticsRepository } from '@/db/persistence/analytics';
import {
  computeFlowReport,
  type FlowFilters,
  type FlowReport,
  type FlowTaskInput,
} from '@/lib/stats/flow';

export interface FlowProjectOption {
  id: string;
  name: string;
  color: string;
}

export interface FlowFilterOptions {
  projects: FlowProjectOption[];
  sources: string[];
  priorities: string[];
  statuses: string[];
}

export interface FlowInsightsResult extends FlowReport {
  filterOptions: FlowFilterOptions;
}

export interface FlowInsightsQuery {
  start: string;
  end: string;
  now?: string;
  staleThresholdDays?: number;
  filters?: FlowFilters;
}

const FLOW_EVENT_TYPES = [
  'baseline',
  'status_changed',
  'reopened',
  'project_added',
  'project_removed',
] as const;

async function flowRepository(): Promise<FlowAnalyticsRepository> {
  return (await getWorkerPersistenceRepositories()).analytics.flow;
}

export async function computeFlowInsights(query: FlowInsightsQuery): Promise<FlowInsightsResult> {
  const now = query.now ?? new Date().toISOString();
  const repository = await flowRepository();
  const [taskRows, membershipRows, projectRows, events] = await Promise.all([
    repository.listFlowTasks(),
    repository.listTaskProjectMemberships(),
    repository.listVisibleProjects(),
    repository.listTaskTransitions(
      { startInclusive: '0001-01-01T00:00:00.000Z', endExclusive: now },
      FLOW_EVENT_TYPES,
    ),
  ]);

  const projectIdsByTask = new Map<string, string[]>();
  for (const membership of membershipRows) {
    const projectIds = projectIdsByTask.get(membership.taskId);
    if (projectIds) projectIds.push(membership.projectId);
    else projectIdsByTask.set(membership.taskId, [membership.projectId]);
  }

  const flowTasks: FlowTaskInput[] = taskRows.map(task => ({
    ...task,
    projectIds: projectIdsByTask.get(task.id) ?? [],
  }));
  const report = computeFlowReport({
    tasks: flowTasks,
    events,
    start: query.start,
    end: query.end,
    now,
    staleThresholdDays: query.staleThresholdDays,
    filters: query.filters,
  });

  return {
    ...report,
    filterOptions: {
      projects: projectRows,
      sources: [...new Set(taskRows.map(task => task.source))].sort(),
      priorities: [...new Set(taskRows.map(task => task.priority))].sort(),
      statuses: [...new Set(taskRows.map(task => task.status))].sort(),
    },
  };
}
