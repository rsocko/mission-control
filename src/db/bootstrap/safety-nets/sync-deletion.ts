import type Database from 'better-sqlite3';

export function applySyncDeletionSafetyNets(_sqlite: Database.Database): void {
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sync_deletion_candidates (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      first_missing_at TEXT NOT NULL,
      last_missing_at TEXT NOT NULL,
      missing_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_deletion_candidate_source
      ON sync_deletion_candidates (connector_id, source_id);
    CREATE INDEX IF NOT EXISTS idx_sync_deletion_candidate_task
      ON sync_deletion_candidates (task_id);
    CREATE TABLE IF NOT EXISTS sync_deletion_snapshots (
      id TEXT PRIMARY KEY,
      original_task_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      task_title TEXT NOT NULL,
      reason TEXT NOT NULL,
      task_data TEXT NOT NULL,
      relationship_data TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      restored_at TEXT,
      restored_task_id TEXT,
      restore_mode TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_deletion_snapshot_task
      ON sync_deletion_snapshots (original_task_id);
    CREATE INDEX IF NOT EXISTS idx_sync_deletion_snapshot_deleted
      ON sync_deletion_snapshots (deleted_at);
  `);
}
