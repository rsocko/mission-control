import { mkdtempSync, rmSync } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncResult } from '@/types';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const directory = mkdtempSync(join(tmpdir(), 'mc-finance-operator-'));
process.env.MC_DB_PATH = join(directory, 'operator.db');
process.env.FINANCE_MANAGER_API_TOKEN = 'invented-service-token';
process.env.TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION = '7';
process.env.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED = 'true';
delete process.env.TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED;
delete process.env.TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED;

let sqlite: typeof import('@/db').sqlite;
let queue: typeof import('@/lib/sync/job-queue');
let operator: typeof import('@/lib/sync/operator-control');
const raceProcesses = new Set<ChildProcess>();

const connectorId = 'finance-operator-test';
const now = '2026-08-22T12:00:00.000Z';

function successfulResult(): SyncResult {
  return {
    connectorId,
    success: true,
    tasksAdded: 2,
    tasksUpdated: 3,
    tasksRemoved: 1,
    notificationsAdded: 0,
    errors: [],
    syncedAt: now,
  };
}

function key(suffix: string): string {
  return `finance-operator-${suffix.padEnd(20, 'x')}`;
}

function startRaceProcess(action: 'quarantine' | 'enqueue') {
  const child = fork(
    join(process.cwd(), 'tests', 'sync', 'fixtures', 'finance-operator-race-process.ts'),
    [connectorId, action],
    {
      execArgv: ['--conditions', 'react-server', '--import', 'tsx'],
      env: { ...process.env, MC_DB_PATH: process.env.MC_DB_PATH },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  raceProcesses.add(child);
  child.once('exit', () => raceProcesses.delete(child));
  return child;
}

function nextMessage(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('message', (message) => resolve(message as Record<string, unknown>));
  });
}

beforeAll(async () => {
  ({ sqlite } = await import('@/db'));
  const { registerSqliteSyncInfrastructure } = await import(
    '@/db/persistence/sqlite-sync-runtime'
  );
  registerSqliteSyncInfrastructure();
  queue = await import('@/lib/sync/job-queue');
  operator = await import('@/lib/sync/operator-control');
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM connector_sync_operator_runs;
    DELETE FROM connector_sync_controls;
    DELETE FROM connector_operation_leases;
    DELETE FROM sync_job_events;
    DELETE FROM sync_jobs;
    DELETE FROM sync_schedules;
    DELETE FROM connector_configs;
  `);
  sqlite.prepare(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
      credentials, settings, synced_lists, created_at, updated_at, deleted_at
    ) VALUES (?, 'finance-manager', 'Tyrion', 0, 'poll', 240, '{}', '{}', ?, '[]', ?, ?, NULL)
  `).run(
    connectorId,
    JSON.stringify({
      bridgeUrl: 'https://tyrion.example/api/connector/v1',
      householdCurrency: 'USD',
    }),
    now,
    now,
  );
});

afterAll(() => {
  for (const child of raceProcesses) {
    if (child.exitCode === null) child.kill();
  }
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.MC_DB_PATH;
  delete process.env.FINANCE_MANAGER_API_TOKEN;
  delete process.env.TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION;
  delete process.env.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED;
});

