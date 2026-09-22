import type {
  TriageSyncRunResult,
  TriageSyncStateRecord,
} from '@/db/persistence/triage-repositories';
import { getTriagePersistenceRepositories } from './persistence';

export type { TriageSyncStateRecord };

export async function getSyncState(sourceId: string): Promise<TriageSyncStateRecord | null> {
  return getTriagePersistenceRepositories().syncState.get(sourceId);
}

export async function getAllSyncStates(): Promise<TriageSyncStateRecord[]> {
  return getTriagePersistenceRepositories().syncState.getAll();
}

export async function recordSyncRun(
  sourceId: string,
  expectedRevision: number,
  update: {
    lastCursor?: string | null;
    imported: number;
    skipped: number;
    errors: string[];
    durationMs: number;
  },
): Promise<TriageSyncRunResult> {
  return getTriagePersistenceRepositories().syncState.recordRun({
    sourceId,
    expectedRevision,
    cursor: Object.hasOwn(update, 'lastCursor')
      ? { operation: 'set', value: update.lastCursor ?? null }
      : { operation: 'preserve' },
    imported: update.imported,
    skipped: update.skipped,
    errors: update.errors,
    durationMs: update.durationMs,
    syncedAt: new Date().toISOString(),
  });
}

export async function upsertSyncState(
  sourceId: string,
  update: {
    lastCursor?: string | null;
    imported: number;
    skipped: number;
    errors: string[];
    durationMs: number;
  },
): Promise<void> {
  const current = await getSyncState(sourceId);
  const result = await recordSyncRun(sourceId, current?.revision ?? 0, update);
  if (result.status === 'stale') {
    throw new Error(`Triage sync state changed concurrently for ${sourceId}`);
  }
}
