import { NextResponse } from 'next/server';
import { ExternalAgentError } from '@/lib/external-agents/errors';
import {
  getTaskDelegationContext,
  previewTaskDelegation,
  type TaskDelegationPreviewInput,
} from '@/lib/external-agents/task-delegation';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';
import { getExternalAgent, publicExternalAgent } from '@/lib/external-agents/registry';

type Context = { params: Promise<{ id: string }> };

function previewResponse(
  dispatch: Awaited<ReturnType<typeof previewTaskDelegation>>,
  agent: NonNullable<Awaited<ReturnType<typeof getExternalAgent>>>,
) {
  return {
    dispatchId: dispatch.id,
    taskId: dispatch.scope.taskIds?.[0],
    status: dispatch.status,
    agent: publicExternalAgent(agent),
    processingLocation: dispatch.executionLocality,
    dataClassification: dispatch.dataClassification,
    disclosedFields: dispatch.disclosedFields,
    allowedActions: dispatch.allowedActions,
    payloadPreview: dispatch.payloadPreview,
    previewHash: dispatch.previewHash,
    requiresConfirmation: true,
  };
}

export async function GET(_request: Request, { params }: Context) {
  try {
    return NextResponse.json(await getTaskDelegationContext((await params).id));
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    requireTrustedMutation(request);
    const taskId = (await params).id;
    const body = await request.json() as Omit<
      TaskDelegationPreviewInput,
      'taskId' | 'callbackBaseUrl'
    >;
    if (!body.agentId || !body.instruction?.trim() || !body.operationId?.trim()) {
      throw new ExternalAgentError(
        'agentId, instruction, and operationId are required',
        'VALIDATION_ERROR',
        422,
      );
    }
    const dispatch = await previewTaskDelegation({
      ...body,
      taskId,
      callbackBaseUrl: new URL(request.url).origin,
    });
    const agent = await getExternalAgent(dispatch.externalAgentId);
    if (!agent) throw new ExternalAgentError('External agent not found', 'NOT_FOUND', 404);
    return NextResponse.json(previewResponse(dispatch, agent), { status: 201 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
