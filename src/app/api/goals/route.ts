import { NextResponse } from 'next/server';
import { getAIWorkflowPersistence } from '@/lib/ai/workflow-persistence';
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
    const goalSlugs = filter === 'all'
      ? ['goal', 'idea', 'brainstorm']
      : [filter];

    const persistence = await getAIWorkflowPersistence();
    const goalTasks = await persistence.goalsBoard.listGoalTasks({
      tagSlugs: goalSlugs,
      projectId,
    });

    // Build enriched items
    const items = goalTasks.map(task => {
      const goalType = task.tags.find(t => t.slug === 'goal') ? 'goal'
        : task.tags.find(t => t.slug === 'idea') ? 'idea'
        : task.tags.find(t => t.slug === 'brainstorm') ? 'brainstorm'
        : 'idea';

      // Compute aggregate progress across all linked projects
      const totalTasks = task.linkedProjects.reduce((sum, p) => sum + p.totalTasks, 0);
      const doneTasks = task.linkedProjects.reduce((sum, p) => sum + p.doneTasks, 0);
      const overallProgress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

      return {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        goalType,
        tags: task.tags,
        linkedProjects: task.linkedProjects.map(p => ({
          ...p,
          progress: p.totalTasks > 0 ? Math.round((p.doneTasks / p.totalTasks) * 100) : 0,
        })),
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
    const counts = await persistence.goalsBoard.countGoalTags();

    return NextResponse.json({ items, counts });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch goals', error);
  }
}
