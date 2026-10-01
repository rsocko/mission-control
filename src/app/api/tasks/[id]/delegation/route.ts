import { NextResponse } from 'next/server';
import { ExternalAgentError } from '@/lib/external-agents/errors';
import {
  getTaskDelegationContext,
  previewTaskDelegation,
} from '@/lib/external-agents/task-delegation';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';
import { getExternalAgent, publicExternalAgent } from '@/lib/external-agents/registry';

type Context = { params: Promise<{ id: string }> };

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
    const body = await request.json() as {
      agentId?: string;
      instruction?: string;
      allowedActions?: string[];
      idempotencyKey?: string;
    };
    const idempotencyKey = request.headers.get('idempotency-key') ?? body.idempotencyKey;
    if (!body.agentId || !body.instruction || !idempotencyKey) {
      throw new ExternalAgentError(
        'agentId, instruction, and an idempotency key are required',
        'VALIDATION_ERROR',
        422,
      );
    }
    const dispatch = await previewTaskDelegation({
      taskId,
      agentId: body.agentId,
      instruction: body.instruction,
      allowedActions: body.allowedActions,
      idempotencyKey,
      callbackBaseUrl: new URL(request.url).origin,
    });
    const agent = await getExternalAgent(dispatch.externalAgentId);
    if (!agent) throw new ExternalAgentError('External agent not found', 'NOT_FOUND', 404);
    return NextResponse.json({
      dispatchId: dispatch.id,
      status: dispatch.status,
      agent: publicExternalAgent(agent),
      processingLocation: dispatch.executionLocality,
      dataClassification: dispatch.dataClassification,
      disclosedFields: dispatch.disclosedFields,
      allowedActions: dispatch.allowedActions,
      payloadPreview: dispatch.payloadPreview,
      previewHash: dispatch.previewHash,
      requiresConfirmation: true,
    }, { status: 201 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
