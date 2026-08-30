import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';
import type {
  SyncRunRecord,
  SyncRunRepository,
  SyncRunSummary,
} from '@/db/persistence/worker-repositories';
import type { PostgresDatabase } from '../runtime';
import { syncLog } from '../schema';

export class PostgresSyncRunRepository implements SyncRunRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async listLatestSuccessfulPulls(): Promise<SyncRunSummary[]> {
    const rows = await this.db
      .selectDistinctOn([syncLog.connectorId], {
        connectorId: syncLog.connectorId,
        syncedAt: syncLog.syncedAt,
        tasksAdded: syncLog.tasksAdded,
        tasksUpdated: syncLog.tasksUpdated,
        tasksRemoved: syncLog.tasksRemoved,
        tasksPushed: syncLog.tasksPushed,
        notificationsAdded: syncLog.notificationsAdded,
        durationMs: syncLog.durationMs,
      })
      .from(syncLog)
      .where(and(
        eq(syncLog.success, true),
        or(isNull(syncLog.durationMs), ne(syncLog.durationMs, 0)),
      ))
      .orderBy(syncLog.connectorId, desc(syncLog.syncedAt));

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
    await this.db.insert(syncLog).values({
      id: record.id,
      connectorId: record.connectorId,
      success: record.success,
      tasksAdded: record.tasksAdded,
      tasksUpdated: record.tasksUpdated,
      tasksRemoved: record.tasksRemoved,
      tasksPushed: record.tasksPushed,
      localOnlyProtected: record.localOnlyProtected,
      notificationsAdded: record.notificationsAdded,
      errors: [...record.errors],
      details: [...record.details],
      syncedAt: record.syncedAt,
      durationMs: record.durationMs,
      jobId: record.jobId,
      identityMode: record.identityMode,
      identityModeRevision: record.identityModeRevision,
    });
  }
}
