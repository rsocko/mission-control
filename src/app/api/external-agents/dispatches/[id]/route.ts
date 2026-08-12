import { NextResponse } from 'next/server';
import {
  cancelDispatch,
  getDispatch,
  markDispatchWaiting,
  retryDispatch,
  reviewDispatchResult,
} from '@/lib/external-agents/service';
import {
  externalAgentErrorResponse,
  publicDispatch,
  requireTrustedMutation,
} from '@/lib/external-agents/http';
import { ExternalAgentError } from '@/lib/external-agents/errors';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    requireTrustedMutation(request);
    const dispatch = await getDispatch((await params).id);
    if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
    return NextResponse.json({ dispatch: publicDispatch(dispatch) });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    requireTrustedMutation(request);
    const id = (await params).id;
    const body = await request.json() as {
      action: 'cancel' | 'retry' | 'waiting_for_user' | 'accept' | 'reject' | 'partial';
      detail?: Record<string, unknown>;
    };
    let manualUrl: string | undefined;
    switch (body.action) {
      case 'cancel':
        cancelDispatch(id);
        break;
      case 'retry':
        ({ manualUrl } = await retryDispatch(id));
        break;
      case 'waiting_for_user':
        markDispatchWaiting(id, body.detail);
        break;
      case 'accept':
        reviewDispatchResult(id, 'accepted');
        break;
      case 'reject':
        reviewDispatchResult(id, 'rejected');
        break;
      case 'partial':
        reviewDispatchResult(id, 'partial');
        break;
      default:
        throw new ExternalAgentError('Unknown dispatch action', 'VALIDATION_ERROR', 422);
    }
    return NextResponse.json({
      dispatch: publicDispatch(await getDispatch(id)),
      manualUrl,
    });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
