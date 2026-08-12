import { NextResponse } from 'next/server';
import { ExternalAgentError } from '@/lib/external-agents/errors';
import {
  externalAgentErrorResponse,
  requireAgentAuthentication,
} from '@/lib/external-agents/http';
import {
  getDispatch,
  submitDispatchResult,
  type DispatchResultInput,
} from '@/lib/external-agents/service';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    const id = (await params).id;
    const dispatch = await getDispatch(id);
    if (!dispatch) throw new ExternalAgentError('Dispatch not found', 'NOT_FOUND', 404);
    const claimToken = request.headers.get('x-mc-claim-token') ?? undefined;
    let agentAuthenticated = false;
    if (dispatch.transport !== 'pull') {
      await requireAgentAuthentication(request, dispatch.externalAgentId);
      agentAuthenticated = true;
    }
    const result = submitDispatchResult(
      id,
      await request.json() as DispatchResultInput,
      { claimToken, agentAuthenticated },
    );
    return NextResponse.json(result, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
