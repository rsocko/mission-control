import type Database from 'better-sqlite3';
import type {
  HealthSnapshotStore,
  StoredHealthSnapshot,
} from './health-snapshot-store';

type WithoutObservation = <T>(callback: () => T) => T;

const SNAPSHOT_ID = 'current';

export class SqliteHealthSnapshotStore<TSummary>
implements HealthSnapshotStore<TSummary> {
  constructor(
    private readonly database: Database.Database,
    private readonly withoutObservation: WithoutObservation,
  ) {}

  async write(
    snapshot: StoredHealthSnapshot<TSummary>,
    validate: () => void = () => undefined,
  ): Promise<void> {
    this.withoutObservation(() => {
      const upsert = this.database.prepare(`
        INSERT INTO worker_health_snapshot (
          id, schema_version, generated_at, worker_instance_id,
          worker_revision, generation_duration_ms, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          schema_version = excluded.schema_version,
          generated_at = excluded.generated_at,
          worker_instance_id = excluded.worker_instance_id,
          worker_revision = excluded.worker_revision,
          generation_duration_ms = excluded.generation_duration_ms,
          payload = excluded.payload
      `);
      this.database.transaction(() => {
        validate();
        upsert.run(
          SNAPSHOT_ID,
          snapshot.schemaVersion,
          snapshot.generatedAt,
          snapshot.worker.instanceId,
          snapshot.worker.revision,
          snapshot.generationDurationMs,
          JSON.stringify(snapshot.summary),
        );
      }).immediate();
    });
  }

  async read(): Promise<StoredHealthSnapshot<TSummary> | null> {
    const row = this.withoutObservation(() => this.database.prepare(`
      SELECT schema_version AS schemaVersion, generated_at AS generatedAt,
        worker_instance_id AS workerInstanceId, worker_revision AS workerRevision,
        generation_duration_ms AS generationDurationMs, payload
      FROM worker_health_snapshot
      WHERE id = ?
    `).get(SNAPSHOT_ID)) as {
      schemaVersion: number;
      generatedAt: string;
      workerInstanceId: string;
      workerRevision: string;
      generationDurationMs: number;
      payload: string;
    } | undefined;
    if (!row) return null;
    return {
      schemaVersion: row.schemaVersion,
      generatedAt: row.generatedAt,
      worker: {
        instanceId: row.workerInstanceId,
        revision: row.workerRevision,
      },
      generationDurationMs: row.generationDurationMs,
      summary: JSON.parse(row.payload) as TSummary,
    };
  }
}
