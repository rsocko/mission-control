import { NextResponse } from 'next/server';
import { ExternalAgentError } from '@/lib/external-agents/errors';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';
import {
  submitDispatchResult,
  type DispatchResultInput,
} from '@/lib/external-agents/service';

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const body = await request.json() as DispatchResultInput & { dispatchId?: string };
    if (!body.dispatchId) {
      throw new ExternalAgentError('dispatchId is required', 'VALIDATION_ERROR', 422);
    }
    const { dispatchId, ...result } = body;
    const processed = submitDispatchResult(
      dispatchId,
      result,
      { agentAuthenticated: true },
    );
    return NextResponse.json(processed, { status: processed.duplicate ? 200 : 202 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
