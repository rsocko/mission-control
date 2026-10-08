import { NextResponse } from 'next/server';
import {
  pollPaperclipAuthorization,
  startPaperclipAuthorization,
} from '@/lib/connectors/paperclip/auth-session';
import {
  externalAgentErrorResponse,
  requireTrustedMutation,
} from '@/lib/external-agents/http';

export async function POST(request: Request) {
  try {
    requireTrustedMutation(request);
    const body = await request.json() as {
      action?: string;
      apiOrigin?: string;
      authSessionId?: string;
    };
    if (body.action === 'start') {
      return NextResponse.json(
        await startPaperclipAuthorization(body.apiOrigin ?? ''),
        { status: 201 },
      );
    }
    if (body.action === 'poll') {
      return NextResponse.json(
        await pollPaperclipAuthorization(body.authSessionId ?? ''),
      );
    }
    return NextResponse.json({ error: 'Unsupported Paperclip authorization action' }, { status: 400 });
  } catch (error) {
    return externalAgentErrorResponse(error);
  }
}
