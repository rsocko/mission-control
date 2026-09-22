import type Database from 'better-sqlite3';
import type {
  SyncRunRecord,
  SyncRunRepository,
  SyncRunSummary,
} from './worker-repositories';

interface SyncRunRow {
  connectorId: string;
  syncedAt: string;
  tasksAdded: number;
  tasksUpdated: number;
  tasksRemoved: number;
  notificationsAdded: number;
  durationMs: number | null;
}

export class SqliteSyncRunRepository implements SyncRunRepository {
  constructor(private readonly database: Database.Database) {}

  async listLatestSuccessfulPulls(): Promise<SyncRunSummary[]> {
    const rows = this.database.prepare(`
      WITH ranked AS (
        SELECT
          connector_id AS connectorId,
          synced_at AS syncedAt,
          tasks_added AS tasksAdded,
          tasks_updated AS tasksUpdated,
          tasks_removed AS tasksRemoved,
          alerts_added AS notificationsAdded,
          duration_ms AS durationMs,
          ROW_NUMBER() OVER (
            PARTITION BY connector_id
            ORDER BY synced_at DESC
          ) AS rank
        FROM sync_log
        WHERE success = 1 AND (duration_ms IS NULL OR duration_ms <> 0)
      )
      SELECT
        connectorId, syncedAt, tasksAdded, tasksUpdated, tasksRemoved,
        notificationsAdded, durationMs
      FROM ranked
      WHERE rank = 1
    `).all() as SyncRunRow[];

    return rows.map((row) => ({
      connectorId: row.connectorId,
      success: true,
      tasksAdded: row.tasksAdded,
      tasksUpdated: row.tasksUpdated,
      tasksRemoved: row.tasksRemoved,
      notificationsAdded: row.notificationsAdded,
      errors: [],
      syncedAt: row.syncedAt,
      durationMs: row.durationMs,
    }));
  }

  async append(record: SyncRunRecord): Promise<void> {
    this.database.prepare(`
      INSERT INTO sync_log (
        id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
        tasks_pushed, local_only_protected, alerts_added, errors, details,
        synced_at, duration_ms, job_id,
        identity_mode, identity_mode_revision
      ) VALUES (
        @id, @connectorId, @success, @tasksAdded, @tasksUpdated, @tasksRemoved,
        @tasksPushed, @localOnlyProtected, @notificationsAdded, @errors, @details,
        @syncedAt, @durationMs, @jobId,
        @identityMode, @identityRevision
      )
    `).run({
      id: record.id,
      connectorId: record.connectorId,
      success: record.success ? 1 : 0,
      tasksAdded: record.tasksAdded,
      tasksUpdated: record.tasksUpdated,
      tasksRemoved: record.tasksRemoved,
      tasksPushed: record.tasksPushed,
      localOnlyProtected: record.localOnlyProtected,
      notificationsAdded: record.notificationsAdded,
      errors: JSON.stringify(record.errors),
      details: JSON.stringify(record.details),
      syncedAt: record.syncedAt,
      durationMs: record.durationMs,
      jobId: record.jobId,
      identityMode: record.identityMode,
      identityRevision: record.identityModeRevision,
    });
  }
}
