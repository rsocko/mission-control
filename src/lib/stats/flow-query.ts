import db from '@/db';
import { getTaskTransitionsInRange } from '@/db/task-history';
import { hubProjects, taskProjects, tasks } from '@/db/schema';
import { asc, eq } from 'drizzle-orm';
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

export async function computeFlowInsights(query: FlowInsightsQuery): Promise<FlowInsightsResult> {
  const now = query.now ?? new Date().toISOString();
  const [taskRows, membershipRows, projectRows, events] = await Promise.all([
    db.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      source: tasks.connectorType,
    }).from(tasks).where(eq(tasks.isChecklistItem, false)),
    db.select().from(taskProjects),
    db.select({
      id: hubProjects.id,
      name: hubProjects.name,
      color: hubProjects.color,
    }).from(hubProjects).where(eq(hubProjects.hidden, false)).orderBy(asc(hubProjects.name)),
    getTaskTransitionsInRange({
      start: '0001-01-01T00:00:00.000Z',
      end: now,
      eventTypes: [
        'baseline',
        'status_changed',
        'reopened',
        'project_added',
        'project_removed',
      ],
    }),
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
