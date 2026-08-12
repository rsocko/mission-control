import { NextResponse } from 'next/server';
import { importGitHubStars, importAllGitHubStars } from '@/lib/triage/importers';
import { resolveGitHubCredentials } from '@/lib/triage/credentials';
import logger from '@/lib/logger';

export async function POST(request: Request) {
  try {
    const creds = await resolveGitHubCredentials();
    if (!creds) {
      return NextResponse.json(
        { error: 'GitHub PAT is required — configure it in Settings → Triage Sources' },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({})) as {
      username?: string;
      perPage?: number;
      page?: number;
      mode?: 'single' | 'full' | 'incremental';
    };

    const mode = body.mode || 'single';
    const username = (typeof body.username === 'string' && body.username.trim()) ? body.username.trim() : creds.username;

    if (mode === 'full' || mode === 'incremental') {
      const result = await importAllGitHubStars({
        token: creds.token,
        username,
        incremental: mode === 'incremental',
      });
      return NextResponse.json({ result, mode });
    }

    const summary = await importGitHubStars({
      token: creds.token,
      username,
      perPage: typeof body.perPage === 'number' ? body.perPage : undefined,
      page: typeof body.page === 'number' ? body.page : undefined,
    });

    return NextResponse.json({ summary });
  } catch (error) {
    logger.error({ err: error }, 'Failed to import GitHub stars');
    return NextResponse.json({ error: 'Failed to import GitHub stars' }, { status: 500 });
  }
}
