import type { TriageItem } from '@/types';

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

export interface TriagePersistenceRepositories {
  readonly capture: TriageCaptureRepository;
  readonly syncState: TriageSyncStateRepository;
  readonly githubCredentialFallback: GitHubCredentialFallbackRepository;
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
