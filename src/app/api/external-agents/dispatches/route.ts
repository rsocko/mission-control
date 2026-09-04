import { NextResponse } from 'next/server';
import type { AgentDispatchStatus } from '@/db/schema';
import {
  cleanupExpiredDispatches,
  expireDispatches,
  listDispatches,
} from '@/lib/external-agents/service';
import {
  externalAgentErrorResponse,
  publicDispatch,
  requireTrustedMutation,
} from '@/lib/external-agents/http';

export async function GET(request: Request) {
  try {
    requireTrustedMutation(request);
    await expireDispatches();
    const params = new URL(request.url).searchParams;
    return NextResponse.json({
      dispatches: (await listDispatches({
        status: params.get('status') as AgentDispatchStatus | undefined,
        agentId: params.get('agentId') ?? undefined,
        limit: params.get('limit') ? Number(params.get('limit')) : undefined,
      })).map(publicDispatch),
    });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    requireTrustedMutation(request);
    return NextResponse.json({ deleted: await cleanupExpiredDispatches() });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
