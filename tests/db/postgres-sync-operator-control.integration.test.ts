import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { PostgresSyncJobRepository } from '@/db/postgres/sync/job-repository';
import {
  PostgresSyncOperatorControlRepository,
} from '@/db/postgres/sync/operator-control-repository';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL sync operator-control integration', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-sync-operator-test',
          }),
        }
      : {}),
  });
  const connectorIds = new Set<string>();
  let jobs: PostgresSyncJobRepository;
  let operator: PostgresSyncOperatorControlRepository;

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    process.env.TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION = '7';
    process.env.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED = 'true';
    await backend.initialize();
    jobs = new PostgresSyncJobRepository(backend.context.pool);
    operator = new PostgresSyncOperatorControlRepository(backend.context.pool, jobs);
  }, 120_000);

  afterEach(async () => {
    for (const id of connectorIds) {
      await backend.context.pool.query(
        'DELETE FROM connector_sync_operator_runs WHERE connector_id = $1',
        [id],
      );
      await backend.context.pool.query(
        'DELETE FROM connector_sync_controls WHERE connector_id = $1',
        [id],
      );
      await backend.context.pool.query('DELETE FROM sync_schedules WHERE connector_id = $1', [id]);
      await backend.context.pool.query(
        'DELETE FROM connector_operation_leases WHERE connector_id = $1',
        [id],
      );
      await backend.context.pool.query('DELETE FROM sync_jobs WHERE connector_id = $1', [id]);
      await backend.context.pool.query('DELETE FROM connector_configs WHERE id = $1', [id]);
    }
    connectorIds.clear();
  });

  afterAll(async () => {
    await backend.shutdown();
    delete process.env.TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION;
    delete process.env.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED;
  });

  async function createFinanceConnector(): Promise<string> {
    const id = `pg-finance-operator-${randomUUID()}`;
    const now = new Date().toISOString();
    await backend.context.pool.query(
      `INSERT INTO connector_configs (
         id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
         credentials, settings, synced_lists, created_at, updated_at
       ) VALUES (
         $1, 'finance-manager', 'Finance operator', false, 'poll', 240, '{}',
         '{"serviceToken":"invented-token"}',
         '{"bridgeUrl":"https://tyrion.example/api/connector/v1","householdCurrency":"USD"}',
         '[]', $2, $2
       )`,
      [id, now],
    );
    connectorIds.add(id);
    return id;
  }

  it('quarantines idempotently and preserves the operator status shape', async () => {
    const connectorId = await createFinanceConnector();
    await jobs.registerSchedule(connectorId, 240);
    await jobs.enqueue(connectorId, { source: 'schedule' });
    const input = {
      connectorId,
      actorType: 'service' as const,
      idempotencyKey: `pg-operator-quarantine-${randomUUID()}`,
    };

    await expect(operator.quarantine(input)).resolves.toMatchObject({
      status: 'quarantined',
      cancelledQueuedCount: 1,
      replayed: false,
    });
    await expect(operator.quarantine(input)).resolves.toMatchObject({
      status: 'quarantined',
      cancelledQueuedCount: 1,
      replayed: true,
    });
    await expect(operator.getStatus(connectorId)).resolves.toMatchObject({
      connector: { id: connectorId, enabled: false },
      scheduler: { state: 'quarantined', queued: 0, running: 0 },
    });
    expect(
      (await jobs.getSchedules()).filter((schedule) => schedule.connectorId === connectorId),
    ).toEqual([]);
    await expect(jobs.enqueue(connectorId, { source: 'api' }))
      .rejects.toThrow('connector_sync_quarantined');
    const queued = await backend.context.pool.query(
      `SELECT 1 FROM sync_jobs WHERE connector_id = $1 AND status = 'queued'`,
      [connectorId],
    );
    expect(queued.rowCount).toBe(0);
  });

  it('authorizes one canary and releases only after its successful attempt', async () => {
    const connectorId = await createFinanceConnector();
    await operator.quarantine({
      connectorId,
      actorType: 'service',
      idempotencyKey: `pg-operator-quarantine-${randomUUID()}`,
    });
    const canary = await operator.enqueueCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey: `pg-operator-canary-${randomUUID()}`,
    });
    const claimed = await jobs.claimNext('pg-operator-worker', 60_000);
    expect(claimed?.id).toBe(canary.job.id);
    await jobs.complete(claimed!.id, 'pg-operator-worker', claimed!.attempt, {
      connectorId,
      success: true,
      tasksAdded: 1,
      tasksUpdated: 2,
      tasksRemoved: 0,
      notificationsAdded: 0,
      errors: [],
      syncedAt: new Date().toISOString(),
    });
    await backend.context.pool.query(
      'UPDATE connector_configs SET enabled = true WHERE id = $1',
      [connectorId],
    );

    await expect(operator.release({
      connectorId,
      actorType: 'service',
      idempotencyKey: `pg-operator-release-${randomUUID()}`,
    })).resolves.toEqual({ status: 'released', replayed: false });
    expect(
      (await jobs.getSchedules()).filter((schedule) => schedule.connectorId === connectorId),
    ).toEqual([
      expect.objectContaining({ connectorId, intervalMinutes: 240 }),
    ]);
  });

  it('rolls back the operator run when canary enqueue fails', async () => {
    const connectorId = await createFinanceConnector();
    await operator.quarantine({
      connectorId,
      actorType: 'service',
      idempotencyKey: `pg-operator-quarantine-${randomUUID()}`,
    });
    const idempotencyKey = `pg-operator-canary-${randomUUID()}`;
    class FailingJobRepository extends PostgresSyncJobRepository {
      override async enqueueWithClient(): Promise<never> {
        throw new Error('injected enqueue failure');
      }
    }
    const failingOperator = new PostgresSyncOperatorControlRepository(
      backend.context.pool,
      new FailingJobRepository(backend.context.pool),
    );

    await expect(failingOperator.enqueueCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey,
    })).rejects.toThrow('injected enqueue failure');

    const runs = await backend.context.pool.query(
      `SELECT 1 FROM connector_sync_operator_runs
       WHERE connector_id = $1 AND idempotency_key = $2`,
      [connectorId, idempotencyKey],
    );
    expect(runs.rowCount).toBe(0);
    await expect(operator.getStatus(connectorId)).resolves.toMatchObject({
      scheduler: { state: 'quarantined', queued: 0, running: 0 },
      canary: { status: 'not-started', jobId: null },
    });
  });

  it('atomically cancels a queued canary and rotates the quarantine fence', async () => {
    const connectorId = await createFinanceConnector();
    const quarantine = await operator.quarantine({
      connectorId,
      actorType: 'service',
      idempotencyKey: `pg-operator-quarantine-${randomUUID()}`,
    });
    const canary = await operator.enqueueCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey: `pg-operator-canary-${randomUUID()}`,
    });

    await expect(operator.rollback({
      connectorId,
      actorType: 'service',
      idempotencyKey: `pg-operator-rollback-${randomUUID()}`,
    })).resolves.toMatchObject({
      status: 'quarantined',
      cancelledQueuedCount: 1,
      cancellationRequestedCount: 0,
      replayed: false,
      quarantineId: expect.not.stringMatching(quarantine.quarantineId!),
    });
    await expect(jobs.get(canary.job.id)).resolves.toMatchObject({
      status: 'cancelled',
      error: 'Cancelled by operator canary rollback',
    });
  });
});
