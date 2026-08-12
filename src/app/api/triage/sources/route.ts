import { NextResponse } from 'next/server';
import db from '@/db';
import { appSettings, connectorConfigs } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import logger from '@/lib/logger';

const SETTINGS_KEY = 'triage_source_credentials';

export interface TriageSourceCredentials {
  github: {
    pat: string;
    username?: string;
  };
  reddit: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    username?: string;
  };
  youtube: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    playlists: Array<{ id: string; label: string; enabled: boolean }>;
  };
  karakeep?: {
    url: string;
    apiKey: string;
  };
}

const EMPTY_CREDENTIALS: TriageSourceCredentials = {
  github: { pat: '', username: '' },
  reddit: { clientId: '', clientSecret: '', refreshToken: '', username: '' },
  youtube: { clientId: '', clientSecret: '', refreshToken: '', playlists: [] },
  karakeep: { url: '', apiKey: '' },
};

interface StoredPlaylist { id: string; label: string; enabled: boolean }

function isStoredPlaylist(value: unknown): value is StoredPlaylist {
  return !!value && typeof value === 'object'
    && typeof (value as StoredPlaylist).id === 'string'
    && typeof (value as StoredPlaylist).label === 'string'
    && typeof (value as StoredPlaylist).enabled === 'boolean';
}

/** Merges a stored row with defaults so older rows saved before `youtube` existed don't crash. */
function normalizeCredentials(value: unknown): TriageSourceCredentials {
  const stored = (value || {}) as Partial<TriageSourceCredentials>;
  return {
    github: { ...EMPTY_CREDENTIALS.github, ...stored.github },
    reddit: { ...EMPTY_CREDENTIALS.reddit, ...stored.reddit },
    youtube: { ...EMPTY_CREDENTIALS.youtube, ...stored.youtube },
    karakeep: { url: '', apiKey: '', ...stored.karakeep },
  };
}

