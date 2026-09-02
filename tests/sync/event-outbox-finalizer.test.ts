import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncResult } from '@/types';
import type { SyncJob } from '@/lib/sync/job-repository';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const testDirectory = mkdtempSync(join(tmpdir(), 'mc-event-outbox-finalizer-'));
process.env.MC_DB_PATH = join(testDirectory, 'finalizer.db');
process.env.MC_SYNC_JOB_RETRY_BASE_MS = '1';

let database: typeof import('@/db');
let repository: typeof import('@/lib/sync/sqlite-job-repository');
let terminalEvents: typeof import('@/lib/sync/terminal-events');

const OWNER = 'worker-a';

function successResult(connectorId: string, syncRunId: string): SyncResult {
  return {
    connectorId,
    success: true,
    tasksAdded: 3,
    tasksUpdated: 1,
    tasksRemoved: 0,
    notificationsAdded: 2,
    errors: [],
    syncedAt: '2026-08-25T20:00:00.000Z',
    syncRunId,
  };
}

/** Reproduces the provisional sync-log row the pipeline writes before finalizing. */
function insertProvisionalSyncLog(connectorId: string, result: SyncResult): void {
  database.sqlite.prepare(`
    INSERT INTO sync_log (
      id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
      tasks_pushed, local_only_protected, alerts_added, errors, details,
      synced_at, duration_ms, job_id
    ) VALUES (?, ?, 0, ?, ?, ?, 0, 0, ?, '[]', '{}', ?, 10, NULL)
  `).run(
    result.syncRunId,
    connectorId,
    result.tasksAdded,
    result.tasksUpdated,
    result.tasksRemoved,
    result.notificationsAdded,
    result.syncedAt,
  );
}

async function claimJob(connectorId: string, maxAttempts = 3): Promise<SyncJob> {
  const queued = await repository.sqliteSyncJobRepository.enqueue(connectorId, { maxAttempts });
  const claimed = await repository.sqliteSyncJobRepository.claimNext(OWNER);
  if (!claimed || claimed.id !== queued.id) {
    throw new Error('Test setup failed to claim the enqueued job');
  }
  return claimed;
}

function outboxRows() {
  return database.sqlite.prepare(
    'SELECT stable_key, event_type, payload, occurred_at FROM event_outbox ORDER BY sequence',
  ).all() as Array<{
    stable_key: string;
    event_type: string;
    payload: string;
    occurred_at: string;
  }>;
}

function deliveryRows() {
  return database.sqlite.prepare(
    'SELECT event_sequence, webhook_id, status FROM event_outbox_deliveries',
  ).all() as Array<{ event_sequence: number; webhook_id: string; status: string }>;
}

beforeAll(async () => {
  database = await import('@/db');
  repository = await import('@/lib/sync/sqlite-job-repository');
  terminalEvents = await import('@/lib/sync/terminal-events');
  database.sqlite.prepare('SELECT 1').get();
});

beforeEach(() => {
  database.sqlite.prepare('DELETE FROM event_outbox_deliveries').run();
  database.sqlite.prepare('DELETE FROM event_outbox').run();
  database.sqlite.prepare('DELETE FROM outbound_webhooks').run();
  database.sqlite.prepare('DELETE FROM connector_operation_leases').run();
  database.sqlite.prepare('DELETE FROM sync_job_events').run();
  database.sqlite.prepare('DELETE FROM sync_jobs').run();
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
  database.sqlite.prepare(`
    INSERT INTO outbound_webhooks (id, name, url, secret, event_types, enabled, created_at)
    VALUES (
      'hook-1', 'Hook', 'https://receiver.test/hook', 'sekret',
      '["sync.completed","sync.failed"]', 1, '2026-08-03T00:00:00.000Z'
    )
  `).run();
});

