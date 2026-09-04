import type {
  TriageItem,
  TriageSourcePlatform,
  TriageStatus,
  TriageSuggestedAction,
} from '@/types';

/** URL prefix used for thumbnails cached locally by the thumbnail-cache service. */
export const TRIAGE_CACHED_THUMBNAIL_URL_PREFIX = '/api/assets/thumbnails/';
/** URL prefix used for thumbnails served directly from a capture-image upload. */
export const TRIAGE_CAPTURE_IMAGE_URL_PREFIX = '/api/triage/capture/image/';

export const MAX_TRIAGE_CAPTURE_BATCH_SIZE = 100;
export const MAX_TRIAGE_SYNC_ERRORS = 20;
export const MAX_TRIAGE_SYNC_ERROR_LENGTH = 500;

export type TriageCaptureOutcome =
  | {
      readonly status: 'imported';
      readonly item: TriageItem;
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'source-replay' | 'canonical-duplicate';
      readonly item: TriageItem;
    };

export interface TriageCaptureRepository {
  captureBatch(
    items: readonly TriageItem[],
  ): Promise<readonly TriageCaptureOutcome[]>;
  enrich(
    itemId: string,
    enrichment: {
      readonly rawMetadata: Record<string, unknown>;
      readonly thumbnailUrl?: string;
    },
  ): Promise<TriageItem | null>;
}

export interface TriageSyncStateRecord {
  id: string;
  lastCursor: string | null;
  lastSyncedAt: string | null;
  totalImported: number;
  totalSkipped: number;
  lastRunImported: number;
  lastRunSkipped: number;
  lastRunErrors: string[];
  lastRunDurationMs: number | null;
  revision: number;
}

export type TriageSyncCursorUpdate =
  | { readonly operation: 'preserve' }
  | { readonly operation: 'set'; readonly value: string | null };

export interface TriageSyncRunInput {
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly cursor: TriageSyncCursorUpdate;
  readonly imported: number;
  readonly skipped: number;
  readonly errors: readonly string[];
  readonly durationMs: number;
  readonly syncedAt: string;
}

export type TriageSyncRunResult =
  | {
      readonly status: 'applied';
      readonly state: TriageSyncStateRecord;
    }
  | {
      readonly status: 'stale';
      readonly currentState: TriageSyncStateRecord | null;
      readonly currentRevision: number;
    };

export interface TriageSyncStateRepository {
  get(id: string): Promise<TriageSyncStateRecord | null>;
  getAll(): Promise<TriageSyncStateRecord[]>;
  recordRun(input: TriageSyncRunInput): Promise<TriageSyncRunResult>;
}

export interface GitHubCredentialFallbackRepository {
  findActiveGitHubToken(): Promise<string | null>;
}

// ─── QUEUE LISTING (filters/sorts/facets/pagination) ────────────────────────

export type TriageQueueSortBy = 'relevance' | 'newest' | 'oldest' | 'score';

const DEFAULT_TRIAGE_QUEUE_PAGE_LIMIT = 200;

export interface TriageQueueListFilters {
  readonly status?: TriageStatus | 'all';
  readonly source?: TriageSourcePlatform | 'all';
  readonly q?: string;
  readonly categories?: readonly string[];
  readonly sortBy?: TriageQueueSortBy;
  readonly limit?: number;
  readonly offset?: number;
}

export interface TriageQueueFacetStats {
  readonly total: number;
  readonly pending: number;
  readonly snoozed: number;
  readonly actioned: number;
  readonly dismissed: number;
  readonly sourceCounts: Record<string, number>;
}

export interface TriageQueueListResult {
  readonly items: TriageItem[];
  readonly totalFiltered: number;
  readonly hasMore: boolean;
  readonly stats: TriageQueueFacetStats;
}

/** Resolves the effective page limit for a queue list request (defaults preserved from the pre-migration query module). */
export function resolveTriageQueueListPageLimit(filters: TriageQueueListFilters): number {
  return filters.limit ?? DEFAULT_TRIAGE_QUEUE_PAGE_LIMIT;
}

