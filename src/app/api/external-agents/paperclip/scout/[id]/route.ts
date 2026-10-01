import { NextResponse } from 'next/server';
import { externalAgentErrorResponse } from '@/lib/external-agents/http';
import {
  getPaperclipScoutDispatch,
  requirePaperclipScoutAuthentication,
} from '@/lib/external-agents/scout-bridge';
import { isExternalAgentError } from '@/lib/external-agents/errors';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const source = await requirePaperclipScoutAuthentication(
      request,
      request.headers.get('x-mc-paperclip-agent-id') ?? '',
    );
    return NextResponse.json(
      await getPaperclipScoutDispatch(source, (await params).id),
    );
  } catch (error) {
    if (isExternalAgentError(error)) {
      return NextResponse.json({
        state: error.status >= 500 ? 'failed' : 'rejected',
        error: error.message,
        code: error.code,
      }, { status: error.status });
    }
    return externalAgentErrorResponse(error);
  }
}
