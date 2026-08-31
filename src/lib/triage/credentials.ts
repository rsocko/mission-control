import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import { getTriagePersistenceRepositories } from './persistence';

const SETTINGS_KEY = 'triage_source_credentials';

interface StoredCredentials {
  github: { pat: string; username?: string };
  reddit: { clientId: string; clientSecret: string; refreshToken: string; username?: string };
  youtube: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    /** @deprecated use `playlists` instead — kept for back-compat with existing settings rows. */
    playlistIds?: string[];
    playlists?: Array<{ id: string; label: string; enabled: boolean }>;
  };
  karakeep?: { url: string; apiKey: string };
}

export interface ResolvedKarakeepCredentials {
  url: string;
  apiKey: string;
}

export interface ResolvedGitHubCredentials {
  token: string;
  username?: string;
  source: 'triage-settings' | 'connector' | 'env';
}

export interface ResolvedRedditCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  username?: string;
}

export interface ResolvedYouTubeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  playlistIds: string[];
}

/**
 * Resolves GitHub credentials by checking (in order):
 * 1. Triage source settings in app_settings
 * 2. Any github-issues connector's stored token
 * 3. GITHUB_PAT environment variable
 */
export async function resolveGitHubCredentials(): Promise<ResolvedGitHubCredentials | null> {
  const stored = await getCorePersistenceRepositories().settings.get(SETTINGS_KEY) as StoredCredentials | null;
  if (stored?.github?.pat) {
    return { token: stored.github.pat, username: stored.github.username, source: 'triage-settings' };
  }

  const connectorToken = await getTriagePersistenceRepositories()
    .githubCredentialFallback
    .findActiveGitHubToken();
  if (connectorToken) {
    return { token: connectorToken, source: 'connector' };
  }

  // 3. Fall back to env var
  const token = process.env.GITHUB_PAT;
  if (token) {
    return { token, source: 'env' };
  }

  return null;
}

/**
 * Resolves Reddit credentials from DB settings first, then falls back to env vars.
 */
export async function resolveRedditCredentials(): Promise<ResolvedRedditCredentials | null> {
  const stored = await getCorePersistenceRepositories().settings.get(SETTINGS_KEY) as StoredCredentials | null;
  if (stored?.reddit?.clientId && stored?.reddit?.clientSecret && stored?.reddit?.refreshToken) {
    return {
      clientId: stored.reddit.clientId,
      clientSecret: stored.reddit.clientSecret,
      refreshToken: stored.reddit.refreshToken,
      username: stored.reddit.username,
    };
  }

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const refreshToken = process.env.REDDIT_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    return {
      clientId,
      clientSecret,
      refreshToken,
      username: process.env.REDDIT_USERNAME,
    };
  }

  return null;
}

/**
 * Resolves YouTube (Google OAuth) credentials from DB settings first, then falls
 * back to env vars. Playlist IDs default to Watch Later (WL) and Liked Videos (LL)
 * when none are configured.
 */
export async function resolveYouTubeCredentials(): Promise<ResolvedYouTubeCredentials | null> {
  const defaultPlaylistIds = ['WL', 'LL'];

  const stored = await getCorePersistenceRepositories().settings.get(SETTINGS_KEY) as StoredCredentials | null;
  if (stored?.youtube?.clientId && stored?.youtube?.clientSecret && stored?.youtube?.refreshToken) {
    const enabledPlaylistIds = stored.youtube.playlists?.filter((p) => p.enabled).map((p) => p.id);
    const playlistIds = enabledPlaylistIds?.length
      ? enabledPlaylistIds
      : stored.youtube.playlistIds?.length
        ? stored.youtube.playlistIds
        : defaultPlaylistIds;

    return {
      clientId: stored.youtube.clientId,
      clientSecret: stored.youtube.clientSecret,
      refreshToken: stored.youtube.refreshToken,
      playlistIds,
    };
  }

  const clientId = process.env.MC_YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.MC_YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.MC_YOUTUBE_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const playlistIds = process.env.MC_YOUTUBE_PLAYLIST_IDS
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean) ?? [];

    return {
      clientId,
      clientSecret,
      refreshToken,
      playlistIds: playlistIds.length ? playlistIds : defaultPlaylistIds,
    };
  }

  return null;
}

export interface ResolvedModelCatalogCredentials {
  url: string;
  apiKey?: string;
}

/**
 * Resolves Model Catalog sidecar credentials from environment variables.
 * Requires MC_MODEL_CATALOG_URL. API key is optional (enforced only when set on the sidecar).
 */
export async function resolveModelCatalogCredentials(): Promise<ResolvedModelCatalogCredentials | null> {
  const url = process.env.MC_MODEL_CATALOG_URL || process.env.MODEL_CATALOG_URL;
  if (!url) return null;

  const apiKey = process.env.MC_MODEL_CATALOG_API_KEY || process.env.MODEL_CATALOG_API_KEY || undefined;

  return { url: url.replace(/\/+$/, ''), apiKey };
}

/**
 * Resolves Karakeep credentials from environment variables.
 * Requires MC_KARAKEEP_URL (or KARAKEEP_URL) and MC_KARAKEEP_API_KEY.
 */
/**
 * Resolves Karakeep credentials by checking (in order):
 * 1. Triage source settings in app_settings (UI-configured)
 * 2. Environment variables (MC_KARAKEEP_URL / KARAKEEP_URL and MC_KARAKEEP_API_KEY)
 */
export async function resolveKarakeepCredentials(): Promise<ResolvedKarakeepCredentials | null> {
  const stored = await getCorePersistenceRepositories().settings.get(SETTINGS_KEY) as StoredCredentials | null;
  if (stored?.karakeep?.url && stored?.karakeep?.apiKey) {
    return {
      url: stored.karakeep.url.replace(/\/+$/, ''),
      apiKey: stored.karakeep.apiKey,
    };
  }

  // 2. Fall back to env vars
  const url = process.env.MC_KARAKEEP_URL || process.env.KARAKEEP_URL;
  const apiKey = process.env.MC_KARAKEEP_API_KEY;

  if (url && apiKey) {
    return { url: url.replace(/\/+$/, ''), apiKey };
  }

  return null;
}
