import db from '@/db';
import { hubProjects, tasks, taskProjects, projectTags, tags } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { ProjectStatus, ProjectHealth, ProjectProgress, HubProject, Tag } from '@/types';

// ─── STATUS INFERENCE ───────────────────────────────────────────────────────

export function inferProjectStatus(progress: ProjectProgress, override?: ProjectStatus | null): ProjectStatus {
  if (override) return override;

  if (progress.totalTasks === 0) return 'not_started';
  if (progress.percentComplete === 100) return 'completed';
  if (progress.inProgressTasks > 0 || progress.completedTasks > 0) return 'active';
  return 'not_started';
}

export function inferHealth(
  targetDate: string | null | undefined,
  progress: ProjectProgress,
  overdueTasks: number
): ProjectHealth {
  const overduePercent = overdueTasks / Math.max(progress.totalTasks, 1);

  if (overduePercent > 0.3) return 'behind';
  if (overduePercent > 0.1) return 'at_risk';

  if (targetDate) {
    const target = new Date(targetDate);
    const now = new Date();
    const daysRemaining = (target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    // At risk if <20% of time left but <80% complete
    if (daysRemaining < 7 && progress.percentComplete < 80) return 'at_risk';
    if (daysRemaining < 0 && progress.percentComplete < 100) return 'behind';
  }

  return 'on_track';
}

// ─── PROGRESS COMPUTATION ───────────────────────────────────────────────────

export async function computeProjectProgress(projectId: string): Promise<ProjectProgress> {
  const projectTaskIds = await db
    .select({ taskId: taskProjects.taskId })
    .from(taskProjects)
    .where(eq(taskProjects.projectId, projectId));

  if (projectTaskIds.length === 0) {
    return { totalTasks: 0, completedTasks: 0, inProgressTasks: 0, percentComplete: 0, health: 'on_track' };
  }

  const ids = projectTaskIds.map(t => t.taskId);
  const projectTasks = await db
    .select({ status: tasks.status, updatedAt: tasks.updatedAt, parentId: tasks.parentId })
    .from(tasks)
    .where(inArray(tasks.id, ids));

  const topLevelTasks = topLevelProjectTasks(projectTasks);
  const totalTasks = topLevelTasks.length;
  const completedTasks = topLevelTasks.filter(t => t.status === 'done').length;
  const inProgressTasks = topLevelTasks.filter(t => t.status === 'in_progress').length;
  const percentComplete = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const lastActivity = topLevelTasks
    .map(t => t.updatedAt)
    .filter(Boolean)
    .sort()
    .reverse()[0] || undefined;

  // Health will be computed with project-level target date in the caller
  return { totalTasks, completedTasks, inProgressTasks, percentComplete, health: 'on_track', lastActivity };
}

// ─── FETCH TAGS FOR PROJECTS ──────────────────────────────────────────────

async function getProjectTagsMap(projectIds: string[]): Promise<Record<string, Tag[]>> {
  if (projectIds.length === 0) return {};

  const rows = await db
    .select({ projectId: projectTags.projectId, tag: tags })
    .from(projectTags)
    .innerJoin(tags, eq(projectTags.tagId, tags.id))
    .where(inArray(projectTags.projectId, projectIds));

  const map: Record<string, Tag[]> = {};
  for (const row of rows) {
    if (!map[row.projectId]) map[row.projectId] = [];
    map[row.projectId].push({
      id: row.tag.id,
      name: row.tag.name,
      slug: row.tag.slug,
      type: row.tag.type as Tag['type'],
      source: row.tag.source || undefined,
      color: row.tag.color || undefined,
      confirmed: row.tag.confirmed,
      createdAt: row.tag.createdAt,
    });
  }
  return map;
}

// ─── PROJECTS OVERVIEW AGGREGATION ──────────────────────────────────────────

export interface CategoryGroup {
  category: string;
  projects: (HubProject & { progress: ProjectProgress })[];
}

export interface ProjectsOverview {
  categories: CategoryGroup[];
  uncategorized: (HubProject & { progress: ProjectProgress })[];
  recentProjects: RecentProject[];
  recentCompletedItems: RecentCompletedItem[];
  summary: {
    totalProjects: number;
    activeProjects: number;
    completedProjects: number;
    atRiskProjects: number;
    totalTasks: number;
    completedTasks: number;
    inProgressTasks: number;
    portfolioPercent: number;
    completedThisWeek: number;
  };
}

export interface OverviewTask {
  id: string;
  title: string;
  status: string;
  parentId: string | null;
  dueDate: string | null;
  updatedAt: string;
  completedAt: string | null;
}

export type OverviewProject = HubProject & { progress: ProjectProgress };

export interface RecentProject {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  category: string | null;
  status: ProjectStatus;
  targetDate: string | null;
  progress: ProjectProgress;
  nextTask: { id: string; title: string } | null;
}

export interface RecentCompletedItem {
  taskId: string;
  title: string;
  completedAt: string;
  projectId: string;
  projectName: string;
  projectColor: string;
}

export function topLevelProjectTasks<T extends { parentId: string | null }>(projectTasks: T[]): T[] {
  return projectTasks.filter(task => task.parentId === null);
}

export function buildPortfolioPulse(
  projects: OverviewProject[],
  projectTaskIdsMap: Map<string, string[]>,
  taskMap: Map<string, OverviewTask>,
  now = new Date(),
) {
  const uniqueTasks = [...taskMap.values()].filter(task => task.status !== 'cancelled');
  const totalTasks = uniqueTasks.length;
  const completedTasks = uniqueTasks.filter(task => task.status === 'done').length;
  const inProgressTasks = uniqueTasks.filter(task => task.status === 'in_progress').length;
  const portfolioPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const weekStart = new Date(now);
  const daysSinceMonday = (weekStart.getDay() + 6) % 7;
  weekStart.setDate(weekStart.getDate() - daysSinceMonday);
  weekStart.setHours(0, 0, 0, 0);

  const completedThisWeek = uniqueTasks.filter(task => (
    task.status === 'done'
    && task.completedAt
    && new Date(task.completedAt) >= weekStart
    && new Date(task.completedAt) <= now
  )).length;

  const recentProjects = projects
    .filter(project => project.status !== 'completed' && project.status !== 'cancelled')
    .sort((a, b) => {
      const aActivity = Date.parse(a.progress.lastActivity || a.updatedAt) || 0;
      const bActivity = Date.parse(b.progress.lastActivity || b.updatedAt) || 0;
      return bActivity - aActivity;
    })
    .slice(0, 3)
    .map((project): RecentProject => {
      const nextTask = (projectTaskIdsMap.get(project.id) || [])
        .map(taskId => taskMap.get(taskId))
        .filter((task): task is OverviewTask => task !== undefined && task.status !== 'done' && task.status !== 'cancelled')
        .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0];

      return {
        id: project.id,
        name: project.name,
        color: project.color,
        icon: project.icon ?? null,
        category: project.category ?? null,
        status: project.status,
        targetDate: project.targetDate ?? null,
        progress: project.progress,
        nextTask: nextTask ? { id: nextTask.id, title: nextTask.title } : null,
      };
    });

  const completedItemCandidates = projects
    .flatMap((project) => (projectTaskIdsMap.get(project.id) || [])
      .map(taskId => taskMap.get(taskId))
      .filter((task): task is OverviewTask & { completedAt: string } => (
        Boolean(task?.completedAt) && task?.status === 'done'
      ))
      .map((task): RecentCompletedItem => ({
        taskId: task.id,
        title: task.title,
        completedAt: task.completedAt,
        projectId: project.id,
        projectName: project.name,
        projectColor: project.color,
      })))
    .sort((a, b) => (Date.parse(b.completedAt) || 0) - (Date.parse(a.completedAt) || 0));

  const seenCompletedTaskIds = new Set<string>();
  const recentCompletedItems = completedItemCandidates
    .filter((item) => {
      if (seenCompletedTaskIds.has(item.taskId)) return false;
      seenCompletedTaskIds.add(item.taskId);
      return true;
    })
    .slice(0, 6);

  return {
    recentProjects,
    recentCompletedItems,
    taskSummary: {
      totalTasks,
      completedTasks,
      inProgressTasks,
      portfolioPercent,
      completedThisWeek,
    },
  };
}

