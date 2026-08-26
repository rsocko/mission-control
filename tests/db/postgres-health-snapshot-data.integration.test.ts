import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { collectPostgresHealthSnapshotData } from '@/db/postgres/health-snapshot-data';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL health snapshot data integration', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-health-snapshot-data-test',
          }),
        }
      : {}),
  });
  const connectorIds = new Set<string>();

  beforeAll(async () => {
    if (connectionString) assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
  }, 120_000);

  afterAll(async () => {
    for (const id of connectorIds) {
      await backend.context.pool.query('DELETE FROM connector_configs WHERE id = $1', [id]);
    }
    await backend.shutdown();
  });

  async function insertConnector(id: string, overrides: { enabled?: boolean } = {}) {
    const now = new Date().toISOString();
    await backend.context.pool.query(
      `
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, poll_interval_minutes,
          capabilities, credentials, settings, synced_lists, created_at, updated_at
        ) VALUES ($1, 'test', $1, $2, 'poll', 5, '{}', '{}', '{}', '[]', $3, $3)
      `,
      [id, overrides.enabled ?? true, now],
    );
    connectorIds.add(id);
  }

  async function insertSyncLog(
    id: string,
    connectorId: string,
    success: boolean,
    syncedAt: string,
  ) {
    await backend.context.pool.query(
      `
        INSERT INTO sync_log (id, connector_id, success, synced_at)
        VALUES ($1, $2, $3, $4)
      `,
      [id, connectorId, success, syncedAt],
    );
  }

  async function insertDependencySnapshot(overrides: {
    id: string;
    connectorInstanceId: string;
    status: 'running' | 'failed' | 'partial' | 'completed';
    startedAt: string;
    completedAt?: string | null;
  }) {
    await backend.context.pool.query(
      `
        INSERT INTO dependency_reconciliation_snapshots (
          id, connector_instance_id, status, total, batch_size, started_at, updated_at, completed_at
        ) VALUES ($1, $2, $3, 10, 25, $4, $4, $5)
      `,
      [
        overrides.id,
        overrides.connectorInstanceId,
        overrides.status,
        overrides.startedAt,
        overrides.completedAt ?? null,
      ],
    );
  }

  it('returns the connector configs', async () => {
    const id = `health-connector-${randomUUID()}`;
    await insertConnector(id);

    const result = await collectPostgresHealthSnapshotData(backend.context.db, { maxConnectors: 1_000 });

    expect(result.configs.some((config) => config.id === id)).toBe(true);
  });

  it('reports the latest and latest-successful sync per connector', async () => {
    const id = `health-connector-sync-${randomUUID()}`;
    await insertConnector(id);
    await insertSyncLog(`log-${randomUUID()}`, id, true, '2026-01-01T00:00:00.000Z');
    await insertSyncLog(`log-${randomUUID()}`, id, false, '2026-01-02T00:00:00.000Z');

    const result = await collectPostgresHealthSnapshotData(backend.context.db, { maxConnectors: 1_000 });

    const latest = result.latestSyncPerConnector.find((entry) => entry.connectorId === id);
    expect(latest?.success).toBe(false);
    expect(latest?.syncedAt).toBe('2026-01-02T00:00:00.000Z');

    const latestSuccessful = result.latestSuccessfulSyncPerConnector.find(
      (entry) => entry.connectorId === id,
    );
    expect(latestSuccessful?.syncedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('computes dependency-reconciliation health with the latest and last-completed snapshot', async () => {
    const id = `health-connector-dep-${randomUUID()}`;
    await insertConnector(id);
    await insertDependencySnapshot({
      id: `snap-completed-${randomUUID()}`,
      connectorInstanceId: id,
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
    });
    await insertDependencySnapshot({
      id: `snap-latest-${randomUUID()}`,
      connectorInstanceId: id,
      status: 'failed',
      startedAt: '2026-01-02T00:00:00.000Z',
    });

    const result = await collectPostgresHealthSnapshotData(backend.context.db, { maxConnectors: 1_000 });

    const progress = result.dependencyHealth.get(id);
    expect(progress).toBeDefined();
    expect(progress?.status).toBe('failed');
    expect(progress?.lastCompletedAt).toBe('2026-01-01T00:05:00.000Z');
    expect(progress?.lastCompletedGeneration?.completedAt).toBe('2026-01-01T00:05:00.000Z');
    expect(progress?.consecutiveFailedGenerationCount).toBe(1);
  });

  it('throws when the connector limit is exceeded', async () => {
    await expect(
      collectPostgresHealthSnapshotData(backend.context.db, { maxConnectors: 0 }),
    ).rejects.toThrow('Health snapshot connector limit of 0 exceeded');
  });

  it('defers immediately when shouldDefer reports pending sync work', async () => {
    await expect(
      collectPostgresHealthSnapshotData(backend.context.db, {
        maxConnectors: 1_000,
        shouldDefer: () => true,
      }),
    ).rejects.toThrow('Health snapshot deferred because sync work became pending');
  });
});
