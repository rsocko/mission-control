import { NextResponse } from 'next/server';
import { ExternalAgentError } from '@/lib/external-agents/errors';
import {
  externalAgentErrorResponse,
  requireAgentAuthentication,
} from '@/lib/external-agents/http';
import { claimNextDispatch, expireDispatches } from '@/lib/external-agents/service';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { agentId?: string; leaseMs?: number };
    if (!body.agentId) {
      throw new ExternalAgentError('agentId is required', 'VALIDATION_ERROR', 422);
    }
    const agent = await requireAgentAuthentication(request, body.agentId);
    if (agent.transport !== 'pull') {
      throw new ExternalAgentError('Agent does not use pull transport', 'TRANSPORT_INVALID', 409);
    }
    await expireDispatches();
    const claim = await claimNextDispatch(agent.id, { leaseMs: body.leaseMs });
    return claim
      ? NextResponse.json(claim)
      : new Response(null, { status: 204 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
