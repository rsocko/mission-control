import { NextResponse } from 'next/server';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';
import {
  getWorkTodoBridgeStatus,
  resetWorkTodoDelta,
  WorkTodoBridgeError,
} from '@/lib/connectors/work-todo/service';

function bridgeError(error: unknown) {
  if (error instanceof WorkTodoBridgeError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  throw error;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return NextResponse.json(await getWorkTodoBridgeStatus((await params).id));
  } catch (error) {
    return bridgeError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isTrustedMutationRequest(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (body?.action !== 'reset-delta') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  }
  try {
    return NextResponse.json(resetWorkTodoDelta((await params).id));
  } catch (error) {
    return bridgeError(error);
  }
}
