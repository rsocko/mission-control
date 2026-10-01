import { NextResponse } from 'next/server';
import { reconcileActiveCopilotCloudDispatches } from '@/lib/external-agents/service';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const result = await reconcileActiveCopilotCloudDispatches();
    return NextResponse.json(result, {
      status: result.failures.length > 0 ? 207 : 200,
    });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