export async function getProjectsOverview(): Promise<ProjectsOverview> {
  // Fetch all visible projects (exclude hidden)
  const allProjects = (await db.select().from(hubProjects).orderBy(hubProjects.sortOrder, hubProjects.name))
    .filter(p => !p.hidden);

  if (allProjects.length === 0) {
    return {
      categories: [],
      uncategorized: [],
      recentProjects: [],
      recentCompletedItems: [],
      summary: {
        totalProjects: 0,
        activeProjects: 0,
        completedProjects: 0,
        atRiskProjects: 0,
        totalTasks: 0,
        completedTasks: 0,
        inProgressTasks: 0,
        portfolioPercent: 0,
        completedThisWeek: 0,
      },
    };
  }

  const projectIds = allProjects.map(p => p.id);

  // Batch: fetch all task-project mappings in one query
  const allProjectTaskRows = await db
    .select({ projectId: taskProjects.projectId, taskId: taskProjects.taskId })
    .from(taskProjects)
    .where(inArray(taskProjects.projectId, projectIds));

  // Collect all unique task IDs and batch-fetch task data
  const allTaskIds = [...new Set(allProjectTaskRows.map(r => r.taskId))];
  const allTaskData = allTaskIds.length > 0
    ? await db
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          parentId: tasks.parentId,
          dueDate: tasks.dueDate,
          updatedAt: tasks.updatedAt,
          completedAt: tasks.completedAt,
        })
        .from(tasks)
        .where(inArray(tasks.id, allTaskIds))
    : [];

  // Build lookup maps
  const taskMap = new Map(topLevelProjectTasks(allTaskData).map(t => [t.id, t]));
  const projectTaskIdsMap = new Map<string, string[]>();
  for (const row of allProjectTaskRows) {
    if (!projectTaskIdsMap.has(row.projectId)) projectTaskIdsMap.set(row.projectId, []);
    projectTaskIdsMap.get(row.projectId)!.push(row.taskId);
  }

  const now = new Date();

  // Compute progress for all projects using pre-fetched data
  const projectsWithProgress = allProjects.map((project) => {
    const taskIds = projectTaskIdsMap.get(project.id) || [];
    const projectTasks = taskIds.map(id => taskMap.get(id)).filter(Boolean) as typeof allTaskData;

    const totalTasks = projectTasks.length;
    const completedTasks = projectTasks.filter(t => t.status === 'done').length;
    const inProgressTasks = projectTasks.filter(t => t.status === 'in_progress').length;
    const percentComplete = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    const overdueTasks = projectTasks.filter(
      t => t.dueDate && new Date(t.dueDate) < now && t.status !== 'done' && t.status !== 'cancelled'
    ).length;

    const lastActivity = projectTasks
      .map(t => t.updatedAt)
      .filter(Boolean)
      .sort()
      .reverse()[0] || undefined;

    const progress: ProjectProgress = {
      totalTasks, completedTasks, inProgressTasks, percentComplete,
      health: 'on_track', lastActivity,
    };
    progress.health = inferHealth(project.targetDate, progress, overdueTasks);

    const status = inferProjectStatus(progress, project.statusOverride as ProjectStatus | null);

    return { ...project, status, progress };
  });

  // Get tags (already batched)
  const projectTagsMap = await getProjectTagsMap(projectIds);

  // Enrich with tags
  const enrichedProjects = projectsWithProgress.map(p => ({
    ...p,
    tags: projectTagsMap[p.id] || [],
    sourceBindings: (p.sourceBindings as unknown) || [],
    autoIncludeRules: (p.autoIncludeRules as unknown) || [],
    kanbanColumns: (p.kanbanColumns as unknown) || [],
    metadata: (p.metadata as Record<string, unknown>) || {},
  })) as unknown as (HubProject & { progress: ProjectProgress })[];

  // Group by category
  const categoryMap = new Map<string, (HubProject & { progress: ProjectProgress })[]>();
  const uncategorized: (HubProject & { progress: ProjectProgress })[] = [];

  for (const project of enrichedProjects) {
    if (project.category) {
      if (!categoryMap.has(project.category)) categoryMap.set(project.category, []);
      categoryMap.get(project.category)!.push(project);
    } else {
      uncategorized.push(project);
    }
  }

  const categories: CategoryGroup[] = [...categoryMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, projects]) => ({ category, projects }));

  // Summary stats
  const activeProjects = enrichedProjects.filter(p => p.status === 'active').length;
  const completedProjects = enrichedProjects.filter(p => p.status === 'completed').length;
  const atRiskProjects = enrichedProjects.filter(p => p.progress.health !== 'on_track').length;
  const pulse = buildPortfolioPulse(
    enrichedProjects as OverviewProject[],
    projectTaskIdsMap,
    taskMap as Map<string, OverviewTask>,
    now,
  );

  return {
    categories,
    uncategorized,
    recentProjects: pulse.recentProjects,
    recentCompletedItems: pulse.recentCompletedItems,
    summary: {
      totalProjects: enrichedProjects.length,
      activeProjects,
      completedProjects,
      atRiskProjects,
      ...pulse.taskSummary,
    },
  };
}
