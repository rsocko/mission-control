import { NextResponse } from 'next/server';
import { externalAgentErrorResponse } from '@/lib/external-agents/http';
import {
  buildScoutWorkerSkill,
  claimScoutWorkerCredential,
  getScoutClaimStatus,
  registerScoutWorker,
} from '@/lib/external-agents/scout-worker';

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('document') !== 'skill') {
    return NextResponse.json(
      { error: 'Unknown onboarding document' },
      { status: 404 },
    );
  }
  return new NextResponse(buildScoutWorkerSkill(), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      action?: 'register' | 'status' | 'claim';
      workerId?: string;
      registrationToken?: string;
      claimToken?: string;
      capabilities?: unknown;
      client?: unknown;
    };
    if (!body.workerId) {
      return NextResponse.json(
        { error: 'workerId is required' },
        { status: 422 },
      );
    }
    if (body.action === 'register') {
      return NextResponse.json(await registerScoutWorker({
        workerId: body.workerId,
        registrationToken: body.registrationToken ?? '',
        capabilities: body.capabilities,
        client: body.client,
      }));
    }
    if (body.action === 'status') {
      return NextResponse.json(await getScoutClaimStatus(
        body.workerId,
        body.claimToken ?? '',
      ));
    }
    if (body.action === 'claim') {
      return NextResponse.json(await claimScoutWorkerCredential(
        body.workerId,
        body.claimToken ?? '',
        new URL(request.url).origin,
      ));
    }
    return NextResponse.json({ error: 'action is invalid' }, { status: 422 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
