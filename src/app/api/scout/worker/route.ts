import { NextResponse } from 'next/server';
import { ExternalAgentError } from '@/lib/external-agents/errors';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';
import {
  approveScoutWorker,
  disableScoutWorker,
  getScoutWorker,
  provisionScoutWorker,
  rejectScoutWorker,
} from '@/lib/external-agents/scout-worker';

export async function GET(request: Request) {
  try {
    const connectorId = new URL(request.url).searchParams.get('connectorId');
    if (!connectorId) {
      throw new ExternalAgentError('connectorId is required', 'VALIDATION_ERROR', 422);
    }
    return NextResponse.json({ worker: await getScoutWorker(connectorId) });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const body = await request.json() as {
      connectorId?: string;
      action?: 'generate-setup' | 'approve' | 'reject' | 'disable';
    };
    if (!body.connectorId) {
      throw new ExternalAgentError('connectorId is required', 'VALIDATION_ERROR', 422);
    }
    if (body.action === 'disable') {
      return NextResponse.json({
        worker: await disableScoutWorker(body.connectorId),
      });
    }
    if (body.action === 'approve') {
      return NextResponse.json({
        worker: await approveScoutWorker(body.connectorId),
      });
    }
    if (body.action === 'reject') {
      return NextResponse.json({
        worker: await rejectScoutWorker(body.connectorId),
      });
    }
    if (body.action !== 'generate-setup') {
      throw new ExternalAgentError('action is invalid', 'VALIDATION_ERROR', 422);
    }
    return NextResponse.json(await provisionScoutWorker(
      body.connectorId,
      new URL(request.url).origin,
    ));
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
