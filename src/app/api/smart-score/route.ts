import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, taskTags, tags, taskProjects, hubProjects, sourceRankings } from '@/db/schema';
import { asc, eq, inArray } from 'drizzle-orm';
import {
  computeBatchSmartScores,
  createScoreInput,
  type PriorityEntity,
  type ScoreInputTask,
  type SourceRanking,
} from '@/lib/smart-score';
import { ApiErrors } from '@/lib/api-error';
import { getResolvedPriorityEntities } from '@/lib/priority-entities';
import { requireTaskEditPolicy, resolveTaskEditPolicies } from '@/lib/tasks/edit-policy';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const statusFilter = searchParams.get('status') || 'open';

    // Fetch scoring context
    const entities: PriorityEntity[] = getResolvedPriorityEntities();
    const rankings: SourceRanking[] = db.select().from(sourceRankings).orderBy(asc(sourceRankings.rank)).all() as SourceRanking[];

    // Fetch open tasks
    const statusValues = statusFilter === 'open' ? ['todo', 'in_progress'] : [statusFilter];
    const allTasks = db.select().from(tasks).where(
      inArray(tasks.status, statusValues)
    ).all();

    const taskIds = allTasks.map((t) => t.id);

    // Batch-fetch all tag names for matching tasks (avoids N+1)
    const allTaskTags = taskIds.length > 0
      ? db.select({
          taskId: taskTags.taskId,
          tagId: tags.id,
          unifiedInto: tags.unifiedInto,
          tagName: tags.name,
        })
          .from(taskTags)
          .innerJoin(tags, eq(taskTags.tagId, tags.id))
          .where(inArray(taskTags.taskId, taskIds))
          .all()
      : [];
    const tagsByTaskId = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of allTaskTags) {
      const arr = tagsByTaskId.get(row.taskId) || [];
      arr.push({ id: row.unifiedInto || row.tagId, name: row.tagName });
      tagsByTaskId.set(row.taskId, arr);
    }

    // Batch-fetch all project names for matching tasks (avoids N+1)
    const allTaskProjects = taskIds.length > 0
      ? db.select({ taskId: taskProjects.taskId, projectId: hubProjects.id, projectName: hubProjects.name })
          .from(taskProjects)
          .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
          .where(inArray(taskProjects.taskId, taskIds))
          .all()
      : [];
    const projectsByTaskId = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of allTaskProjects) {
      const arr = projectsByTaskId.get(row.taskId) || [];
      arr.push({ id: row.projectId, name: row.projectName });
      projectsByTaskId.set(row.taskId, arr);
    }

    // Build score inputs with linked entity names
    const scoreInputs = allTasks.map((task) => createScoreInput(
      { ...task, priority: task.priority as ScoreInputTask['priority'] },
      tagsByTaskId.get(task.id),
      projectsByTaskId.get(task.id),
    ));

    // Compute scores
    const scoredTasks = computeBatchSmartScores(scoreInputs, entities, rankings);

    // Limit results
    const limited = scoredTasks.slice(0, limit);
    const limitedTasks = limited
      .map((scored) => allTasks.find((task) => task.id === scored.taskId))
      .filter((task): task is (typeof allTasks)[number] => Boolean(task));
    const editPolicies = await resolveTaskEditPolicies(limitedTasks);

    // Enrich with task data — use a Map for O(1) lookup
    const taskById = new Map(allTasks.map((t) => [t.id, t]));
    const results = limited.map((scored) => {
      const task = taskById.get(scored.taskId);
      return {
        ...scored,
        task: task ? {
          id: task.id,
          title: task.title,
          status: task.status,
          microStatus: task.microStatus,
          priority: task.priority,
          dueDate: task.dueDate,
          effort: task.effort,
          connectorType: task.connectorType,
          sourceListName: task.sourceListName,
          updatedAt: task.updatedAt,
          editPolicy: requireTaskEditPolicy(editPolicies, task.id),
        } : null,
      };
    });

    return NextResponse.json({
      scores: results,
      total: scoredTasks.length,
      hasEntities: entities.length > 0,
      hasSourceRankings: rankings.length > 0,
    });
  } catch (error) {
    return ApiErrors.internal('Failed to compute smart scores', error);
  }
}
