import { NextResponse } from 'next/server';
import { importYouTubePlaylist, importAllYouTubePlaylist, importAllYouTubePlaylists, getYouTubeAccessToken } from '@/lib/triage/importers';
import { resolveYouTubeCredentials } from '@/lib/triage/credentials';
import logger from '@/lib/logger';

export async function POST(request: Request) {
  try {
    const creds = await resolveYouTubeCredentials();
    if (!creds) {
      return NextResponse.json(
        { error: 'YouTube credentials are required — configure them in Settings → Triage Sources' },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({})) as {
      playlistId?: string;
      playlistIds?: string[];
      maxResults?: number;
      pageToken?: string;
      mode?: 'single' | 'full' | 'incremental';
    };

    const mode = body.mode || 'single';

    if (mode === 'full' || mode === 'incremental') {
      const playlistIds = Array.isArray(body.playlistIds) && body.playlistIds.length
        ? body.playlistIds
        : (body.playlistId ? [body.playlistId] : creds.playlistIds);

      const result = await importAllYouTubePlaylists({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        refreshToken: creds.refreshToken,
        playlistIds,
        incremental: mode === 'incremental',
      });
      return NextResponse.json({ result, mode });
    }

    const playlistId = body.playlistId || creds.playlistIds[0];
    if (!playlistId) {
      return NextResponse.json({ error: 'playlistId is required' }, { status: 400 });
    }

    const accessToken = await getYouTubeAccessToken({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: creds.refreshToken,
    });

    const summary = body.playlistId
      ? await importYouTubePlaylist({
        accessToken,
        playlistId,
        maxResults: typeof body.maxResults === 'number' ? body.maxResults : undefined,
        pageToken: typeof body.pageToken === 'string' ? body.pageToken : undefined,
      })
      : await importAllYouTubePlaylist({ accessToken, playlistId });

    return NextResponse.json({ summary });
  } catch (error) {
    logger.error({ err: error }, 'Failed to import YouTube playlist items');
    return NextResponse.json({ error: 'Failed to import YouTube playlist items' }, { status: 500 });
  }
}
