import { NextResponse } from 'next/server';
import { ExternalAgentError } from '@/lib/external-agents/errors';
import {
  getTaskDelegationContext,
  hasTaskDelegationOperation,
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
    > & { taskIds?: string[] };
    if (
      !Array.isArray(body.taskIds)
      || !body.taskIds.length
      || !body.agentId
      || !body.instruction?.trim()
      || !body.operationId?.trim()
    ) {
      throw new ExternalAgentError(
        'taskIds, agentId, instruction, and operationId are required',
        'VALIDATION_ERROR',
        422,
      );
    }
    const context = await getTaskDelegationContext(body.taskIds);
    const target = context.targets.find(({ id }) => id === body.agentId);
    if (!target) {
      throw new ExternalAgentError(
        'Execution target is not configured',
        'NOT_FOUND',
        404,
      );
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
    const blocked = target.eligibility.filter(
      ({ taskId, ready }) => !ready && !replayable.has(taskId),
    );
    const previews = [];
    for (const task of eligible) {
      const dispatch = await previewTaskDelegation({
        ...body,
        taskId: task.taskId,
        repository: task.repositoryLocked ? task.repository ?? undefined : body.repository,
        callbackBaseUrl: new URL(request.url).origin,
      });
      previews.push({
        taskId: task.taskId,
        dispatchId: dispatch.id,
        previewHash: dispatch.previewHash,
        processingLocation: dispatch.executionLocality,
        dataClassification: dispatch.dataClassification,
        disclosedFields: dispatch.disclosedFields,
        allowedActions: dispatch.allowedActions,
        payloadPreview: dispatch.payloadPreview,
      });
    }
    return NextResponse.json({
      previews,
      blocked,
      readyCount: previews.length,
      blockedCount: blocked.length,
      requiresConfirmation: true,
    }, { status: 201 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
