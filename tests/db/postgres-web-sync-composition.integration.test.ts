import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');
vi.mock('@/db', () => {
  throw new Error('SQLite must not be evaluated by PostgreSQL web composition');
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalPostgresUrl = process.env.MC_POSTGRES_URL;

describePostgres('PostgreSQL web sync service composition', () => {
  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    process.env.MC_DATABASE_BACKEND = 'postgres';
    process.env.MC_POSTGRES_URL = connectionString!;
    const { initializeDatabaseWithRetry } = await import('@/db/startup');
    await initializeDatabaseWithRetry();
  }, 120_000);

  afterAll(async () => {
    const { shutdownRuntimeDatabase } = await import('@/db/runtime');
    await shutdownRuntimeDatabase();
    if (originalBackend === undefined) delete process.env.MC_DATABASE_BACKEND;
    else process.env.MC_DATABASE_BACKEND = originalBackend;
    if (originalPostgresUrl === undefined) delete process.env.MC_POSTGRES_URL;
    else process.env.MC_POSTGRES_URL = originalPostgresUrl;
  });

  it('calls each normal web service through PostgreSQL composition', async () => {
    const [
      { getConnectorRegistry },
      { getCorePersistenceRepositories },
      { getWorkerPersistenceRepositories },
      { getKeywordSearchRepository },
      { enrichWithAI },
      { publishSemanticEntityUpsert },
    ] = await Promise.all([
      import('@/lib/connectors/registry-runtime'),
      import('@/lib/persistence/runtime'),
      import('@/lib/persistence/worker-runtime'),
      import('@/lib/search/keyword-runtime'),
      import('@/lib/notifications/enrichment/ai-enrichment-service'),
      import('@/lib/semantic-index/publication-service'),
    ]);

    expect(getConnectorRegistry().getAllConnectors()).toEqual([]);
    await expect(
      getCorePersistenceRepositories().settings.get(`l03-${randomUUID()}`),
    ).resolves.toBeNull();
    await expect(
      getWorkerPersistenceRepositories(),
    ).resolves.toHaveProperty('execution');
    await expect(
      getKeywordSearchRepository().search(`l03-${randomUUID()}`),
    ).resolves.toEqual([]);
    await expect(enrichWithAI({
      notificationId: `l03-${randomUUID()}`,
      title: 'No enrichment needed',
      connectorType: 'test',
      category: 'informational',
      metadata: {},
      presentation: {},
    })).resolves.toBeNull();
    await expect(
      publishSemanticEntityUpsert('task', `l03-${randomUUID()}`),
    ).resolves.toEqual(expect.objectContaining({ status: 'skipped' }));
  });

  it('calls queue, lease, control, maintenance, and operator services', async () => {
    const [
      { getSyncJobRepository },
      { getConnectorOperationLeaseRepository },
      { isConnectorSyncQuarantinedAsync },
      { getConnectorMaintenanceLockRepository },
      { getFinanceSyncControlStatus, SyncOperatorError },
    ] = await Promise.all([
      import('@/lib/sync/job-runtime'),
      import('@/lib/sync/connector-lock-runtime'),
      import('@/lib/sync/control-state'),
      import('@/lib/sync/maintenance-lock'),
      import('@/lib/sync/operator-control'),
    ]);
    const connectorId = `l03-${randomUUID()}`;

    await expect((await getSyncJobRepository()).countQueued()).resolves.toBeGreaterThanOrEqual(0);
    await expect((await getConnectorOperationLeaseRepository()).hasActiveSyncJobLease({
      connectorId,
      jobId: `l03-${randomUUID()}`,
      at: new Date().toISOString(),
    })).resolves.toBe(false);
    await expect(isConnectorSyncQuarantinedAsync(connectorId)).resolves.toBe(false);
    await expect(
      (await getConnectorMaintenanceLockRepository()).get(connectorId),
    ).resolves.toBeNull();
    await expect(getFinanceSyncControlStatus(connectorId)).rejects.toEqual(
      expect.objectContaining({
        name: SyncOperatorError.name,
        code: 'finance_connector_not_found',
      }),
    );
  });

});