/** Normalizes free-text category filters the same way for every backend: trim, lowercase, dedupe, drop blanks. */
export function normalizeTriageQueueCategoryFilters(
  categories: readonly string[] | undefined,
): string[] {
  return [...new Set(
    (categories ?? []).map((category) => category.trim().toLowerCase()).filter(Boolean),
  )];
}

// ─── EMBED / THUMBNAIL BACKFILL ──────────────────────────────────────────────

export interface TriageEmbedBackfillQuery {
  readonly source?: string;
  readonly cursor?: string;
  readonly force?: boolean;
  readonly limit: number;
}

export interface TriageEmbedBackfillCandidate {
  readonly id: string;
  readonly sourceUrl: string;
  readonly canonicalUrl?: string;
}

export interface TriageEmbedBackfillPage {
  readonly items: TriageEmbedBackfillCandidate[];
  readonly nextCursor: string | null;
}

export interface TriageMissingThumbnailCandidate {
  readonly id: string;
  readonly sourcePlatform: TriageSourcePlatform;
  readonly sourceUrl: string;
  readonly rawMetadata: Record<string, unknown>;
}

export interface TriageMergeMetadataOptions {
  /** Sets `thumbnailUrl` only when the item's current `thumbnailUrl` is null (COALESCE semantics). */
  readonly fillThumbnailUrl?: string;
  /**
   * When set, and the current row's `rawMetadata[skipWhenKeyPresent]` already holds a truthy
   * value, the entire merge (and any `fillThumbnailUrl`) is skipped and the current item is
   * returned unchanged. Lets callers express "don't clobber existing embed/channel data" without
   * a separate boolean flag — they can inspect the returned item to see what was actually stored.
   */
  readonly skipWhenKeyPresent?: string;
}

// ─── QUEUE ITEMS ─────────────────────────────────────────────────────────────

export interface TriageQueueItemRepository {
  list(filters: TriageQueueListFilters): Promise<TriageQueueListResult>;
  get(id: string): Promise<TriageItem | null>;
  /**
   * Strict single insert + readback. Unlike `capture.captureBatch`, this never silently
   * dedupes/skips — a source-platform+source-id collision throws the underlying unique-
   * constraint violation. Used by direct single-item capture paths (URL/image/text capture)
   * that must fail loudly on an unexpected duplicate rather than reporting it as "skipped".
   */
  create(item: TriageItem): Promise<TriageItem>;
  /** Inserts `items` only if the table is currently empty; otherwise a no-op. Pass an empty array to make this a pure "am I empty" no-op. */
  seedIfEmpty(items: readonly TriageItem[]): Promise<void>;
  /**
   * Atomically shallow-merges `patch` into the item's `rawMetadata` and optionally fills a null
   * `thumbnailUrl`. See {@link TriageMergeMetadataOptions.skipWhenKeyPresent} for the fill-only /
   * don't-overwrite semantics needed by embed and channel-metadata enrichment. Returns null if
   * the item doesn't exist.
   */
  mergeMetadata(
    id: string,
    patch: Record<string, unknown>,
    options?: TriageMergeMetadataOptions,
  ): Promise<TriageItem | null>;
  setContentType(id: string, contentType: string): Promise<TriageItem | null>;
  setContentTypes(ids: readonly string[], contentType: string): Promise<number>;
  /** Reads items for reclassification. Omitting `ids` returns every item (full backfill). */
  listForReclassification(ids?: readonly string[]): Promise<TriageItem[]>;
  findBySourceId(sourceId: string): Promise<TriageItem | null>;
  findBySourceUrl(sourceUrl: string): Promise<TriageItem | null>;
  listEmbedBackfillCandidates(query: TriageEmbedBackfillQuery): Promise<TriageEmbedBackfillPage>;
  listMissingThumbnailCandidates(
    input?: { readonly source?: string },
  ): Promise<TriageMissingThumbnailCandidate[]>;
  /** Fill-only CAS: sets `thumbnailUrl` only if it is currently NULL. Returns whether the update applied. */
  fillThumbnailIfNull(id: string, thumbnailUrl: string): Promise<boolean>;
  /**
   * Unconditionally replaces `thumbnailUrl`, overwriting any existing value — used for expired
   * CDN URL refresh, where `fillThumbnailIfNull`'s fill-only semantics would not apply. Returns
   * whether the item existed and was updated.
   */
  setThumbnail(id: string, thumbnailUrl: string): Promise<boolean>;
}

