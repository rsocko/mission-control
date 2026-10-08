import { NextResponse } from 'next/server';
import {
  cancelDispatch,
  getDispatch,
  markDispatchWaiting,
  requestDispatchReconciliation,
  resolveDispatchInteraction,
  retryDispatch,
  stopTrackingDispatch,
  reviewDispatchResult,
} from '@/lib/external-agents/service';
import {
  externalAgentErrorResponse,
  publicDispatch,
  requireTrustedMutation,
} from '@/lib/external-agents/http';
import { ExternalAgentError } from '@/lib/external-agents/errors';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const id = (await params).id;
    const dispatch = await getDispatch(id);
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
      action:
        | 'cancel'
        | 'refresh'
        | 'stop_tracking'
        | 'retry'
        | 'waiting_for_user'
        | 'resolve_interaction'
        | 'accept'
        | 'reject'
        | 'partial';
      detail?: Record<string, unknown>;
      interactionId?: string;
      outcome?: 'answered' | 'approved' | 'rejected';
      answer?: string;
    };
    let accepted = false;
    switch (body.action) {
      case 'refresh':
        accepted = await requestDispatchReconciliation(id);
        break;
      case 'cancel':
        await cancelDispatch(id);
        break;
      case 'stop_tracking':
        await stopTrackingDispatch(id);
        break;
      case 'retry':
        await retryDispatch(id);
        accepted = true;
        break;
      case 'waiting_for_user':
        await markDispatchWaiting(id, body.detail);
        break;
      case 'resolve_interaction':
        if (!body.interactionId || !body.outcome) {
          throw new ExternalAgentError(
            'interactionId and outcome are required',
            'VALIDATION_ERROR',
            422,
          );
        }
        await resolveDispatchInteraction(id, {
          interactionId: body.interactionId,
          outcome: body.outcome,
          answer: body.answer,
        });
        break;
      case 'accept':
        await reviewDispatchResult(id, 'accepted');
        break;
      case 'reject':
        await reviewDispatchResult(id, 'rejected');
        break;
      case 'partial':
        await reviewDispatchResult(id, 'partial');
        break;
      default:
        throw new ExternalAgentError('Unknown dispatch action', 'VALIDATION_ERROR', 422);
    }
    return NextResponse.json({
      dispatch: publicDispatch(await getDispatch(id)),
      accepted,
    }, { status: accepted ? 202 : 200 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
