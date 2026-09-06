import { NextResponse } from 'next/server';
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
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type { TaskCoreTaskRow } from '@/lib/tasks/core/contracts';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const statusFilter = searchParams.get('status') || 'open';

    // Fetch scoring context
    const entities: PriorityEntity[] = await getResolvedPriorityEntities();

    // One snapshot read carries the candidate tasks plus every linkage the
    // scorer needs, so there is no N+1 fan-out behind this endpoint.
    const statusValues = statusFilter === 'open' ? ['todo', 'in_progress'] : [statusFilter];
    const persistence = await getTaskCorePersistence();
    const snapshot = await persistence.organization.readSmartScoreInputs({
      statuses: statusValues,
    });

    const rankings: SourceRanking[] = snapshot.sourceRankings.map((ranking) => ({
      id: ranking.id,
      connectorType: ranking.connectorType,
      name: ranking.name,
      rank: ranking.rank,
      updatedAt: ranking.updatedAt,
    }));
    const allTasks = snapshot.tasks;

    const tagsByTaskId = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of snapshot.taskTags) {
      const arr = tagsByTaskId.get(row.taskId) || [];
      arr.push({ id: row.tagId, name: row.tagName });
      tagsByTaskId.set(row.taskId, arr);
    }

    const projectsByTaskId = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of snapshot.taskProjects) {
      const arr = projectsByTaskId.get(row.taskId) || [];
      arr.push({ id: row.projectId, name: row.projectName });
      projectsByTaskId.set(row.taskId, arr);
    }

    const durationByTaskId = new Map(
      snapshot.estimatedDurations.map((row) => [row.taskId, row.estimatedDuration]),
    );

    // Build score inputs with linked entity names
    const scoreInputs = allTasks.map((task) => createScoreInput(
      {
        ...task,
        priority: task.priority as ScoreInputTask['priority'],
        estimatedDuration: durationByTaskId.get(task.id),
      },
      tagsByTaskId.get(task.id),
      projectsByTaskId.get(task.id),
    ));

    // Compute scores
    const scoredTasks = computeBatchSmartScores(scoreInputs, entities, rankings);

    // Limit results
    const limited = scoredTasks.slice(0, limit);
    const taskById = new Map(allTasks.map((t) => [t.id, t]));
    const limitedTasks = limited
      .map((scored) => taskById.get(scored.taskId))
      .filter((task): task is TaskCoreTaskRow => Boolean(task));
    const editPolicies = await resolveTaskEditPolicies(limitedTasks);

    // Enrich with task data — use a Map for O(1) lookup
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
          planningHorizon: task.planningHorizon,
          dueDate: task.dueDate,
          effort: task.effort,
          estimatedDuration: durationByTaskId.get(task.id) ?? null,
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