export async function GET() {
  try {
    const [row] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, SETTINGS_KEY))
      .limit(1);

    const creds = normalizeCredentials(row?.value);

    // Check if a github-issues connector already provides a token
    let githubConnectedViaConnector = false;
    try {
      const connectors = await db
        .select({ credentials: connectorConfigs.credentials })
        .from(connectorConfigs)
        .where(and(eq(connectorConfigs.type, 'github-issues'), isNull(connectorConfigs.deletedAt)))
        .limit(1);
      const connectorCreds = connectors[0]?.credentials as { token?: string } | undefined;
      githubConnectedViaConnector = !!connectorCreds?.token;
    } catch {
      // table may not exist
    }

    const githubConfiguredDirectly = !!creds.github.pat;
    const githubConfiguredViaEnv = !!process.env.GITHUB_PAT;

    return NextResponse.json({
      github: {
        pat: creds.github.pat ? '••••••••' + creds.github.pat.slice(-4) : '',
        username: creds.github.username || '',
        configured: githubConfiguredDirectly || githubConnectedViaConnector || githubConfiguredViaEnv,
        connectedViaConnector: githubConnectedViaConnector,
      },
      reddit: {
        clientId: creds.reddit.clientId || '',
        clientSecret: creds.reddit.clientSecret ? '••••••••' + creds.reddit.clientSecret.slice(-4) : '',
        refreshToken: creds.reddit.refreshToken ? '••••••••' + creds.reddit.refreshToken.slice(-4) : '',
        username: creds.reddit.username || '',
        configured: !!(creds.reddit.clientId && creds.reddit.clientSecret && creds.reddit.refreshToken),
      },
      youtube: {
        clientId: creds.youtube.clientId || '',
        clientSecret: creds.youtube.clientSecret ? '••••••••' + creds.youtube.clientSecret.slice(-4) : '',
        refreshToken: creds.youtube.refreshToken ? '••••••••' + creds.youtube.refreshToken.slice(-4) : '',
        playlists: creds.youtube.playlists || [],
        configured: !!(creds.youtube.clientId && creds.youtube.clientSecret && creds.youtube.refreshToken),
      },
      karakeep: {
        url: creds.karakeep?.url || '',
        apiKey: creds.karakeep?.apiKey ? '••••••••' + creds.karakeep.apiKey.slice(-4) : '',
        configured: !!(creds.karakeep?.url && creds.karakeep?.apiKey) || !!((process.env.MC_KARAKEEP_URL || process.env.KARAKEEP_URL) && process.env.MC_KARAKEEP_API_KEY),
        configuredViaEnv: !!((process.env.MC_KARAKEEP_URL || process.env.KARAKEEP_URL) && process.env.MC_KARAKEEP_API_KEY),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load triage source credentials');
    return NextResponse.json({ error: 'Failed to load credentials' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      source: 'github' | 'reddit' | 'youtube' | 'karakeep';
      credentials?: Record<string, string>;
      playlists?: unknown;
    };

    // Load existing
    const [row] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, SETTINGS_KEY))
      .limit(1);

    const existing = normalizeCredentials(row?.value);
    const credentials = body.credentials || {};

    if (body.source === 'github') {
      existing.github = {
        pat: credentials.pat || existing.github.pat,
        username: credentials.username ?? existing.github.username,
      };
    } else if (body.source === 'reddit') {
      existing.reddit = {
        clientId: credentials.clientId || existing.reddit.clientId,
        clientSecret: credentials.clientSecret || existing.reddit.clientSecret,
        refreshToken: credentials.refreshToken || existing.reddit.refreshToken,
        username: credentials.username ?? existing.reddit.username,
      };
    } else if (body.source === 'youtube') {
      existing.youtube = {
        clientId: credentials.clientId || existing.youtube.clientId,
        clientSecret: credentials.clientSecret || existing.youtube.clientSecret,
        refreshToken: credentials.refreshToken || existing.youtube.refreshToken,
        playlists: existing.youtube.playlists,
      };
      // Playlists are managed independently from credentials so the playlist
      // editor can add/remove/toggle entries without re-entering secrets.
      if (Array.isArray(body.playlists)) {
        const playlists = body.playlists.filter(isStoredPlaylist);
        existing.youtube.playlists = playlists;
      }
    } else if (body.source === 'karakeep') {
      // Ignore masked API key values (returned by GET for display) to avoid
      // overwriting the real key when only the URL is being updated.
      const isMasked = typeof credentials.apiKey === 'string' && /^•+/.test(credentials.apiKey);
      const resolvedApiKey = isMasked ? (existing.karakeep?.apiKey || '') : (credentials.apiKey || existing.karakeep?.apiKey || '');
      const resolvedUrl = (credentials.url || existing.karakeep?.url || '').replace(/\/+$/, '');

      // Validate connection before saving
      if (resolvedUrl && resolvedApiKey) {
        try {
          const testRes = await fetch(`${resolvedUrl}/api/v1/bookmarks?limit=1`, {
            headers: { Authorization: `Bearer ${resolvedApiKey}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(10000),
          });
          if (testRes.status === 401 || testRes.status === 403) {
            return NextResponse.json(
              { error: 'Karakeep returned 401 Unauthorized — check your API key' },
              { status: 400 },
            );
          }
        } catch {
          // Network error — allow save anyway, the instance may just be temporarily down
        }
      }

      existing.karakeep = { url: resolvedUrl, apiKey: resolvedApiKey };
    } else {
      return NextResponse.json({ error: 'Invalid source' }, { status: 400 });
    }

    const now = new Date().toISOString();
    await db
      .insert(appSettings)
      .values({ key: SETTINGS_KEY, value: existing, updatedAt: now })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: existing, updatedAt: now },
      });

    return NextResponse.json({ success: true, source: body.source });
  } catch (error) {
    logger.error({ err: error }, 'Failed to save triage source credentials');
    return NextResponse.json({ error: 'Failed to save credentials' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { source: 'github' | 'reddit' | 'youtube' | 'karakeep' };

    const [row] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, SETTINGS_KEY))
      .limit(1);

    const existing = normalizeCredentials(row?.value);

    if (body.source === 'github') {
      existing.github = { pat: '', username: '' };
    } else if (body.source === 'reddit') {
      existing.reddit = { clientId: '', clientSecret: '', refreshToken: '', username: '' };
    } else if (body.source === 'youtube') {
      // Keep the configured playlists — only the credentials are being removed.
      existing.youtube = { clientId: '', clientSecret: '', refreshToken: '', playlists: existing.youtube.playlists };
    } else if (body.source === 'karakeep') {
      existing.karakeep = { url: '', apiKey: '' };
    } else {
      return NextResponse.json({ error: 'Invalid source' }, { status: 400 });
    }

    const now = new Date().toISOString();
    await db
      .insert(appSettings)
      .values({ key: SETTINGS_KEY, value: existing, updatedAt: now })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: existing, updatedAt: now },
      });

    return NextResponse.json({ success: true, source: body.source });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete triage source credentials');
    return NextResponse.json({ error: 'Failed to delete credentials' }, { status: 500 });
  }
}
