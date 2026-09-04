import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { PostgresSyncJobRepository } from '@/db/postgres/sync/job-repository';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL sync job repository integration', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-sync-job-repository-test',
          }),
        }
      : {}),
  });
  let repository: PostgresSyncJobRepository;
  const connectorIds = new Set<string>();

  beforeAll(async () => {
    if (connectionString) assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
    repository = new PostgresSyncJobRepository(backend.context.pool);
  }, 120_000);

  afterEach(async () => {
    for (const id of connectorIds) {
      await backend.context.pool.query('DELETE FROM sync_log WHERE connector_id = $1', [id]);
      await backend.context.pool.query('DELETE FROM sync_jobs WHERE connector_id = $1', [id]);
      await backend.context.pool.query('DELETE FROM connector_operation_leases WHERE connector_id = $1', [id]);
      await backend.context.pool.query('DELETE FROM connector_configs WHERE id = $1', [id]);
    }
    connectorIds.clear();
  });

  afterAll(async () => {
    await backend.shutdown();
  });

  async function createConnector(): Promise<string> {
    const id = `connector-${randomUUID()}`;
    const now = new Date().toISOString();
    await backend.context.pool.query(
      `
        INSERT INTO connector_configs (id, type, name, enabled, capabilities, credentials, settings, synced_lists, created_at, updated_at)
        VALUES ($1, 'test', 'Sync job integration', true, '{}', '{}', '{}', '[]', $2, $2)
      `,
      [id, now],
    );
    connectorIds.add(id);
    return id;
  }

  it('enqueues a job and claims it exactly once under concurrent claim attempts', async () => {
    const connectorId = await createConnector();
    const job = await repository.enqueue(connectorId);
    expect(job.status).toBe('queued');

    const [first, second, third] = await Promise.all([
      repository.claimNext('worker-a', 60_000),
      repository.claimNext('worker-b', 60_000),
      repository.claimNext('worker-c', 60_000),
    ]);
    const claimed = [first, second, third].filter((result) => result?.id === job.id);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('running');
    expect(claimed[0]?.attempt).toBe(1);

    const owner = [first, second, third].find((result) => result !== null)?.leaseOwner;
    expect(owner).toBeTruthy();
  });

  it('completes a claimed job and releases its connector lease', async () => {
    const connectorId = await createConnector();
    const job = await repository.enqueue(connectorId);
    const claimed = await repository.claimNext('worker-complete', 60_000);
    expect(claimed?.id).toBe(job.id);

    await repository.complete(job.id, 'worker-complete', claimed!.attempt, {
      connectorId,
      success: true,
      tasksAdded: 1,
      tasksUpdated: 0,
      tasksRemoved: 0,
      notificationsAdded: 0,
      errors: [],
      syncedAt: new Date().toISOString(),
    });

    const final = await repository.get(job.id);
    expect(final?.status).toBe('succeeded');
    expect(final?.result?.success).toBe(true);
    expect(final?.leaseOwner).toBeNull();

    // The connector lease must be released so the connector can be claimed again.
    const nextJob = await repository.enqueue(connectorId);
    const nextClaim = await repository.claimNext('worker-complete-2', 60_000);
    expect(nextClaim?.id).toBe(nextJob.id);
    await repository.release(
      nextJob.id,
      'worker-complete-2',
      nextClaim!.attempt,
      'test cleanup',
    );
  });

  it('fences a stale attempt when a retry is reclaimed by the same owner', async () => {
    const connectorId = await createConnector();
    const queued = await repository.enqueue(connectorId, { maxAttempts: 2 });
    const first = await repository.claimNext('worker-retry', 60_000);
    expect(first?.id).toBe(queued.id);
    await expect(repository.fail(first!, 'worker-retry', 'retry')).resolves.toBe('queued');
    await backend.context.pool.query(
      `UPDATE sync_jobs SET available_at = now() - interval '1 second' WHERE id = $1`,
      [queued.id],
    );
    const second = await repository.claimNext('worker-retry', 60_000);
    expect(second?.attempt).toBe(first!.attempt + 1);

    await expect(repository.renewLease(
      first!.id,
      'worker-retry',
      first!.attempt,
      60_000,
    )).resolves.toBe(false);
    await expect(repository.complete(first!.id, 'worker-retry', first!.attempt, {
      connectorId,
      success: true,
      tasksAdded: 0,
      tasksUpdated: 0,
      tasksRemoved: 0,
      notificationsAdded: 0,
      errors: [],
      syncedAt: new Date().toISOString(),
    })).rejects.toThrow(/ownership was lost/);
    await expect(repository.fail(first!, 'worker-retry', 'stale failure'))
      .rejects.toThrow(/ownership was lost/);
    await expect(repository.release(
      first!.id,
      'worker-retry',
      first!.attempt,
      'stale release',
    )).resolves.toBe(false);
    expect((await repository.get(second!.id))?.status).toBe('running');
  });

    it('atomically links the exact owned log while completing and releasing', async () => {
      const connectorId = await createConnector();
      const job = await repository.enqueue(connectorId);
      const claimed = await repository.claimNext('worker-atomic-complete', 60_000);
      const syncedAt = new Date().toISOString();
      const syncRunId = `sync-${randomUUID()}`;
      await backend.context.pool.query(
        `
          INSERT INTO sync_log (
            id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
            tasks_pushed, local_only_protected, alerts_added, errors, details,
            synced_at, job_id
          ) VALUES ($1, $2, false, 0, 0, 0, 0, 0, 0, '[]', '[]', $3, NULL)
        `,
        [syncRunId, connectorId, syncedAt],
      );
      const result = {
        connectorId,
        success: true,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        notificationsAdded: 0,
        errors: [],
        syncedAt,
        syncRunId,
      };

      await repository.finalizeSuccess(
        claimed!,
        'worker-atomic-complete',
        result,
      );

      await expect(repository.get(job.id)).resolves.toMatchObject({
        status: 'succeeded',
        result: { syncRunId },
      });
      const linked = await backend.context.pool.query(
        'SELECT success, job_id AS "jobId", trigger, attempt FROM sync_log WHERE id = $1',
        [syncRunId],
      );
      expect(linked.rows[0]).toEqual({
        success: true,
        jobId: job.id,
        trigger: 'api',
        attempt: 1,
      });
    });

    it('does not mutate the exact log when finalization ownership is lost', async () => {
      const connectorId = await createConnector();
      const job = await repository.enqueue(connectorId);
      const claimed = await repository.claimNext('worker-owner', 60_000);
      const syncedAt = new Date().toISOString();
      const syncRunId = `sync-${randomUUID()}`;
      await backend.context.pool.query(
        `
          INSERT INTO sync_log (
            id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
            tasks_pushed, local_only_protected, alerts_added, errors, details,
            synced_at, job_id
          ) VALUES ($1, $2, false, 0, 0, 0, 0, 0, 0, '[]', '[]', $3, NULL)
        `,
        [syncRunId, connectorId, syncedAt],
      );

      await expect(repository.finalizeSuccess(claimed!, 'other-worker', {
        connectorId,
        success: true,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        notificationsAdded: 0,
        errors: [],
        syncedAt,
        syncRunId,
      })).rejects.toThrow(/ownership was lost/);
      const log = await backend.context.pool.query(
        'SELECT success, job_id AS "jobId", trigger, attempt FROM sync_log WHERE id = $1',
        [syncRunId],
      );
      expect(log.rows[0]).toEqual({
        success: false,
        jobId: null,
        trigger: null,
        attempt: null,
      });
      await repository.release(job.id, 'worker-owner', claimed!.attempt, 'test cleanup');
    });

    it('does not publish a provisional success after the job lease expires', async () => {
      const connectorId = await createConnector();
      const job = await repository.enqueue(connectorId);
      const claimed = await repository.claimNext('worker-expired', 60_000);
      const syncedAt = new Date().toISOString();
      const syncRunId = `sync-${randomUUID()}`;
      await backend.context.pool.query(
        `
          INSERT INTO sync_log (
            id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
            tasks_pushed, local_only_protected, alerts_added, errors, details,
            synced_at, job_id
          ) VALUES ($1, $2, false, 0, 0, 0, 0, 0, 0, '[]', '[]', $3, NULL)
        `,
        [syncRunId, connectorId, syncedAt],
      );
      await backend.context.pool.query(
        `UPDATE sync_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1`,
        [job.id],
      );

      await expect(repository.finalizeSuccess(claimed!, 'worker-expired', {
        connectorId,
        success: true,
        tasksAdded: 0,
        tasksUpdated: 0,
        tasksRemoved: 0,
        notificationsAdded: 0,
        errors: [],
        syncedAt,
        syncRunId,
      })).rejects.toThrow(/ownership was lost/);
      const log = await backend.context.pool.query(
        'SELECT success, job_id AS "jobId" FROM sync_log WHERE id = $1',
        [syncRunId],
      );
      expect(log.rows[0]).toEqual({ success: false, jobId: null });
    });

  it('requeues a failed job for retry and marks the retry available in the future', async () => {
    const connectorId = await createConnector();
    const job = await repository.enqueue(connectorId);
    const claimed = await repository.claimNext('worker-fail', 60_000);
    expect(claimed?.id).toBe(job.id);

    const status = await repository.fail(
      claimed!,
      'worker-fail',
      'simulated failure',
    );
    expect(status).toBe('queued');

    const retried = await repository.get(job.id);
    expect(retried?.status).toBe('queued');
    expect(new Date(retried!.availableAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('reports queue metrics reflecting queued and running jobs', async () => {
    const connectorId = await createConnector();
    await repository.enqueue(connectorId);
    await expect(repository.countQueued()).resolves.toBeGreaterThanOrEqual(1);
    const metrics = await repository.getMetrics();
    expect(metrics.queued).toBeGreaterThanOrEqual(1);
  });

  it('excludes connector ids passed to claimNext and still claims a non-excluded job', async () => {
    const excludedConnectorId = await createConnector();
    const claimableConnectorId = await createConnector();
    const excludedJob = await repository.enqueue(excludedConnectorId);
    const claimableJob = await repository.enqueue(claimableConnectorId);

    // A regression here (the exclusion clause's placeholders binding to the
    // wrong parameter index) would either throw a parameter-count error or
    // silently ignore the exclusion set and claim the excluded job instead.
    const claimed = await repository.claimNext(
      'worker-exclusion',
      60_000,
      new Set([excludedConnectorId]),
    );
    expect(claimed?.id).toBe(claimableJob.id);
    expect(claimed?.connectorId).toBe(claimableConnectorId);

    const stillQueued = await repository.get(excludedJob.id);
    expect(stillQueued?.status).toBe('queued');

    await repository.release(
      claimableJob.id,
      'worker-exclusion',
      claimed!.attempt,
      'test cleanup',
    );
  });
});
