import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, tags, taskTags, hubProjects, taskProjects, projectMilestones } from '@/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/goals — Fetch tasks tagged with #goal, #idea, or #brainstorm
 * Query params:
 *   ?filter=all|goal|idea|brainstorm (default: all)
 *   ?project=<projectId> (filter by linked project)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filter = searchParams.get('filter') || 'all';
  const projectId = searchParams.get('project');

  try {
    // Find relevant tag slugs
    const goalSlugs = filter === 'all'
      ? ['goal', 'idea', 'brainstorm']
      : [filter];

    const matchingTags = await db.select()
      .from(tags)
      .where(inArray(tags.slug, goalSlugs));

    if (matchingTags.length === 0) {
      return NextResponse.json({ items: [], counts: { goal: 0, idea: 0, brainstorm: 0 } });
    }

    const tagIds = matchingTags.map(t => t.id);

    // Get task IDs that have these tags
    const taggedTaskIds = await db.select({ taskId: taskTags.taskId })
      .from(taskTags)
      .where(inArray(taskTags.tagId, tagIds));

    if (taggedTaskIds.length === 0) {
      return NextResponse.json({ items: [], counts: { goal: 0, idea: 0, brainstorm: 0 } });
    }

    const taskIds = taggedTaskIds.map(r => r.taskId);

    // If filtering by project, intersect with project tasks
    let filteredTaskIds = taskIds;
    if (projectId) {
      const projectTaskIds = await db.select({ taskId: taskProjects.taskId })
        .from(taskProjects)
        .where(and(
          eq(taskProjects.projectId, projectId),
          inArray(taskProjects.taskId, taskIds)
        ));
      filteredTaskIds = projectTaskIds.map(r => r.taskId);
    }

    if (filteredTaskIds.length === 0) {
      return NextResponse.json({ items: [], counts: { goal: 0, idea: 0, brainstorm: 0 } });
    }

    // Fetch full tasks
    const goalTasks = await db.select()
      .from(tasks)
      .where(inArray(tasks.id, filteredTaskIds));

    // Enrich with tags and project info
    const allTaskTags = await db.select({
      taskId: taskTags.taskId,
      tagId: taskTags.tagId,
      tagName: tags.name,
      tagSlug: tags.slug,
      tagColor: tags.color,
      tagType: tags.type,
    })
      .from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .where(inArray(taskTags.taskId, filteredTaskIds));

    const allTaskProjects = await db.select({
      taskId: taskProjects.taskId,
      projectId: taskProjects.projectId,
      projectName: hubProjects.name,
      projectColor: hubProjects.color,
      projectIcon: hubProjects.icon,
    })
      .from(taskProjects)
      .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
      .where(inArray(taskProjects.taskId, filteredTaskIds));

    // Fetch milestones and task counts for linked projects
    const linkedProjectIds = [...new Set(allTaskProjects.map(tp => tp.projectId))];
    let projectMilestonesData: Array<{ id: string; projectId: string; name: string; targetDate: string | null; completedAt: string | null; sortOrder: number }> = [];
    const projectTaskStats: Map<string, { total: number; done: number }> = new Map();

    if (linkedProjectIds.length > 0) {
      projectMilestonesData = await db.select()
        .from(projectMilestones)
        .where(inArray(projectMilestones.projectId, linkedProjectIds));

      // Get task completion stats per project
      const projectTaskCounts = await db.select({
        projectId: taskProjects.projectId,
        total: sql<number>`count(*)`,
        done: sql<number>`sum(case when ${tasks.status} = 'done' then 1 else 0 end)`,
      })
        .from(taskProjects)
        .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
        .where(inArray(taskProjects.projectId, linkedProjectIds))
        .groupBy(taskProjects.projectId);

      for (const row of projectTaskCounts) {
        projectTaskStats.set(row.projectId, { total: row.total, done: row.done ?? 0 });
      }
    }

    // Build enriched items
    const items = goalTasks.map(task => {
      const taskTagList = allTaskTags
        .filter(tt => tt.taskId === task.id)
        .map(tt => ({
          id: tt.tagId,
          name: tt.tagName,
          slug: tt.tagSlug,
          color: tt.tagColor,
          type: tt.tagType,
        }));

      const linkedProjects = allTaskProjects
        .filter(tp => tp.taskId === task.id)
        .map(tp => {
          const stats = projectTaskStats.get(tp.projectId);
          const milestones = projectMilestonesData
            .filter(m => m.projectId === tp.projectId)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map(m => ({
              id: m.id,
              name: m.name,
              targetDate: m.targetDate,
              completed: !!m.completedAt,
            }));
          return {
            id: tp.projectId,
            name: tp.projectName,
            color: tp.projectColor,
            icon: tp.projectIcon,
            totalTasks: stats?.total ?? 0,
            doneTasks: stats?.done ?? 0,
            progress: stats && stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
            milestones,
          };
        });

      // Determine the goal type based on tags
      const goalType = taskTagList.find(t => t.slug === 'goal') ? 'goal'
        : taskTagList.find(t => t.slug === 'idea') ? 'idea'
        : taskTagList.find(t => t.slug === 'brainstorm') ? 'brainstorm'
        : 'idea';

      // Compute aggregate progress across all linked projects
      const totalTasks = linkedProjects.reduce((sum, p) => sum + p.totalTasks, 0);
      const doneTasks = linkedProjects.reduce((sum, p) => sum + p.doneTasks, 0);
      const overallProgress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

      return {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        goalType,
        tags: taskTagList,
        linkedProjects,
        progress: overallProgress,
        totalTasks,
        doneTasks,
        dueDate: task.dueDate,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        connectorType: task.connectorType,
      };
    });

    // Sort: goals first, then ideas, then brainstorms; within each, newest first
    const typeOrder = { goal: 0, idea: 1, brainstorm: 2 };
    items.sort((a, b) => {
      const typeDiff = (typeOrder[a.goalType as keyof typeof typeOrder] ?? 1)
        - (typeOrder[b.goalType as keyof typeof typeOrder] ?? 1);
      if (typeDiff !== 0) return typeDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // Compute counts (always across all, regardless of filter)
    const allTagsForCounts = await db.select({
      taskId: taskTags.taskId,
      tagSlug: tags.slug,
    })
      .from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .where(inArray(tags.slug, ['goal', 'idea', 'brainstorm']));

    const uniqueGoals = new Set(allTagsForCounts.filter(r => r.tagSlug === 'goal').map(r => r.taskId));
    const uniqueIdeas = new Set(allTagsForCounts.filter(r => r.tagSlug === 'idea').map(r => r.taskId));
    const uniqueBrainstorms = new Set(allTagsForCounts.filter(r => r.tagSlug === 'brainstorm').map(r => r.taskId));

    return NextResponse.json({
      items,
      counts: {
        goal: uniqueGoals.size,
        idea: uniqueIdeas.size,
        brainstorm: uniqueBrainstorms.size,
      },
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch goals', error);
  }
}
