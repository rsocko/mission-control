/**
 * Legacy entry point - re-exports from the split importer modules and sync-state.
 * Existing consumers continue to work without import changes.
 */

// Sync state helpers
export { getSyncState, getAllSyncStates, upsertSyncState } from './sync-state';
export type { TriageSyncStateRecord } from './sync-state';

// Importer functions and types
export {
  fetchWithRateLimit,
  IMPORT_USER_AGENT,
  MAX_PAGES,
  importGitHubStars,
  importAllGitHubStars,
  importRedditSaved,
  importAllRedditSaved,
  importYouTubePlaylist,
  importAllYouTubePlaylist,
  importAllYouTubePlaylists,
  getYouTubeAccessToken,
  parseDescriptionLinks,
  YOUTUBE_WATCH_LATER_PLAYLIST_ID,
  YOUTUBE_LIKED_VIDEOS_PLAYLIST_ID,
  importTwitterArchive,
  importAllTwitterArchive,
  parseArchiveJsFile,
  identifyArchiveFile,
  parseArchiveDate,
  extractArchiveUsername,
} from './importers/index';
export type { TriageImportSummary, FullSyncResult } from './importers/index';
export type { ExtractedLink, ExtractedLinkCategory } from './importers/index';
export type { TwitterArchiveFile, TwitterArchiveFileKind } from './importers/index';
