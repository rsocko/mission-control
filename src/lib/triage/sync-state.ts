/**
 * Triage sync state management — getSyncState, getAllSyncStates, upsertSyncState.
 * Extracted from importers.ts to remove duplication and improve cohesion.
 */
import db from '@/db';
import { triageSyncState } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

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
}

export async function getSyncState(sourceId: string): Promise<TriageSyncStateRecord | null> {
  const [row] = await db.select().from(triageSyncState).where(eq(triageSyncState.id, sourceId));
  if (!row) return null;
  return {
    id: row.id,
    lastCursor: row.lastCursor,
    lastSyncedAt: row.lastSyncedAt,
    totalImported: row.totalImported,
    totalSkipped: row.totalSkipped,
    lastRunImported: row.lastRunImported,
    lastRunSkipped: row.lastRunSkipped,
    lastRunErrors: Array.isArray(row.lastRunErrors) ? row.lastRunErrors as string[] : [],
    lastRunDurationMs: row.lastRunDurationMs,
  };
}

export async function getAllSyncStates(): Promise<TriageSyncStateRecord[]> {
  const rows = await db.select().from(triageSyncState);
  return rows.map((row) => ({
    id: row.id,
    lastCursor: row.lastCursor,
    lastSyncedAt: row.lastSyncedAt,
    totalImported: row.totalImported,
    totalSkipped: row.totalSkipped,
    lastRunImported: row.lastRunImported,
    lastRunSkipped: row.lastRunSkipped,
    lastRunErrors: Array.isArray(row.lastRunErrors) ? row.lastRunErrors as string[] : [],
    lastRunDurationMs: row.lastRunDurationMs,
  }));
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
) {
  const now = new Date().toISOString();
  const errorsJson = JSON.stringify(update.errors);

  await db.run(sql`
    INSERT INTO triage_sync_state (
      id, last_cursor, last_synced_at,
      total_imported, total_skipped,
      last_run_imported, last_run_skipped,
      last_run_errors, last_run_duration_ms
    ) VALUES (
      ${sourceId},
      ${update.lastCursor ?? null},
      ${now},
      ${update.imported},
      ${update.skipped},
      ${update.imported},
      ${update.skipped},
      ${errorsJson},
      ${update.durationMs}
    )
    ON CONFLICT(id) DO UPDATE SET
      last_cursor = COALESCE(${update.lastCursor ?? null}, triage_sync_state.last_cursor),
      last_synced_at = ${now},
      total_imported = triage_sync_state.total_imported + ${update.imported},
      total_skipped = triage_sync_state.total_skipped + ${update.skipped},
      last_run_imported = ${update.imported},
      last_run_skipped = ${update.skipped},
      last_run_errors = ${errorsJson},
      last_run_duration_ms = ${update.durationMs}
  `);
}
