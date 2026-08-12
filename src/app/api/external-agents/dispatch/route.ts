import { NextResponse } from 'next/server';
import { getExternalAgent, publicExternalAgent } from '@/lib/external-agents/registry';
import {
  confirmDispatch,
  createDispatchPreview,
  type DispatchPreviewInput,
} from '@/lib/external-agents/service';
import {
  externalAgentErrorResponse,
  publicDispatch,
  requireTrustedMutation,
} from '@/lib/external-agents/http';
import { ExternalAgentError } from '@/lib/external-agents/errors';

interface ConfirmRequest {
  dispatchId: string;
  previewHash: string;
  confirm: true;
}

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const body = await request.json() as DispatchPreviewInput | ConfirmRequest;
    if ('confirm' in body && body.confirm === true) {
      const result = await confirmDispatch(body.dispatchId, body.previewHash);
      return NextResponse.json({
        dispatch: publicDispatch(result.dispatch),
        manualUrl: result.manualUrl,
      });
    }
    const idempotencyKey = request.headers.get('idempotency-key')
      ?? (body as DispatchPreviewInput).idempotencyKey;
    if (!idempotencyKey) {
      throw new ExternalAgentError(
        'An Idempotency-Key header or idempotencyKey field is required',
        'VALIDATION_ERROR',
        422,
      );
    }
    const origin = new URL(request.url).origin;
    const dispatch = await createDispatchPreview({
      ...(body as DispatchPreviewInput),
      idempotencyKey,
      callbackBaseUrl: origin,
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
      payloadPreview: dispatch.payloadPreview,
      previewHash: dispatch.previewHash,
      requiresConfirmation: true,
    }, { status: 201 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