describe.sequential('finance operator sync control', () => {
  it('serializes scheduler enqueue against quarantine without leaving raced work', async () => {
    const quarantine = startRaceProcess('quarantine');
    const enqueue = startRaceProcess('enqueue');
    await Promise.all([nextMessage(quarantine), nextMessage(enqueue)]);
    const quarantineResult = nextMessage(quarantine);
    const enqueueResult = nextMessage(enqueue);
    const quarantineExit = once(quarantine, 'exit');
    const enqueueExit = once(enqueue, 'exit');
    quarantine.send('start');
    enqueue.send('start');
    const [quarantineMessage, enqueueMessage] = await Promise.all([
      quarantineResult,
      enqueueResult,
    ]);
    await Promise.all([quarantineExit, enqueueExit]);

    expect(quarantineMessage).toMatchObject({
      action: 'quarantine',
      status: 'succeeded',
    });
    expect(enqueueMessage).toEqual(expect.objectContaining({ action: 'enqueue' }));
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM sync_jobs
      WHERE connector_id = ? AND status IN ('queued', 'running')
    `).get(connectorId)).toEqual({ count: 0 });
  }, 15_000);

  it('atomically cancels queued work, removes schedules, and rejects automatic enqueue', async () => {
    queue.registerSyncSchedule(connectorId, 240);
    queue.enqueueSyncJob(connectorId, { source: 'schedule' });

    const result = await operator.quarantineFinanceConnectorSync({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('quarantine'),
    });

    expect(result).toMatchObject({
      status: 'quarantined',
      cancelledQueuedCount: 1,
      replayed: false,
    });
    expect(queue.getSyncSchedules()).toEqual([]);
    expect(() => queue.enqueueSyncJob(connectorId, { source: 'schedule' }))
      .toThrowError(expect.objectContaining({ code: 'connector_sync_quarantined' }));
    expect(queue.claimNextSyncJob('worker-a')).toBeNull();
  });

  it('rejects quarantine while a job is running', async () => {
    queue.enqueueSyncJob(connectorId);
    expect(queue.claimNextSyncJob('worker-a')).not.toBeNull();
    await expect(operator.quarantineFinanceConnectorSync({
      connectorId,
      actorType: 'parent-admin',
      idempotencyKey: key('running'),
    })).rejects.toThrowError(expect.objectContaining({ code: 'sync_quarantine_active_job' }));
  });

  it('permits exactly one idempotent canary while the connector stays disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await operator.quarantineFinanceConnectorSync({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('quarantine-canary'),
    });

    const first = await operator.enqueueFinanceOperatorCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('canary'),
    });
    const replay = await operator.enqueueFinanceOperatorCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('canary'),
    });

    expect(first.job).toMatchObject({
      source: 'operator-canary',
      full: true,
      maxAttempts: 1,
    });
    expect(replay).toMatchObject({ replayed: true, job: { id: first.job.id } });
    await expect(operator.enqueueFinanceOperatorCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('second-canary'),
    })).rejects.toThrowError(expect.objectContaining({ code: 'sync_canary_already_invoked' }));
    expect(await operator.getFinanceSyncControlStatus(connectorId)).toMatchObject({
      connector: { enabled: false },
      canary: { status: 'queued' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('keeps quarantine after failure and releases only after a successful canary', async () => {
    await operator.quarantineFinanceConnectorSync({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('quarantine-failure'),
    });

    const failed = await operator.enqueueFinanceOperatorCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('failure-canary'),
    });
    const claimed = queue.claimNextSyncJob('worker-failure');
    expect(claimed?.id).toBe(failed.job.id);
    expect(queue.failSyncJob(claimed!, 'worker-failure', 'invented failure')).toBe('failed');
    await expect(operator.releaseFinanceConnectorQuarantine({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('release-failed'),
    })).rejects.toThrowError(expect.objectContaining({ code: 'sync_canary_not_successful' }));
    expect((await operator.getFinanceSyncControlStatus(connectorId)).scheduler.state)
      .toBe('quarantined');

    await operator.rollbackFinanceOperatorCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('rollback-failed'),
    });
    expect((await operator.getFinanceSyncControlStatus(connectorId)).scheduler.state)
      .toBe('quarantined');
  });

  it('cancels queued canaries on rollback and requests cancellation for running canaries', async () => {
    await operator.quarantineFinanceConnectorSync({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('quarantine-rollback'),
    });
    const queued = await operator.enqueueFinanceOperatorCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('queued-rollback'),
    });
    const cancelled = await operator.rollbackFinanceOperatorCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('rollback-queued'),
    });
    expect(cancelled.cancelledQueuedCount).toBe(1);
    expect(queue.getSyncJob(queued.job.id)?.status).toBe('cancelled');

    const running = await operator.enqueueFinanceOperatorCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('running-rollback'),
    });
    expect(queue.claimNextSyncJob('worker-rollback')?.id).toBe(running.job.id);
    const requested = await operator.rollbackFinanceOperatorCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('rollback-running'),
    });
    expect(requested.cancellationRequestedCount).toBe(1);
    expect(queue.getSyncJob(running.job.id)?.cancelRequestedAt).not.toBeNull();
  });

  it('restores the poll schedule only when a successful connector is enabled', async () => {
    await operator.quarantineFinanceConnectorSync({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('quarantine-release'),
    });
    const canary = await operator.enqueueFinanceOperatorCanary({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('success-canary'),
    });
    const claimed = queue.claimNextSyncJob('worker-success')!;
    queue.completeSyncJob(claimed.id, 'worker-success', claimed.attempt, successfulResult());
    sqlite.prepare(`UPDATE connector_configs SET enabled = 1 WHERE id = ?`).run(connectorId);

    expect(await operator.releaseFinanceConnectorQuarantine({
      connectorId,
      actorType: 'service',
      idempotencyKey: key('release-success'),
    })).toMatchObject({ status: 'released', replayed: false });
    expect(queue.getSyncJob(canary.job.id)?.status).toBe('succeeded');
    expect(queue.getSyncSchedules()).toEqual([
      expect.objectContaining({ connectorId, intervalMinutes: 240 }),
    ]);
  });
});
