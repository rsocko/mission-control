import { NextResponse } from 'next/server';
import { reconcileActiveExternalAgentDispatches } from '@/lib/external-agents/service';
import { reconcilePaperclipApprovals } from '@/lib/external-agents/paperclip-approvals';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const [dispatches, approvals] = await Promise.all([
      reconcileActiveExternalAgentDispatches(),
      reconcilePaperclipApprovals(),
    ]);
    return NextResponse.json({ ...dispatches, approvals }, {
      status: dispatches.failures.length > 0 || approvals.failures.length > 0 ? 207 : 200,
    });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
