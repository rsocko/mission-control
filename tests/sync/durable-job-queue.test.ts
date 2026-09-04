import { mkdtempSync, rmSync } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';
import type { SyncResult } from '@/types';
import { SqliteSyncRunRepository } from '@/db/persistence/sqlite-sync-run-repository';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const testDirectory = mkdtempSync(join(tmpdir(), 'mc-sync-jobs-'));
process.env.MC_DB_PATH = join(testDirectory, 'jobs.db');
process.env.MC_SYNC_JOB_RETRY_BASE_MS = '1';

let database: typeof import('@/db');
let queue: typeof import('@/lib/sync/job-queue');
let connectorLock: typeof import('@/lib/sync/connector-lock');
const retentionProcesses = new Set<ChildProcess>();

function success(connectorId: string): SyncResult {
  return {
    connectorId,
    success: true,
    tasksAdded: 1,
    tasksUpdated: 0,
    tasksRemoved: 0,
    notificationsAdded: 0,
    errors: [],
    syncedAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  database = await importInitializedSqliteDatabase();
  queue = await import('@/lib/sync/job-queue');
  connectorLock = await import('@/lib/sync/connector-lock');
  database.sqlite.prepare('SELECT 1').get();
});

beforeEach(() => {
  database.sqlite.prepare('DELETE FROM connector_maintenance_locks').run();
  database.sqlite.prepare('DELETE FROM github_repository_repoint_events').run();
  database.sqlite.prepare('DELETE FROM github_repository_repoints').run();
  database.sqlite.prepare('DELETE FROM external_entity_bindings').run();
  database.sqlite.prepare('DELETE FROM external_entity_locators').run();
  database.sqlite.prepare('DELETE FROM external_entities').run();
  database.sqlite.prepare('DELETE FROM connector_operation_leases').run();
  database.sqlite.prepare('DELETE FROM sync_job_events').run();
  database.sqlite.prepare('DELETE FROM sync_jobs').run();
  database.sqlite.prepare('DELETE FROM sync_schedules').run();
  database.sqlite.prepare('DELETE FROM sync_log').run();
  database.sqlite.prepare('DELETE FROM connector_configs').run();
  database.sqlite.prepare(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
      credentials, settings, synced_lists, created_at, updated_at, deleted_at
    ) VALUES (
      'github-1', 'github-issues', 'GitHub', 1, 'poll', 5, '{}',
      '{}', '{}', '[]', '2026-08-03T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z', NULL
    )
  `).run();
});

function startRetentionProcess(
  connectorId: string,
  leaseMs: number,
  mode = 'hold',
): Promise<{ child: ChildProcess; acquired: boolean }> {
  const child = createRetentionProcess(connectorId, leaseMs, mode);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('message', (message) => {
      resolve({
        child,
        acquired: (message as { acquired: boolean }).acquired,
      });
    });
    child.once('exit', (code) => {
      if (code && code !== 0) reject(new Error(`Retention process exited with code ${code}`));
    });
  });
}

function createRetentionProcess(
  connectorId: string,
  leaseMs: number,
  mode: string,
): ChildProcess {
  const child = fork(
    join(process.cwd(), 'tests', 'sync', 'fixtures', 'connector-lock-process.ts'),
    [connectorId, String(leaseMs), mode],
    {
      execArgv: ['--conditions', 'react-server', '--import', 'tsx'],
      env: { ...process.env, MC_DB_PATH: process.env.MC_DB_PATH },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  retentionProcesses.add(child);
  child.once('exit', () => retentionProcesses.delete(child));
  return child;
}

function startRetentionProbeProcess(
  connectorId: string,
  leaseMs: number,
): Promise<ChildProcess> {
  const child = createRetentionProcess(connectorId, leaseMs, 'probe');
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('message', (message) => {
      if (!(message as { ready?: boolean }).ready) {
        reject(new Error('Retention probe did not become ready'));
        return;
      }
      resolve(child);
    });
    child.once('exit', (code) => {
      if (code && code !== 0) reject(new Error(`Retention process exited with code ${code}`));
    });
  });
}

function probeRetentionProcess(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('message', (message) => {
      resolve((message as { acquired: boolean }).acquired);
    });
    child.send('probe');
  });
}

async function stopRetentionProbeProcess(child: ChildProcess): Promise<void> {
  const exited = once(child, 'exit');
  child.send('exit');
  await exited;
}

function releaseRetentionProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('message', (message) => {
      if (!(message as { released: boolean }).released) {
        reject(new Error('Retention process did not release its connector lease'));
        return;
      }
      resolve();
    });
    child.send('release');
  });
}

afterEach(async () => {
  await Promise.all(Array.from(retentionProcesses, async (child) => {
    if (child.exitCode !== null) return;
    child.kill();
    await once(child, 'exit');
  }));
});

afterAll(() => {
  database.sqlite.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

describe('durable sync job queue', () => {
  it('implements the async repository contract behind the compatibility facade', async () => {
    const queued = await queue.sqliteSyncJobRepository.enqueue('github-1', {
      availableAt: '2026-08-25T20:00:00.000Z',
      scheduledFor: '2026-08-25T20:00:00.000Z',
    });

    await expect(queue.sqliteSyncJobRepository.get(queued.id)).resolves.toMatchObject({
      id: queued.id,
      connectorId: 'github-1',
      availableAt: '2026-08-25T20:00:00.000Z',
    });
  });

  it('exposes explicit connector operation lease outcomes', async () => {
    const repository = connectorLock.sqliteConnectorOperationLeaseRepository;
    const at = '2026-08-25T20:00:00.000Z';
    const request = {
      connectorId: 'github-1',
      operationType: 'transfer' as const,
      owner: 'owner-a',
      leaseDurationMs: 60_000,
      at,
    };

    await expect(repository.acquire(request)).resolves.toEqual({
      status: 'acquired',
      expiresAt: '2026-08-25T20:01:00.000Z',
    });
    await expect(repository.acquire({ ...request, owner: 'owner-b' }))
      .resolves.toEqual({ status: 'conflict' });
    await expect(repository.renew({
      ...request,
      owner: 'owner-b',
      at: '2026-08-25T20:00:10.000Z',
    })).resolves.toEqual({ status: 'lost' });
    await expect(repository.renew({
      ...request,
      at: '2026-08-25T20:00:10.000Z',
    })).resolves.toEqual({
      status: 'renewed',
      expiresAt: '2026-08-25T20:01:10.000Z',
    });
    await expect(repository.release({
      connectorId: 'github-1',
      owner: 'owner-b',
    })).resolves.toEqual({ status: 'lost' });
    await expect(repository.release({
      connectorId: 'github-1',
      owner: 'owner-a',
    })).resolves.toEqual({ status: 'released' });
    await expect(repository.hasActiveSyncJobLease({
      connectorId: 'github-1',
      jobId: 'missing-job',
      at,
    })).resolves.toBe(false);
    await expect(repository.recoverExpiredJobs(at)).resolves.toEqual({
      exhausted: 0,
      superseded: 0,
      requeued: 0,
    });
  });

  it('rejects enqueue and operation leases while maintenance is locked', () => {
    seedMaintenanceLock();
    expect(() => queue.enqueueSyncJob('github-1')).toThrow('locked for maintenance');
    expect(connectorLock.acquireConnectorOperationLease(
      'github-1',
      'sync',
      'test-owner',
    )).toBe(false);
  });

  it('does not claim queued work after a maintenance lock is acquired', () => {
    queue.enqueueSyncJob('github-1');
    seedMaintenanceLock();
    expect(queue.claimNextSyncJob('worker-a')).toBeNull();
  });

  it('preserves poll schedules while a maintenance lock disables the connector', () => {
    const now = new Date('2026-08-03T00:00:00.000Z');
    queue.registerSyncSchedule('github-1', 5);
    seedMaintenanceLock();
    database.sqlite.prepare('UPDATE connector_configs SET enabled = 0 WHERE id = ?')
      .run('github-1');

    expect(queue.enqueueDueSyncSchedules(new Date(now.getTime() + 10 * 60_000))).toEqual([]);
    expect(queue.getSyncSchedules()).toEqual([
      expect.objectContaining({ connectorId: 'github-1', intervalMinutes: 5 }),
    ]);
  });

  it('deduplicates a connector and upgrades a queued request to full', () => {
    const first = queue.enqueueSyncJob('github-1');
    const duplicate = queue.enqueueSyncJob('github-1', { full: true });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.full).toBe(true);
    expect(queue.getSyncQueueMetrics().queued).toBe(1);
  });

  it('counts queued jobs through the status index without scanning retained history', () => {
    const queued = queue.enqueueSyncJob('github-1');
    const claimed = queue.claimNextSyncJob('worker-a');
    expect(claimed?.id).toBe(queued.id);
    queue.completeSyncJob(claimed!.id, 'worker-a', claimed!.attempt, success('github-1'));
    queue.enqueueSyncJob('github-2');

    expect(queue.countQueuedSyncJobs()).toBe(1);
    const plan = database.sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(*) FROM sync_jobs INDEXED BY idx_sync_jobs_claim
      WHERE status = 'queued'
    `).all() as Array<{ detail: string }>;
    expect(plan.some((step) =>
      step.detail.includes('USING COVERING INDEX idx_sync_jobs_claim')
    )).toBe(true);
  });

  it('keeps the earliest availability when delayed work is deduplicated', () => {
    const delayed = queue.enqueueSyncJob('github-1', {
      availableAt: new Date('2099-01-01T00:10:00.000Z'),
      scheduledFor: new Date('2099-01-01T00:10:00.000Z'),
      source: 'recovery',
    });
    const later = queue.enqueueSyncJob('github-1', {
      availableAt: new Date('2099-01-01T00:20:00.000Z'),
      scheduledFor: new Date('2099-01-01T00:20:00.000Z'),
      source: 'recovery',
    });
    const immediate = queue.enqueueSyncJob('github-1');

    expect(later).toMatchObject({
      id: delayed.id,
      availableAt: '2099-01-01T00:10:00.000Z',
    });
    expect(immediate.id).toBe(delayed.id);
    expect(Date.parse(immediate.availableAt)).toBeLessThan(Date.parse('2099-01-01T00:10:00.000Z'));
  });

  it('stamps the GitHub identity epoch at enqueue and retains it across retry', () => {
    const now = '2026-08-03T00:00:00.000Z';
    database.sqlite.prepare(`
      INSERT INTO github_identity_migrations (connector_instance_id, phase, updated_at)
      VALUES ('github-1', 'complete', ?)
    `).run(now);
    database.sqlite.prepare(`
      INSERT INTO github_identity_controls (
        connector_instance_id, mode_revision, updated_at
      ) VALUES ('github-1', 7, ?)
    `).run(now);
    const queued = queue.enqueueSyncJob('github-1', { maxAttempts: 2 });
    expect(queued).toMatchObject({
      identityMode: 'stable',
      identityModeRevision: 7,
    });

    const claimed = queue.claimNextSyncJob('worker-a')!;
    expect(claimed).toMatchObject({ identityMode: 'stable', identityModeRevision: 7 });
    database.sqlite.prepare(`
      UPDATE github_identity_controls
      SET mode_revision = 8
      WHERE connector_instance_id = 'github-1'
    `).run();
    expect(queue.failSyncJob(claimed, 'worker-a', 'retry identity stamp')).toBe('queued');
    database.sqlite.prepare(`
      UPDATE sync_jobs SET available_at = ? WHERE id = ?
    `).run(now, queued.id);
    expect(queue.claimNextSyncJob('worker-b')).toMatchObject({
      id: queued.id,
      identityMode: 'stable',
      identityModeRevision: 7,
    });

  });

  it('never reinterprets a job queued against an older identity epoch', async () => {
    const now = '2026-08-03T00:00:00.000Z';
    database.sqlite.prepare(`
      INSERT INTO github_identity_migrations (connector_instance_id, phase, updated_at)
      VALUES ('github-1', 'complete', ?)
    `).run(now);
    database.sqlite.prepare(`
      INSERT INTO github_identity_controls (
        connector_instance_id, mode_revision, updated_at
      ) VALUES ('github-1', 4, ?)
    `).run(now);
    const queued = queue.enqueueSyncJob('github-1');
    expect(queued).toMatchObject({ identityMode: 'stable', identityModeRevision: 4 });
    database.sqlite.prepare(`
      UPDATE github_identity_controls
      SET mode_revision = 5
      WHERE connector_instance_id = 'github-1'
    `).run();

    const claimed = queue.claimNextSyncJob('worker-a')!;
    expect(claimed).toMatchObject({
      id: queued.id,
      identityMode: 'stable',
      identityModeRevision: 4,
    });

    const { validateAndFreezeGitHubIdentityContext } = await import(
      '@/lib/sync/github-identity-context'
    );
    await expect(validateAndFreezeGitHubIdentityContext('github-1', {
      connectorInstanceId: 'github-1',
      modeRevision: claimed.identityModeRevision!,
    })).rejects.toThrow('revision 4 is stale');
  });

  it('cancels a legacy unstamped GitHub queue row instead of stamping it at claim', () => {
    const now = '2026-08-03T00:00:00.000Z';
    database.sqlite.prepare(`
      INSERT INTO sync_jobs (
        id, connector_id, full, source, status, attempt, max_attempts,
        available_at, scheduled_for, duration_budget_ms, created_at, updated_at
      ) VALUES (
        'unstamped-github-job', 'github-1', 0, 'api', 'queued', 0, 3,
        ?, ?, 300000, ?, ?
      )
    `).run(now, now, now, now);
    expect(queue.claimNextSyncJob('worker-a')).toBeNull();
    expect(queue.getSyncJob('unstamped-github-job')).toMatchObject({
      status: 'cancelled',
      identityMode: null,
      identityModeRevision: null,
      error: 'Queued GitHub job had no enqueue-time identity context',
    });
  });

  it('leaves non-GitHub jobs without an identity stamp', () => {
    const now = '2026-08-03T00:00:00.000Z';
    database.sqlite.prepare(`
      INSERT INTO connector_configs (
        id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
        credentials, settings, synced_lists, created_at, updated_at, deleted_at
      ) VALUES (
        'todo-1', 'microsoft-todo', 'To Do', 1, 'poll', 5, '{}',
        '{}', '{}', '[]', ?, ?, NULL
      )
    `).run(now, now);
    queue.enqueueSyncJob('todo-1');
    expect(queue.claimNextSyncJob('worker-a')).toMatchObject({
      connectorId: 'todo-1',
      identityMode: null,
      identityModeRevision: null,
    });
  });

  function seedMaintenanceLock(): void {
    const now = '2026-08-03T00:00:00.000Z';
    database.sqlite.prepare(`
      INSERT INTO external_entities (
        id, provider, host_key, entity_type, stable_id, identity_version,
        next_locator_revision, first_seen_at, last_seen_at
      ) VALUES ('maintenance-repository', 'github', 'github.com', 'repository',
        'R_maintenance', 1, 1, ?, ?)
    `).run(now, now);
    database.sqlite.prepare(`
      INSERT INTO github_repository_repoints (
        id, connector_instance_id, idempotency_key, phase, actor, host_key,
        repository_entity_id, repository_stable_id, from_owner, from_repository,
        to_owner, to_repository, connector_was_enabled, backup_proof, preflight,
        rollback_snapshot, verification, last_error, created_at, updated_at, completed_at
      ) VALUES (
        'maintenance-operation', 'github-1', 'maintenance-test', 'locked',
        'test-operator', 'github.com', 'maintenance-repository', 'R_maintenance',
        'old', 'repo', 'new', 'repo', 1, '{}', '{}', '{}', NULL, NULL, ?, ?, NULL
      )
    `).run(now, now);
    database.sqlite.prepare(`
      INSERT INTO connector_maintenance_locks (
        connector_instance_id, operation_id, actor, reason, acquired_at, updated_at
      ) VALUES (
        'github-1', 'maintenance-operation', 'test-operator',
        'github_repository_repoint', ?, ?
      )
    `).run(now, now);
  }

  it('queues one bounded follow-up behind a running connector job', () => {
    const running = queue.enqueueSyncJob('github-follow-up');
    const claimed = queue.claimNextSyncJob('worker-a')!;
    expect(claimed.id).toBe(running.id);

    const followUp = queue.enqueueSyncJob('github-follow-up', { full: true });
    const duplicate = queue.enqueueSyncJob('github-follow-up', { full: true });

    expect(followUp.id).not.toBe(running.id);
    expect(duplicate.id).toBe(followUp.id);
    expect(followUp).toMatchObject({ status: 'queued', full: true, attempt: 0 });
    expect(queue.getSyncQueueMetrics()).toMatchObject({ queued: 1, running: 1 });

    queue.completeSyncJob(claimed.id, 'worker-a', claimed.attempt, success('github-follow-up'));
    expect(queue.claimNextSyncJob('worker-b')?.id).toBe(followUp.id);
  });

  it('runs a queued follow-up instead of re-queuing a failed active job', () => {
    const running = queue.enqueueSyncJob('github-failed-follow-up');
    const claimed = queue.claimNextSyncJob('worker-a')!;
    expect(claimed.id).toBe(running.id);
    const followUp = queue.enqueueSyncJob('github-failed-follow-up', { full: true });

    expect(queue.failSyncJob(claimed, 'worker-a', 'temporary failure')).toBe('failed');
    expect(queue.getSyncJob(running.id)?.status).toBe('failed');
    expect(queue.claimNextSyncJob('worker-b')?.id).toBe(followUp.id);
  });

  it('enforces ownership and completes only under the active lease', () => {
    const queued = queue.enqueueSyncJob('github-1');
    const claimed = queue.claimNextSyncJob('worker-a');

    expect(claimed?.id).toBe(queued.id);
    expect(queue.claimNextSyncJob('worker-b')).toBeNull();
    expect(queue.renewSyncJobLease(queued.id, 'worker-b', claimed!.attempt)).toBe(false);
    expect(() => queue.completeSyncJob(
      queued.id,
      'worker-b',
      claimed!.attempt,
      success('github-1'),
    ))
      .toThrow(/ownership was lost/);

    queue.completeSyncJob(queued.id, 'worker-a', claimed!.attempt, success('github-1'));
    expect(queue.getSyncJob(queued.id)).toMatchObject({
      status: 'succeeded',
      result: { success: true },
    });
  });

  it('fences stale attempts even when a retry uses the same owner', () => {
    const queued = queue.enqueueSyncJob('github-1', { maxAttempts: 2 });
    const first = queue.claimNextSyncJob('worker-a')!;
    expect(queue.failSyncJob(first, 'worker-a', 'retry')).toBe('queued');
    database.sqlite.prepare(`
      UPDATE sync_jobs SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
    `).run(queued.id);
    const second = queue.claimNextSyncJob('worker-a')!;
    expect(second.attempt).toBe(first.attempt + 1);

    expect(queue.renewSyncJobLease(first.id, 'worker-a', first.attempt)).toBe(false);
    expect(() => queue.completeSyncJob(
      first.id,
      'worker-a',
      first.attempt,
      success('github-1'),
    )).toThrow(/ownership was lost/);
    expect(() => queue.failSyncJob(first, 'worker-a', 'stale failure'))
      .toThrow(/ownership was lost/);
    expect(queue.releaseSyncJob(first.id, 'worker-a', first.attempt, 'stale release'))
      .toBe(false);

    queue.completeSyncJob(second.id, 'worker-a', second.attempt, success('github-1'));
    expect(queue.getSyncJob(second.id)?.status).toBe('succeeded');
  });

  it('atomically finalizes only the exact owned success log and releases its lease', async () => {
      const queued = queue.enqueueSyncJob('github-1');
      const claimed = queue.claimNextSyncJob('worker-a')!;
      const result = {
        ...success('github-1'),
        syncRunId: 'exact-success-log',
      };
      const insert = database.sqlite.prepare(`
        INSERT INTO sync_log (
          id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
          tasks_pushed, local_only_protected, alerts_added, errors, details,
          synced_at, job_id
        ) VALUES (?, 'github-1', ?, 1, 0, 0, 0, 0, 0, '[]', '[]', ?, ?)
      `);
      insert.run(result.syncRunId, 0, result.syncedAt, null);
      insert.run('same-time-unlinked-log', 1, result.syncedAt, null);

      await queue.sqliteSyncJobRepository.finalizeSuccess(claimed, 'worker-a', result);

      expect(queue.getSyncJob(queued.id)).toMatchObject({ status: 'succeeded' });
      expect(database.sqlite.prepare(`
        SELECT job_id AS jobId, success, trigger, attempt FROM sync_log WHERE id = ?
      `).get(result.syncRunId)).toEqual({
        jobId: claimed.id,
        success: 1,
        trigger: claimed.source,
        attempt: 1,
      });
      expect(database.sqlite.prepare(`
        SELECT job_id AS jobId, trigger FROM sync_log WHERE id = 'same-time-unlinked-log'
      `).get()).toEqual({ jobId: null, trigger: null });
      expect(database.sqlite.prepare(`
        SELECT 1 FROM connector_operation_leases WHERE connector_id = 'github-1'
      `).get()).toBeUndefined();
  });

  it('rolls back exact-log finalization after job ownership is lost', async () => {
      const queued = queue.enqueueSyncJob('github-1');
      const claimed = queue.claimNextSyncJob('worker-a')!;
      const result = {
        ...success('github-1'),
        syncRunId: 'lost-owner-log',
      };
      database.sqlite.prepare(`
        INSERT INTO sync_log (
          id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
          tasks_pushed, local_only_protected, alerts_added, errors, details,
          synced_at, job_id
        ) VALUES (?, 'github-1', 0, 1, 0, 0, 0, 0, 0, '[]', '[]', ?, NULL)
      `).run(result.syncRunId, result.syncedAt);

      await expect(queue.sqliteSyncJobRepository.finalizeSuccess(
        claimed,
        'worker-b',
        result,
      )).rejects.toThrow(/ownership was lost/);
      expect(queue.getSyncJob(queued.id)).toMatchObject({
        status: 'running',
        leaseOwner: 'worker-a',
      });
      expect(database.sqlite.prepare(`
        SELECT success, job_id AS jobId, trigger, attempt FROM sync_log WHERE id = ?
      `).get(result.syncRunId)).toEqual({
        success: 0,
        jobId: null,
        trigger: null,
        attempt: null,
      });
  });

  it('does not publish a provisional success after the job lease expires', async () => {
    queue.enqueueSyncJob('github-1');
    const claimed = queue.claimNextSyncJob('worker-a')!;
    const result = {
      ...success('github-1'),
      syncRunId: 'expired-owner-log',
    };
    database.sqlite.prepare(`
      INSERT INTO sync_log (
        id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
        tasks_pushed, local_only_protected, alerts_added, errors, details,
        synced_at, job_id
      ) VALUES (?, 'github-1', 0, 1, 0, 0, 0, 0, 0, '[]', '[]', ?, NULL)
    `).run(result.syncRunId, result.syncedAt);
    database.sqlite.prepare(`
      UPDATE sync_jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(claimed.id);

    await expect(queue.sqliteSyncJobRepository.finalizeSuccess(
      claimed,
      'worker-a',
      result,
    )).rejects.toThrow(/ownership was lost/);
    expect(database.sqlite.prepare(`
      SELECT success, job_id AS jobId FROM sync_log WHERE id = ?
    `).get(result.syncRunId)).toEqual({ success: 0, jobId: null });
  });

  it('recovers an expired lease for another worker without duplicate execution', async () => {
    const queued = queue.enqueueSyncJob('github-1', { maxAttempts: 2 });
    expect(queue.claimNextSyncJob('worker-a', 1)?.attempt).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const recovered = queue.claimNextSyncJob('worker-b');
    expect(recovered).toMatchObject({
      id: queued.id,
      source: 'recovery',
      attempt: 2,
      leaseOwner: 'worker-b',
    });
  });

  it('skips a fenced connector while claiming unrelated queued work', () => {
    const fenced = queue.enqueueSyncJob('github-fenced');
    const available = queue.enqueueSyncJob('github-available');

    expect(queue.claimNextSyncJob(
      'worker-a',
      queue.getSyncLeaseMs(),
      new Set(['github-fenced']),
    )?.id).toBe(available.id);
    expect(queue.getSyncJob(fenced.id)).toMatchObject({ status: 'queued' });
  });

  it('recovers an expired active job by preserving its queued follow-up', async () => {
    const running = queue.enqueueSyncJob('github-expired-follow-up', { maxAttempts: 2 });
    expect(queue.claimNextSyncJob('worker-a', 1)?.id).toBe(running.id);
    const followUp = queue.enqueueSyncJob('github-expired-follow-up', { full: true });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(queue.claimNextSyncJob('worker-b')?.id).toBe(followUp.id);
    expect(queue.getSyncJob(running.id)?.status).toBe('failed');
  });

  it('blocks retention in another process while durable sync is queued or running', async () => {
    const retentionProbe = await startRetentionProbeProcess('github-1', 10_000);
    const queued = queue.enqueueSyncJob('github-1');
    expect(await probeRetentionProcess(retentionProbe)).toBe(false);

    const running = queue.claimNextSyncJob('worker-a');
    expect(running?.id).toBe(queued.id);
    expect(await probeRetentionProcess(retentionProbe)).toBe(false);

    queue.completeSyncJob(running!.id, 'worker-a', running!.attempt, success('github-1'));
    expect(await probeRetentionProcess(retentionProbe)).toBe(true);
    await stopRetentionProbeProcess(retentionProbe);
  });

  it('keeps a worker from claiming a connector leased by another process', async () => {
    const retention = await startRetentionProcess('github-1', 10_000);
    expect(retention.acquired).toBe(true);
    const queued = queue.enqueueSyncJob('github-1');

    expect(queue.claimNextSyncJob('worker-a')).toBeNull();
    expect(queue.getSyncJob(queued.id)?.status).toBe('queued');

    await releaseRetentionProcess(retention.child);
    expect(queue.claimNextSyncJob('worker-a')?.id).toBe(queued.id);
  });

  it('recovers a connector lease after its owning process crashes', async () => {
    const crashed = await startRetentionProcess('github-1', 5, 'crash');
    expect(crashed.acquired).toBe(true);
    if (crashed.child.exitCode === null) await once(crashed.child, 'exit');
    expect(crashed.child.exitCode).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 15));

    const queued = queue.enqueueSyncJob('github-1');
    expect(queue.claimNextSyncJob('worker-recovery')?.id).toBe(queued.id);
  });

  it('recovers expired worker work before a retention process checks exclusivity', async () => {
    const terminal = queue.enqueueSyncJob('github-terminal', { maxAttempts: 1 });
    queue.claimNextSyncJob('worker-crashed', 5);
    await new Promise((resolve) => setTimeout(resolve, 15));

    const retention = await startRetentionProcess('github-terminal', 10_000);
    expect(retention.acquired).toBe(true);
    expect(queue.getSyncJob(terminal.id)?.status).toBe('failed');
    await releaseRetentionProcess(retention.child);

    const retryable = queue.enqueueSyncJob('github-retryable', { maxAttempts: 2 });
    queue.claimNextSyncJob('worker-crashed', 5);
    await new Promise((resolve) => setTimeout(resolve, 15));

    const blocked = await startRetentionProcess('github-retryable', 10_000);
    expect(blocked.acquired).toBe(false);
    expect(queue.getSyncJob(retryable.id)).toMatchObject({
      status: 'queued',
      source: 'recovery',
    });
  });

  it('cancels queued work and never claims it as successful', () => {
    const queued = queue.enqueueSyncJob('github-1');
    expect(queue.requestSyncJobCancellation({ connectorId: 'github-1' })).toEqual({
      cancelled: 1,
      cancellationRequested: 0,
    });

    expect(queue.getSyncJob(queued.id)).toMatchObject({
      status: 'cancelled',
      result: null,
    });
  });

  it('exposes cooperative cancellation for the current lease owner', () => {
    const queued = queue.enqueueSyncJob('github-1');
    const claimed = queue.claimNextSyncJob('worker-a')!;

    expect(queue.requestSyncJobCancellation({ jobId: queued.id })).toEqual({
      cancelled: 0,
      cancellationRequested: 1,
    });
    expect(queue.isSyncJobCancellationRequested(queued.id, 'worker-a', claimed.attempt)).toBe(true);
    expect(queue.isSyncJobCancellationRequested(queued.id, 'worker-b', claimed.attempt)).toBe(false);
  });

  it('retries failures and records terminal failure without a success result', () => {
    const queued = queue.enqueueSyncJob('github-1', { maxAttempts: 2 });
    const first = queue.claimNextSyncJob('worker-a')!;
    expect(queue.failSyncJob(first, 'worker-a', 'temporary failure')).toBe('queued');
    database.sqlite.prepare(`
      UPDATE sync_jobs SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
    `).run(queued.id);

    const second = queue.claimNextSyncJob('worker-b')!;
    expect(queue.failSyncJob(second, 'worker-b', 'permanent failure')).toBe('failed');
    expect(queue.getSyncJob(queued.id)).toMatchObject({
      status: 'failed',
      result: null,
      error: 'permanent failure',
    });
  });

  it('delivers persisted progress events by a durable SSE cursor', () => {
    const queued = queue.enqueueSyncJob('github-1');
    queue.persistSyncJobEvent(queued.id, {
      type: 'sync:start',
      connectorId: 'github-1',
      connectorName: 'GitHub',
      phase: 'tasks',
    });

    const events = queue.getSyncJobEventsAfter(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      jobId: queued.id,
      connectorId: 'github-1',
      event: { type: 'sync:start', phase: 'tasks' },
    });
    expect(queue.getLatestSyncJobEventId()).toBe(events[0].id);
  });

  it('reports missed schedules, queue depth, and over-budget work', () => {
    const queued = queue.enqueueSyncJob('github-1', {
      scheduledFor: new Date('2000-01-01T00:00:00.000Z'),
      durationBudgetMs: 1,
    });
    queue.claimNextSyncJob('worker-a');
    database.sqlite.prepare(`
      UPDATE sync_jobs SET started_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
    `).run(queued.id);
    queue.enqueueSyncJob('github-2', {
      scheduledFor: new Date('2000-01-01T00:00:00.000Z'),
    });
    queue.registerSyncSchedule('github-2', 5);
    expect(queue.getSyncSchedules()).toEqual([
      { connectorId: 'github-2', intervalMinutes: 5 },
    ]);
    database.sqlite.prepare(`
      UPDATE sync_schedules SET next_due_at = '2000-01-01T00:00:00.000Z'
      WHERE connector_id = 'github-2'
    `).run();

    expect(queue.getSyncQueueMetrics()).toMatchObject({
      queued: 1,
      running: 1,
      missedSchedules: 1,
      oldestScheduleOverdueMs: expect.any(Number),
      overBudget: 1,
    });
    expect(queue.countRemainingSyncJobs({ queued: 1, running: 1 })).toBe(1);
  });

  it('catches up an overdue schedule once and advances its due time', () => {
    queue.registerSyncSchedule('github-1', 5);
    database.sqlite.prepare(`
      UPDATE sync_schedules
      SET next_due_at = '2026-08-03T12:00:00.000Z'
      WHERE connector_id = 'github-1'
    `).run();

    const recovered = queue.enqueueDueSyncSchedules(new Date('2026-08-03T12:17:00.000Z'));

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      connectorId: 'github-1',
      source: 'schedule',
      scheduledFor: '2026-08-03T12:00:00.000Z',
    });
    expect(queue.getSyncScheduleHealth(new Date('2026-08-03T12:17:00.000Z'))).toEqual([
      expect.objectContaining({
        connectorId: 'github-1',
        nextDueAt: '2026-08-03T12:20:00.000Z',
        lastEnqueuedAt: '2026-08-03T12:17:00.000Z',
        overdue: false,
      }),
    ]);
    expect(queue.enqueueDueSyncSchedules(new Date('2026-08-03T12:17:00.000Z'))).toEqual([]);
  });

  it('removes overdue schedules for disabled, deleted, and manual connectors', () => {
    database.sqlite.prepare(`
      INSERT INTO connector_configs (
        id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
        credentials, settings, synced_lists, created_at, updated_at, deleted_at
      ) VALUES
        ('disabled', 'github-issues', 'Disabled', 0, 'poll', 5, '{}', '{}', '{}', '[]',
         '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z', NULL),
        ('deleted', 'github-issues', 'Deleted', 1, 'poll', 5, '{}', '{}', '{}', '[]',
         '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z', '2026-08-03T01:00:00.000Z'),
        ('manual', 'github-issues', 'Manual', 1, 'manual', 5, '{}', '{}', '{}', '[]',
         '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z', NULL)
    `).run();
    queue.registerSyncSchedule('github-1', 5);
    for (const connectorId of ['disabled', 'deleted', 'manual']) {
      queue.registerSyncSchedule(connectorId, 5);
    }
    database.sqlite.prepare(`
      UPDATE sync_schedules SET next_due_at = '2026-08-03T12:00:00.000Z'
    `).run();

    expect(queue.enqueueDueSyncSchedules(new Date('2026-08-03T12:10:00.000Z')))
      .toHaveLength(1);
    expect(queue.getSyncSchedules()).toEqual([
      { connectorId: 'github-1', intervalMinutes: 5 },
    ]);
  });

  it('records the current retry attempt start time in history metadata', () => {
    const queued = queue.enqueueSyncJob('github-1', { maxAttempts: 2 });
    const first = queue.claimNextSyncJob('worker-a')!;
    database.sqlite.prepare(`
      UPDATE sync_jobs
      SET started_at = '2000-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(queued.id);
    expect(queue.failSyncJob(first, 'worker-a', 'retry me')).toBe('queued');
    database.sqlite.prepare(`
      UPDATE sync_jobs SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
    `).run(queued.id);

    const second = queue.claimNextSyncJob('worker-b')!;

    expect(second).toMatchObject({
      attempt: 2,
      startedAt: expect.not.stringMatching(/^2000-/),
    });
  });

  it('links durable job timing and trigger metadata to a portable journal entry', async () => {
    await new SqliteSyncRunRepository(database.sqlite).append({
      id: 'log-1',
      connectorId: 'github-1',
      success: true,
      tasksAdded: 0,
      tasksUpdated: 0,
      tasksRemoved: 0,
      tasksPushed: 0,
      localOnlyProtected: 0,
      notificationsAdded: 0,
      errors: [],
      details: [],
      syncedAt: '2026-08-03T12:00:05.000Z',
      durationMs: 5000,
      jobId: null,
      identityMode: null,
      identityModeRevision: null,
    });
    const queued = queue.enqueueSyncJob('github-1', {
      source: 'schedule',
      scheduledFor: new Date('2026-08-03T12:00:00.000Z'),
    });

    const claimed = queue.claimNextSyncJob('worker-a')!;
    const syncResult = {
      ...success('github-1'),
      syncedAt: '2026-08-03T12:00:05.000Z',
    };

    queue.linkSyncLogToJob(claimed, syncResult);

    expect(database.sqlite.prepare(`
      SELECT
        job_id AS jobId,
        trigger,
        scheduled_for AS scheduledFor,
        started_at AS startedAt,
        attempt,
        max_attempts AS maxAttempts
      FROM sync_log
      WHERE id = 'log-1'
    `).get()).toMatchObject({
      jobId: queued.id,
      trigger: 'schedule',
      scheduledFor: '2026-08-03T12:00:00.000Z',
      startedAt: expect.any(String),
      attempt: 1,
      maxAttempts: 3,
    });
  });

  it('preserves an existing due time when a worker re-registers the same interval', () => {
    queue.registerSyncSchedule('github-1', 10);
    database.sqlite.prepare(`
      UPDATE sync_schedules
      SET next_due_at = '2026-08-03T12:00:00.000Z'
      WHERE connector_id = 'github-1'
    `).run();

    queue.registerSyncSchedule('github-1', 10);

    expect(database.sqlite.prepare(`
      SELECT next_due_at AS nextDueAt
      FROM sync_schedules
      WHERE connector_id = 'github-1'
    `).get()).toEqual({ nextDueAt: '2026-08-03T12:00:00.000Z' });
  });

  it('waits through retry state until the retried job succeeds', async () => {
    const queued = queue.enqueueSyncJob('github-1', { maxAttempts: 2 });
    const waiting = queue.waitForSyncJob(queued, { timeoutMs: 2_000 });
    const first = queue.claimNextSyncJob('worker-a')!;
    queue.failSyncJob(first, 'worker-a', 'retry me');
    database.sqlite.prepare(`
      UPDATE sync_jobs SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
    `).run(queued.id);
    const second = queue.claimNextSyncJob('worker-b')!;
    queue.completeSyncJob(second.id, 'worker-b', second.attempt, success('github-1'));

    await expect(waiting).resolves.toMatchObject({ success: true, tasksAdded: 1 });
  });

  it('reads the latest durable result written by another process', () => {
    database.sqlite.prepare(`
      INSERT INTO sync_log (
        id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
        tasks_pushed, local_only_protected, alerts_added, errors, details,
        synced_at, duration_ms
      ) VALUES (
        'worker-result', 'github-1', 1, 2, 3, 0, 0, 0, 1, '[]', '[]',
        '2026-08-03T12:00:00.000Z', 100
      )
    `).run();

    expect(queue.getLatestDurableSyncResult('github-1')).toMatchObject({
      connectorId: 'github-1',
      success: true,
      tasksAdded: 2,
      tasksUpdated: 3,
      notificationsAdded: 1,
    });
  });
});