// ─── CONTENT TYPE REGISTRY ───────────────────────────────────────────────────

export interface TriageContentTypeRecord {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly color: string;
  readonly builtin: boolean;
  readonly suppressed: boolean;
  readonly priority: number;
  readonly urlPatterns: string[];
  readonly keywordHints: string[];
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TriageContentTypeUpsertInput {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly color: string;
  readonly builtin: boolean;
  readonly suppressed: boolean;
  readonly priority: number;
  readonly urlPatterns: readonly string[];
  readonly keywordHints: readonly string[];
  readonly description: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export interface TriageContentTypeBuiltinDefaults {
  readonly name: string;
  readonly icon: string | null;
  readonly color: string;
  readonly priority: number;
  readonly urlPatterns: readonly string[];
  readonly keywordHints: readonly string[];
  readonly description: string | null;
  readonly createdAt: string;
}

export interface TriageContentTypeSuppressionInput {
  readonly id: string;
  readonly suppressed: boolean;
  readonly updatedAt: string;
  /** When the row doesn't exist yet, insert it using these built-in defaults; when null, a missing row is a no-op. */
  readonly builtin: TriageContentTypeBuiltinDefaults | null;
}

export interface TriageContentTypeRepository {
  list(): Promise<TriageContentTypeRecord[]>;
  /** Full upsert: updates the row if it exists, otherwise inserts it. */
  upsert(record: TriageContentTypeUpsertInput): Promise<void>;
  /** Deletes a (non-built-in) content type row. Returns whether a row was actually deleted. */
  deleteCustom(id: string): Promise<boolean>;
  setSuppressed(input: TriageContentTypeSuppressionInput): Promise<void>;
}

// ─── QUEUE HEALTH / DIGEST SNAPSHOTS ─────────────────────────────────────────

export interface TriageQueueHealthPendingSnapshotEntry {
  readonly capturedAt: string;
  readonly sourcePlatform: TriageSourcePlatform;
}

export interface TriageDigestSnapshotInput {
  readonly periodStart: string;
  readonly staleBeforeAt: string;
  readonly topPendingLimit: number;
}

export interface TriageDigestTopPendingEntry {
  readonly id: string;
  readonly title: string;
  readonly capturedAt: string;
  readonly aiSuggestedActions: TriageSuggestedAction[];
}

export interface TriageDigestSnapshot {
  readonly newItemsBySource: Record<string, number>;
  readonly actionedByStatus: Record<string, number>;
  readonly queueDepth: number;
  readonly staleCount: number;
  readonly topPending: TriageDigestTopPendingEntry[];
}

export interface TriageQueueHealthRepository {
  /** Raw pending-item snapshot (unfiltered); threshold/average-age math stays in the caller. */
  getPendingSnapshot(): Promise<TriageQueueHealthPendingSnapshotEntry[]>;
  getDigestSnapshot(input: TriageDigestSnapshotInput): Promise<TriageDigestSnapshot>;
}

// ─── MAINTENANCE / STORAGE ───────────────────────────────────────────────────

export interface TriageStorageRefRow {
  readonly id: string;
  readonly thumbnailUrl: string | null;
  readonly sourceUrl: string;
}

export interface TriageDeleteBySourceInput {
  readonly source: string;
  /** When false (default), only 'pending' and 'dismissed' items are deleted; when true, all statuses. */
  readonly includeActioned: boolean;
}

export interface TriageMaintenanceRepository {
  countByStatus(): Promise<Record<string, number>>;
  countBySource(): Promise<Record<string, number>>;
  countCachedThumbnails(): Promise<number>;
  countExternalThumbnails(): Promise<number>;
  /** Filenames (not full URLs) derived from every cached thumbnailUrl currently referenced by an item. */
  listCachedThumbnailFilenames(): Promise<string[]>;
  /** Nulls out every external (non-cached, non-capture-image) thumbnailUrl. Returns the number of rows updated. */
  clearExternalThumbnails(): Promise<number>;
  countDismissedBefore(cutoff: string): Promise<number>;
  /** Deletes dismissed items ingested before `cutoff` and returns their storage refs for post-commit cleanup. */
  purgeDismissedBefore(cutoff: string): Promise<TriageStorageRefRow[]>;
  /** Deletes items for a source (optionally excluding actioned items) and returns their storage refs for post-commit cleanup. */
  deleteBySource(input: TriageDeleteBySourceInput): Promise<TriageStorageRefRow[]>;
  /**
   * Atomically selects storage refs for exactly `ids` then deletes exactly those rows, returning
   * the refs for post-commit cleanup (cached thumbnail purge + semantic-index delete), as used by
   * `hardDeleteTriageItem`/`hardDeleteTriageItems`. Empty input is a no-op returning `[]`.
   */
  deleteByIds(ids: readonly string[]): Promise<TriageStorageRefRow[]>;
}

export interface NativeInstallationCredentialRecord {
  readonly id: string;
  readonly installationId: string;
  readonly tokenHash: string;
  readonly scopes: unknown;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface NativeShareCredentialRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly scope: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface NativeCredentialRepository {
  findInstallationCredential(id: string): Promise<NativeInstallationCredentialRecord | null>;
  findShareCredential(id: string): Promise<NativeShareCredentialRecord | null>;
}

export type NativeShareCaptureClaim =
  | { readonly status: 'acquired'; readonly reservationId: string }
  | { readonly status: 'duplicate'; readonly itemId: string }
  | { readonly status: 'pending' | 'rateLimited' | 'replay' };

export interface NativeShareCaptureClaimInput {
  readonly credentialId: string;
  readonly requestId: string;
  readonly payloadHash: string;
  readonly reservationId: string;
  readonly now: string;
  readonly retentionCutoff: string;
  readonly rateWindowStart: string;
  readonly maximumCaptures: number;
}

export interface NativeShareCaptureRepository {
  claim(input: NativeShareCaptureClaimInput): Promise<NativeShareCaptureClaim>;
  complete(input: {
    readonly credentialId: string;
    readonly requestId: string;
    readonly reservationId: string;
    readonly payloadHash: string;
    readonly itemId: string;
    readonly completedAt: string;
  }): Promise<boolean>;
  release(input: {
    readonly credentialId: string;
    readonly requestId: string;
    readonly reservationId: string;
  }): Promise<boolean>;
}

export interface NativeStoredRequest {
  readonly responseStatus: number;
  readonly responseBody: unknown;
}

export type NativeRequestOutcome<T> =
  | { readonly status: 'applied'; readonly response: NativeStoredRequest & { responseBody: T } }
  | { readonly status: 'replay'; readonly response: NativeStoredRequest }
  | { readonly status: 'mismatch' };

export type NativeApnsRegistrationOutcome =
  | NativeRequestOutcome<NativeApnsRegistrationStoredResponse>
  | { readonly status: 'credentialRevoked' };

export interface NativeApnsRegistrationStoredResponse {
  readonly kind: 'registration';
  readonly registrationId: string;
  readonly state: 'registered' | 'rotated';
  readonly updatedAt: string;
}

export interface NativeApnsUnregistrationStoredResponse {
  readonly kind: 'unregistration';
  readonly registrationId: string;
  readonly state: 'unregistered';
  readonly updatedAt: string;
}

export type NativeApnsUnregistrationOutcome =
  | NativeRequestOutcome<NativeApnsUnregistrationStoredResponse>
  | { readonly status: 'notOwned' };

export interface NativeApnsRepository {
  register(input: {
    readonly credentialId: string;
    readonly requestId: string;
    readonly payloadHash: string;
    readonly legacyPayloadHash: string;
    readonly registrationId: string;
    readonly installationId: string;
    readonly tokenCiphertext: string;
    readonly tokenHash: string;
    readonly environment: string;
    readonly topic: string;
    readonly appVersion: string;
    readonly buildNumber: number;
    readonly locale: string;
    readonly timeZone: string;
    readonly now: string;
  }): Promise<NativeApnsRegistrationOutcome>;
  unregister(input: {
    readonly credentialId: string;
    readonly requestId: string;
    readonly payloadHash: string;
    readonly legacyPayloadHash: string;
    readonly registrationId: string;
    readonly installationId: string;
    readonly now: string;
  }): Promise<NativeApnsUnregistrationOutcome>;
  logout(input: {
    readonly installationId: string;
    readonly now: string;
  }): Promise<{
    readonly credentialsRevoked: number;
    readonly registrationsRetired: number;
  }>;
}

export interface TriageNativePersistenceRepositories {
  readonly credentials: NativeCredentialRepository;
  readonly shareCapture: NativeShareCaptureRepository;
  readonly apns: NativeApnsRepository;
}

export interface TriagePersistenceRepositories {
  readonly capture: TriageCaptureRepository;
  readonly syncState: TriageSyncStateRepository;
  readonly githubCredentialFallback: GitHubCredentialFallbackRepository;
  readonly items: TriageQueueItemRepository;
  readonly contentTypes: TriageContentTypeRepository;
  readonly health: TriageQueueHealthRepository;
  readonly maintenance: TriageMaintenanceRepository;
  readonly native: TriageNativePersistenceRepositories;
}

export function assertValidTriageCaptureBatch(items: readonly TriageItem[]): void {
  if (items.length > MAX_TRIAGE_CAPTURE_BATCH_SIZE) {
    throw new RangeError(
      `Triage capture batches cannot exceed ${MAX_TRIAGE_CAPTURE_BATCH_SIZE} items`,
    );
  }
  const invalidIndex = items.findIndex((item) =>
    !item.sourcePlatform.trim()
    || !item.sourceId.trim()
    || !item.sourceUrl.trim()
    || !item.title.trim());
  if (invalidIndex >= 0) {
    throw new TypeError(`Invalid triage capture item at index ${invalidIndex}`);
  }
}

export function assertValidTriageSyncRun(input: TriageSyncRunInput): void {
  if (!input.sourceId.trim()) {
    throw new TypeError('Triage sync source ID is required');
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new RangeError('Expected triage sync revision must be a non-negative integer');
  }
  if (!Number.isInteger(input.imported) || input.imported < 0) {
    throw new RangeError('Triage sync imported count must be a non-negative integer');
  }
  if (!Number.isInteger(input.skipped) || input.skipped < 0) {
    throw new RangeError('Triage sync skipped count must be a non-negative integer');
  }
  if (!Number.isInteger(input.durationMs) || input.durationMs < 0) {
    throw new RangeError('Triage sync duration must be a non-negative integer');
  }
  if (input.errors.length > MAX_TRIAGE_SYNC_ERRORS) {
    throw new RangeError(`Triage sync errors cannot exceed ${MAX_TRIAGE_SYNC_ERRORS}`);
  }
  if (input.errors.some((error) => error.length > MAX_TRIAGE_SYNC_ERROR_LENGTH)) {
    throw new RangeError(
      `Triage sync errors cannot exceed ${MAX_TRIAGE_SYNC_ERROR_LENGTH} characters`,
    );
  }
}
