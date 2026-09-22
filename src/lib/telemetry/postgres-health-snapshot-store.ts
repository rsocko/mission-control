import { eq } from 'drizzle-orm';
import type { PostgresDatabase } from '@/db/postgres/runtime';
import { workerHealthSnapshot } from '@/db/postgres/schema';
import type {
  HealthSnapshotStore,
  StoredHealthSnapshot,
} from './health-snapshot-store';

const SNAPSHOT_ID = 'current';

export class PostgresHealthSnapshotStore<TSummary>
implements HealthSnapshotStore<TSummary> {
  constructor(private readonly database: PostgresDatabase) {}

  async write(
    snapshot: StoredHealthSnapshot<TSummary>,
    validate: () => void = () => undefined,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      validate();
      await transaction.insert(workerHealthSnapshot).values({
        id: SNAPSHOT_ID,
        schemaVersion: snapshot.schemaVersion,
        generatedAt: snapshot.generatedAt,
        workerInstanceId: snapshot.worker.instanceId,
        workerRevision: snapshot.worker.revision,
        generationDurationMs: snapshot.generationDurationMs,
        payload: snapshot.summary,
      }).onConflictDoUpdate({
        target: workerHealthSnapshot.id,
        set: {
          schemaVersion: snapshot.schemaVersion,
          generatedAt: snapshot.generatedAt,
          workerInstanceId: snapshot.worker.instanceId,
          workerRevision: snapshot.worker.revision,
          generationDurationMs: snapshot.generationDurationMs,
          payload: snapshot.summary,
        },
      });
    });
  }

  async read(): Promise<StoredHealthSnapshot<TSummary> | null> {
    const rows = await this.database.select()
      .from(workerHealthSnapshot)
      .where(eq(workerHealthSnapshot.id, SNAPSHOT_ID))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      schemaVersion: row.schemaVersion,
      generatedAt: row.generatedAt,
      worker: {
        instanceId: row.workerInstanceId,
        revision: row.workerRevision,
      },
      generationDurationMs: row.generationDurationMs,
      summary: row.payload as TSummary,
    };
  }
}
