import { randomUUID } from 'node:crypto';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { PostgresSyncJobRepository } from '@/db/postgres/sync/job-repository';
import { runSyncJobRepositoryContract } from '../contracts/sync-job-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-sync-job-contract-test',
        }),
      }
    : {}),
});
let repository: PostgresSyncJobRepository;
const connectorIds = new Set<string>();

runSyncJobRepositoryContract('PostgreSQL sync job repository contract', {
  enabled: Boolean(connectionString),
  async setup() {
    assertSafeIntegrationTestTarget(connectionString!);
    await backend.initialize();
    repository = new PostgresSyncJobRepository(backend.context.pool);
  },
  async reset() {
    for (const id of connectorIds) {
      await backend.context.pool.query(
        'DELETE FROM connector_operation_leases WHERE connector_id = $1',
        [id],
      );
      await backend.context.pool.query('DELETE FROM sync_jobs WHERE connector_id = $1', [id]);
      await backend.context.pool.query('DELETE FROM connector_configs WHERE id = $1', [id]);
    }
    connectorIds.clear();
  },
  async teardown() {
    await backend.shutdown();
  },
  repository: () => repository,
  async createConnector(label) {
    const id = `pg-contract-${label}-${randomUUID()}`;
    const now = new Date().toISOString();
    await backend.context.pool.query(
      `INSERT INTO connector_configs (
         id, type, name, enabled, capabilities, credentials, settings,
         synced_lists, created_at, updated_at
       ) VALUES ($1, 'test', $2, true, '{}', '{}', '{}', '[]', $3, $3)`,
      [id, label, now],
    );
    connectorIds.add(id);
    return id;
  },
  async makeRunnable(jobId) {
    await backend.context.pool.query(
      `UPDATE sync_jobs SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`,
      [jobId],
    );
  },
});
