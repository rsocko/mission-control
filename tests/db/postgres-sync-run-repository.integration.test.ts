import { eq } from 'drizzle-orm';
import { describe, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  createPostgresCoreRepositories,
  createPostgresWorkerPersistenceRepositories,
} from '@/db/postgres/repositories';
import { syncLog } from '@/db/postgres/schema';
import { describeSyncRunRepositoryContract } from '../contracts/sync-run-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL worker repositories integration', () => {
  describeSyncRunRepositoryContract('PostgreSQL', async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const backend = new PostgresPersistenceBackend({
      config: resolvePostgresConfig({
        MC_POSTGRES_URL: connectionString,
        MC_POSTGRES_APPLICATION_NAME: 'mission-control-worker-repositories-test',
      }),
    });
    await backend.initialize();
    const core = createPostgresCoreRepositories(backend.context.db);
    const repositories = createPostgresWorkerPersistenceRepositories(
      backend.context.db,
      backend.context.pool,
      core,
    );
    return {
      repository: repositories.syncRuns,
      deleteConnectorRuns: async (connectorId: string) => {
        await backend.context.db.delete(syncLog)
          .where(eq(syncLog.connectorId, connectorId));
      },
      close: () => backend.shutdown(),
    };
  });
});