afterAll(() => {
  database.sqlite.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

describe('sync job finalizer event coupling', () => {
  it('enqueues sync.completed atomically with the successful terminal transition', async () => {
    const job = await claimJob('github-1');
    const result = successResult('github-1', 'run-1');
    insertProvisionalSyncLog('github-1', result);

    await repository.sqliteSyncJobRepository.finalizeSuccess(job, OWNER, result, {
      events: [terminalEvents.buildSyncCompletedEvent(job, result)],
    });

    expect(await repository.sqliteSyncJobRepository.get(job.id))
      .toMatchObject({ status: 'succeeded' });
    const events = outboxRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stable_key: `sync.completed:job:${job.id}:run:run-1`,
      event_type: 'sync.completed',
      occurred_at: result.syncedAt,
    });
    expect(JSON.parse(events[0].payload)).toEqual({
      connectorId: 'github-1',
      success: true,
      tasksAdded: 3,
      tasksUpdated: 1,
      tasksRemoved: 0,
      notificationsAdded: 2,
      errors: [],
    });
    expect(deliveryRows()).toEqual([
      { event_sequence: events.length, webhook_id: 'hook-1', status: 'pending' },
    ]);
  });

  it('rolls the event back when the terminal transition fails', async () => {
    const job = await claimJob('github-1');
    const result = successResult('github-1', 'run-1');
    // No provisional sync-log row, so the finalizer cannot link and must abort.

    await expect(repository.sqliteSyncJobRepository.finalizeSuccess(job, OWNER, result, {
      events: [terminalEvents.buildSyncCompletedEvent(job, result)],
    })).rejects.toThrow('exact success log could not be linked');

    expect(outboxRows()).toHaveLength(0);
    expect(deliveryRows()).toHaveLength(0);
    expect(await repository.sqliteSyncJobRepository.get(job.id))
      .toMatchObject({ status: 'running' });
  });

  it('does not enqueue while a failure is still retryable, and enqueues once at exhaustion',
    async () => {
      const job = await claimJob('github-1', 2);
      const event = terminalEvents.buildSyncFailedEvent(job, { errors: ['boom'] });

      const retried = await repository.sqliteSyncJobRepository.fail(
        job,
        OWNER,
        'boom',
        { events: [event] },
      );
      expect(retried).toBe('queued');
      expect(outboxRows()).toHaveLength(0);

      await new Promise((r) => setTimeout(r, 20));
      const second = await repository.sqliteSyncJobRepository.claimNext(OWNER);
      expect(second?.attempt).toBe(2);
      const terminal = await repository.sqliteSyncJobRepository.fail(
        second!,
        OWNER,
        'boom again',
        { events: [terminalEvents.buildSyncFailedEvent(second!, { errors: ['boom again'] })] },
      );

      expect(terminal).toBe('failed');
      const events = outboxRows();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        stable_key: `sync.failed:job:${job.id}`,
        event_type: 'sync.failed',
      });
      expect(JSON.parse(events[0].payload)).toEqual({
        connectorId: 'github-1',
        errors: ['boom again'],
      });
    });

  it('enqueues sync.failed for a cancelled job', async () => {
    const job = await claimJob('github-1');
    const status = await repository.sqliteSyncJobRepository.fail(job, OWNER, 'cancelled', {
      cancelled: true,
      events: [terminalEvents.buildSyncFailedEvent(job, { errors: ['Sync cancelled'] })],
    });

    expect(status).toBe('cancelled');
    expect(outboxRows()).toHaveLength(1);
  });

  it('is idempotent when the same terminal event is enqueued twice', async () => {
    const job = await claimJob('github-1');
    const result = successResult('github-1', 'run-1');
    insertProvisionalSyncLog('github-1', result);
    const event = terminalEvents.buildSyncCompletedEvent(job, result);

    await repository.sqliteSyncJobRepository.finalizeSuccess(job, OWNER, result, {
      events: [event],
    });
    // A crash-and-replay of the same finalizer decision must not fan out twice.
    const repositories = (await import('@/db/persistence/sqlite-event-outbox-repository'))
      .createSqliteEventDeliveryRepositories(database.sqlite);
    const replay = await repositories.outbox.enqueue({
      stableKey: event.stableKey,
      eventType: event.eventType,
      payload: event.payload,
      occurredAt: event.occurredAt,
    });

    expect(replay.created).toBe(false);
    expect(outboxRows()).toHaveLength(1);
    expect(deliveryRows()).toHaveLength(1);
  });

  it('leaves no event behind when no terminal events are supplied', async () => {
    const job = await claimJob('github-1');
    const result = successResult('github-1', 'run-1');
    insertProvisionalSyncLog('github-1', result);

    await repository.sqliteSyncJobRepository.finalizeSuccess(job, OWNER, result);

    expect(outboxRows()).toHaveLength(0);
  });
});

describe('terminal event builders', () => {
  it('derives stable keys from durable sync job and run identity', () => {
    expect(terminalEvents.syncCompletedStableKey('job-1', 'run-1'))
      .toBe('sync.completed:job:job-1:run:run-1');
    expect(terminalEvents.syncFailedStableKey('job-1')).toBe('sync.failed:job:job-1');
  });

  it('classifies only authoritative outcomes as terminal', () => {
    expect(terminalEvents.isTerminalSyncJobStatus('succeeded')).toBe(true);
    expect(terminalEvents.isTerminalSyncJobStatus('failed')).toBe(true);
    expect(terminalEvents.isTerminalSyncJobStatus('cancelled')).toBe(true);
    expect(terminalEvents.isTerminalSyncJobStatus('queued')).toBe(false);
    expect(terminalEvents.isTerminalSyncJobStatus('running')).toBe(false);
  });
});
