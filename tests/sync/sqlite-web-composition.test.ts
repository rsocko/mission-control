import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { _runMigrationsIndividually } from '@/db';

const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalNextRuntime = process.env.NEXT_RUNTIME;
const originalDatabasePath = process.env.MC_DB_PATH;
const testDirectory = mkdtempSync(join(tmpdir(), 'mc-sqlite-web-composition-'));
const databasePath = join(testDirectory, 'composition.db');
let closeSqlite: (() => void) | undefined;

vi.mock('@/lib/runtime/lifecycle', () => ({
  configureRuntimeLifecycle: vi.fn(),
  markRuntimeReady: vi.fn(),
}));
vi.mock('@/lib/runtime/startup', () => ({
  terminateFailedStartup: (error: unknown) => {
    throw error;
  },
}));
vi.mock('@/lib/public-demo', () => ({
  isPublicDemoMode: () => true,
}));
vi.mock('@/lib/public-demo-runtime', () => ({
  initializePublicDemoData: vi.fn(async () => undefined),
}));
vi.mock('@/lib/telemetry/runtime', () => ({
  startRuntimeTelemetry: vi.fn(async () => undefined),
}));

describe('SQLite web sync service composition', () => {
  beforeAll(async () => {
    process.env.MC_DATABASE_BACKEND = 'sqlite';
    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.MC_DB_PATH = databasePath;
    const fixtureDatabase = new Database(databasePath);
    try {
      _runMigrationsIndividually(fixtureDatabase, resolve(process.cwd(), 'drizzle'));
    } finally {
      fixtureDatabase.close();
    }

    const { register } = await import('@/instrumentation');
    await register();
    await register();
    const { sqlite } = await import('@/db');
    closeSqlite = sqlite.close.bind(sqlite);
  });

  afterAll(async () => {
    const { shutdownRuntimeDatabase } = await import('@/db/runtime');
    await shutdownRuntimeDatabase();
    closeSqlite?.();
    rmSync(testDirectory, { recursive: true, force: true });
    if (originalBackend === undefined) delete process.env.MC_DATABASE_BACKEND;
    else process.env.MC_DATABASE_BACKEND = originalBackend;
    if (originalNextRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalNextRuntime;
    if (originalDatabasePath === undefined) delete process.env.MC_DB_PATH;
    else process.env.MC_DB_PATH = originalDatabasePath;
  });

  it('registers the narrow connector, persistence, search, and enrichment services', async () => {
    const [
      { getConnectorRegistry },
      { getCorePersistenceRepositories },
      { getWorkerPersistenceRepositories },
      { getKeywordSearchRepository },
      { getLegacySearchIndexingService },
      { enrichWithAI },
      { publishSemanticEntityUpsert },
    ] = await Promise.all([
      import('@/lib/connectors/registry-runtime'),
      import('@/lib/persistence/runtime'),
      import('@/lib/persistence/worker-runtime'),
      import('@/lib/search/keyword-runtime'),
      import('@/lib/search/indexing-service'),
      import('@/lib/notifications/enrichment/ai-enrichment-service'),
      import('@/lib/semantic-index/publication-service'),
    ]);

    expect(getConnectorRegistry().getAllConnectors()).toEqual([]);
    await expect(
      getCorePersistenceRepositories().settings.get('l03-composition-missing'),
    ).resolves.toBeNull();
    await expect(
      getWorkerPersistenceRepositories(),
    ).resolves.toHaveProperty('execution');
    await expect(getKeywordSearchRepository().warmUp()).resolves.toBeUndefined();
    await expect(
      getLegacySearchIndexingService().warmUp(),
    ).resolves.toBeUndefined();
    await expect(enrichWithAI({
      notificationId: 'l03-no-ai',
      title: 'No enrichment needed',
      connectorType: 'test',
      category: 'informational',
      metadata: {},
      presentation: {},
    })).resolves.toBeNull();
    await expect(
      publishSemanticEntityUpsert('task', 'l03-missing-task'),
    ).resolves.toBeUndefined();
  });

  it('registers queue, lease, control, maintenance, and operator repositories', async () => {
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
    const connectorId = 'l03-web-composition-missing';

    await expect((await getSyncJobRepository()).countQueued()).resolves.toBeGreaterThanOrEqual(0);
    await expect((await getConnectorOperationLeaseRepository()).hasActiveSyncJobLease({
      connectorId,
      jobId: 'missing-job',
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
