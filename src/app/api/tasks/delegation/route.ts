import { NextResponse } from 'next/server';
import {
  ExternalAgentError,
  isExternalAgentError,
} from '@/lib/external-agents/errors';
import {
  getTaskDelegationContext,
  hasTaskDelegationOperation,
  previewCombinedTaskDelegation,
  previewTaskDelegation,
  type TaskDelegationPreviewInput,
} from '@/lib/external-agents/task-delegation';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';

function taskIdsFromUrl(request: Request) {
  return new URL(request.url).searchParams.getAll('taskId');
}

export async function GET(request: Request) {
  try {
    return NextResponse.json(await getTaskDelegationContext(taskIdsFromUrl(request)));
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const body = await request.json() as Omit<
      TaskDelegationPreviewInput,
      'taskId' | 'callbackBaseUrl'
    > & {
      taskIds?: string[];
      strategy?: 'separate' | 'combined';
    };
    if (
      !Array.isArray(body.taskIds)
      || !body.taskIds.length
      || !body.agentId
      || !body.operationId?.trim()
      || (body.strategy !== undefined
        && body.strategy !== 'separate'
        && body.strategy !== 'combined')
    ) {
      throw new ExternalAgentError(
        'taskIds, agentId, operationId, and a valid strategy are required',
        'VALIDATION_ERROR',
        422,
      );
    }
    const taskIds = [...new Set(body.taskIds)];
    const context = await getTaskDelegationContext(taskIds);
    const target = context.targets.find(({ id }) => id === body.agentId);
    if (!target) {
      throw new ExternalAgentError(
        'Execution target is not configured',
        'NOT_FOUND',
        404,
      );
    }
    if (body.strategy === 'combined') {
      const dispatch = await previewCombinedTaskDelegation({
        ...body,
        taskIds,
        callbackBaseUrl: new URL(request.url).origin,
      });
      return NextResponse.json({
        previews: [{
          taskId: taskIds[0],
          taskIds,
          dispatchId: dispatch.id,
          previewHash: dispatch.previewHash,
          processingLocation: dispatch.executionLocality,
          dataClassification: dispatch.dataClassification,
          classificationExplanation: 'Combined payload uses the strictest classification required by the selected tasks',
          classificationSources: target.eligibility.flatMap(
            ({ classificationSources }) => classificationSources ?? [],
          ),
          disclosedFields: dispatch.disclosedFields,
          allowedActions: dispatch.allowedActions,
          payloadPreview: dispatch.payloadPreview,
        }],
        blocked: [],
        readyCount: taskIds.length,
        blockedCount: 0,
        dispatchCount: 1,
        strategy: 'combined',
        requiresConfirmation: true,
      }, { status: 201 });
    }
    const replayable = new Set<string>();
    for (const task of target.eligibility) {
      if (
        !task.ready
        && await hasTaskDelegationOperation(
          body.agentId,
          body.operationId.trim(),
          task.taskId,
        )
      ) {
        replayable.add(task.taskId);
      }
    }
    const eligible = target.eligibility.filter(
      ({ taskId, ready }) => ready || replayable.has(taskId),
    );
    const blocked: typeof target.eligibility = target.eligibility.filter(
      ({ taskId, ready }) => !ready && !replayable.has(taskId),
    );
    const previews = [];
    for (const task of eligible) {
      try {
        const dispatch = await previewTaskDelegation({
          ...body,
          taskId: task.taskId,
          repository: task.repositoryLocked ? task.repository ?? undefined : body.repository,
          callbackBaseUrl: new URL(request.url).origin,
        });
        previews.push({
          taskId: task.taskId,
          taskIds: [task.taskId],
          dispatchId: dispatch.id,
          previewHash: dispatch.previewHash,
          processingLocation: dispatch.executionLocality,
          dataClassification: dispatch.dataClassification,
          classificationExplanation: task.classificationExplanation
            ?? `${dispatch.dataClassification} source policy`,
          classificationSources: task.classificationSources ?? [],
          disclosedFields: dispatch.disclosedFields,
          allowedActions: dispatch.allowedActions,
          payloadPreview: dispatch.payloadPreview,
        });
      } catch (error) {
        if (!isExternalAgentError(error)) throw error;
        blocked.push({
          ...task,
          ready: false,
          blocker: error.message,
          errorCode: error.code,
          statusCode: error.status,
        });
      }
    }
    return NextResponse.json({
      previews,
      blocked,
      readyCount: previews.length,
      blockedCount: blocked.length,
      dispatchCount: previews.length,
      strategy: 'separate',
      requiresConfirmation: true,
    }, { status: 201 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
