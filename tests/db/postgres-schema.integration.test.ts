import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { PostgresHealthSnapshotStore } from '@/lib/telemetry/postgres-health-snapshot-store';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import {
  appSettings,
  connectorConfigs,
  tasks,
  workerHealthSnapshot,
} from '@/db/postgres/schema';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL schema integration', () => {
  let initialized = false;
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-schema-test',
          }),
        }
      : {}),
  });

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    await backend.initialize();
    initialized = true;
  }, 120_000);

  afterAll(async () => {
    if (!initialized) return;
    await backend.context.db.delete(appSettings).where(
      eq(appSettings.key, 'postgres-integration-setting'),
    );
    await backend.context.db.delete(connectorConfigs).where(
      eq(connectorConfigs.id, 'postgres-integration-connector'),
    );
    await backend.shutdown();
  });

  it('applies the complete PostgreSQL baseline', async () => {
    const result = await backend.context.pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
    `);

    expect(Number(result.rows[0]?.count)).toBe(
      backend.context.vector.available ? 166 : 165,
    );
  });

  it('round-trips booleans and JSON through the PostgreSQL schema', async () => {
    await backend.context.db.insert(connectorConfigs).values({
      id: 'postgres-integration-connector',
      type: 'test',
      name: 'PostgreSQL integration',
      enabled: false,
      capabilities: { read: true },
      credentials: {},
      settings: { mode: 'integration' },
      syncedLists: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).onConflictDoNothing();

    const [row] = await backend.context.db
      .select()
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, 'postgres-integration-connector'));

    expect(row).toMatchObject({
      enabled: false,
      capabilities: { read: true },
      settings: { mode: 'integration' },
    });
  });

  it('rolls back failed asynchronous transactions', async () => {
    const failure = new Error('rollback probe');

    await expect(backend.asyncTransactions.run(async (transaction) => {
      await transaction.insert(appSettings).values({
        key: 'postgres-integration-setting',
        value: { persisted: false },
        updatedAt: new Date().toISOString(),
      });
      throw failure;
    }, { access: 'write' })).rejects.toBe(failure);

    const rows = await backend.context.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, 'postgres-integration-setting'));
    expect(rows).toEqual([]);
  });

  it('materializes and indexes task search vectors', async () => {
    const indexes = await backend.context.db.execute<{
      indexname: string;
    }>(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'tasks'
        AND indexname = 'idx_tasks_search_vector'
    `);
    expect(indexes.rows).toEqual([
      { indexname: 'idx_tasks_search_vector' },
    ]);

    expect(tasks.searchVector).toBeDefined();
  });

  it('round-trips the worker health snapshot through PostgreSQL', async () => {
    const store = new PostgresHealthSnapshotStore<{ status: string }>(
      backend.context.db,
    );
    const previous = await store.read();
    const snapshot = {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      worker: {
        instanceId: 'postgres-integration-worker',
        revision: 'test',
      },
      generationDurationMs: 12,
      summary: { status: 'healthy' },
    };

    try {
      await store.write(snapshot);
      await expect(store.read()).resolves.toEqual(snapshot);
    } finally {
      if (previous) {
        await store.write(previous);
      } else {
        await backend.context.db.delete(workerHealthSnapshot).where(
          eq(workerHealthSnapshot.id, 'current'),
        );
      }
    }
  });
});
