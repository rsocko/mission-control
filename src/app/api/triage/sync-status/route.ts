import { NextResponse } from 'next/server';
import { getAllSyncStates } from '@/lib/triage/importers';
import { resolveGitHubCredentials, resolveRedditCredentials, resolveYouTubeCredentials } from '@/lib/triage/credentials';
import { triageSyncScheduler } from '@/lib/triage/scheduler';
import logger from '@/lib/logger';

export async function GET() {
  try {
    const [states, githubCreds, redditCreds, youtubeCreds, autoSyncConfig] = await Promise.all([
      getAllSyncStates(),
      resolveGitHubCredentials(),
      resolveRedditCredentials(),
      resolveYouTubeCredentials(),
      triageSyncScheduler.getConfig(),
    ]);

    return NextResponse.json({
      sources: {
        'github-stars': {
          configured: !!githubCreds,
          syncState: states.find((s) => s.id === 'github-stars') || null,
          autoSync: autoSyncConfig.sources['github-stars'],
        },
        'reddit-saved': {
          configured: !!redditCreds,
          syncState: states.find((s) => s.id === 'reddit-saved') || null,
          autoSync: autoSyncConfig.sources['reddit-saved'],
        },
        'twitter-archive': {
          // Archive-based import needs no stored credentials — it's a one-off file upload.
          configured: true,
          syncState: states.find((s) => s.id === 'twitter-archive') || null,
        },
        'youtube': {
          configured: !!youtubeCreds,
          autoSync: autoSyncConfig.sources['youtube'],
          // YouTube has one sync-state row per playlist (id `youtube-{playlistId}`),
          // so expose them all rather than a single aggregate syncState.
          playlistSyncStates: states.filter((s) => s.id.startsWith('youtube-')),
        },
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch sync status');
    return NextResponse.json({ error: 'Failed to fetch sync status' }, { status: 500 });
  }
}

