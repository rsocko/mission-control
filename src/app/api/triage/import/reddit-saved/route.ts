import { NextResponse } from 'next/server';
import { importRedditSaved, importAllRedditSaved } from '@/lib/triage/importers';
import { resolveRedditCredentials } from '@/lib/triage/credentials';
import logger from '@/lib/logger';

export async function POST(request: Request) {
  try {
    const creds = await resolveRedditCredentials();
    if (!creds) {
      return NextResponse.json(
        { error: 'Reddit credentials are required — configure them in Settings → Triage Sources' },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({})) as {
      username?: string;
      limit?: number;
      after?: string;
      mode?: 'single' | 'full' | 'incremental';
    };

    const mode = body.mode || 'single';
    const username = (typeof body.username === 'string' && body.username.trim()) ? body.username.trim() : creds.username;

    if (mode === 'full' || mode === 'incremental') {
      const result = await importAllRedditSaved({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        refreshToken: creds.refreshToken,
        username,
        incremental: mode === 'incremental',
      });
      return NextResponse.json({ result, mode });
    }

    const summary = await importRedditSaved({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: creds.refreshToken,
      username,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      after: typeof body.after === 'string' ? body.after : undefined,
    });

    return NextResponse.json({ summary });
  } catch (error) {
    logger.error({ err: error }, 'Failed to import Reddit saved items');
    return NextResponse.json({ error: 'Failed to import Reddit saved items' }, { status: 500 });
  }
}
