import { NextResponse } from 'next/server';
import { requestActiveExternalAgentReconciliation } from '@/lib/external-agents/service';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const result = await requestActiveExternalAgentReconciliation();
    return NextResponse.json({ accepted: true, ...result }, { status: 202 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
