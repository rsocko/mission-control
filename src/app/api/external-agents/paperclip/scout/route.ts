import { NextResponse } from 'next/server';
import { externalAgentErrorResponse } from '@/lib/external-agents/http';
import {
  requestPaperclipScoutDispatch,
  requirePaperclipScoutAuthentication,
  type PaperclipScoutRequestInput,
} from '@/lib/external-agents/scout-bridge';
import {
  ExternalAgentError,
  isExternalAgentError,
} from '@/lib/external-agents/errors';

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const source = await requirePaperclipScoutAuthentication(
      request,
      request.headers.get('x-mc-paperclip-agent-id') ?? '',
      rawBody,
    );
    let body: PaperclipScoutRequestInput;
    try {
      body = JSON.parse(rawBody) as PaperclipScoutRequestInput;
    } catch {
      throw new ExternalAgentError(
        'Request body must be valid JSON',
        'VALIDATION_ERROR',
        422,
      );
    }
    const result = await requestPaperclipScoutDispatch(source, body);
    return NextResponse.json(result, { status: 202 });
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
