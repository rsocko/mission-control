import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

describe('stale queued GitHub identity jobs', () => {
  beforeEach(() => {
    process.env.MC_DB_PATH = ':memory:';
    process.env.LOG_LEVEL = 'silent';
    process.env.MC_SYNC_JOB_RETRY_BASE_MS = '1';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.MC_DB_PATH;
    delete process.env.LOG_LEVEL;
    delete process.env.MC_SYNC_JOB_RETRY_BASE_MS;
  });

  it('cancels a stale stable job on first failure and permits a current-mode enqueue', async () => {
    const [{ default: db, sqlite }, schema, queue, context, { SyncWorker }] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/db/schema'),
      import('@/lib/sync/job-queue'),
      import('@/lib/sync/github-identity-context'),
      import('@/lib/sync/worker'),
    ]);
    const now = '2026-08-10T17:00:00.000Z';
    db.insert(schema.connectorConfigs).values({
      id: 'stale-stable-job',
      type: 'github-issues',
      name: 'Stale stable job',
      capabilities: {},
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(schema.githubIdentityMigrations).values({
      connectorInstanceId: 'stale-stable-job',
      phase: 'complete',
      updatedAt: now,
    }).run();
    db.insert(schema.githubIdentityControls).values({
      connectorInstanceId: 'stale-stable-job',
      modeRevision: 8,
      updatedAt: now,
    }).run();
    const stale = queue.enqueueSyncJob('stale-stable-job', { maxAttempts: 3 });
    expect(stale).toMatchObject({
      identityMode: 'stable',
      identityModeRevision: 8,
      status: 'queued',
    });

    db.update(schema.githubIdentityMigrations).set({
      phase: 'complete',
      updatedAt: now,
    }).run();
    db.update(schema.githubIdentityControls).set({
      modeRevision: 9,
      updatedAt: now,
    }).run();

    let workExecuted = 0;
    const worker = new SyncWorker(async (connectorId, options) => {
      await context.validateAndFreezeGitHubIdentityContext(
        connectorId,
        options.identityContext!,
      );
      workExecuted++;
      throw new Error('work should not execute');
    }, {
      ownerId: 'stale-context-worker',
      pollIntervalMs: 1,
    });
    worker.start();
    await vi.waitFor(() => {
      expect(queue.getSyncJob(stale.id)?.status).toBe('cancelled');
    }, { timeout: 10_000, interval: 10 });
    await worker.stop();

    expect(workExecuted).toBe(0);
    expect(queue.getSyncJob(stale.id)).toMatchObject({
      status: 'cancelled',
      attempt: 1,
      identityMode: 'stable',
      identityModeRevision: 8,
      error: expect.stringContaining('revision 8 is stale'),
    });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS value
      FROM sync_jobs
      WHERE connector_id = ? AND status IN ('queued', 'running')
    `).get('stale-stable-job')).toEqual({ value: 0 });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS value
      FROM connector_operation_leases
      WHERE connector_id = ?
    `).get('stale-stable-job')).toEqual({ value: 0 });

    const current = queue.enqueueSyncJob('stale-stable-job');
    expect(current).toMatchObject({
      status: 'queued',
      identityMode: 'stable',
      identityModeRevision: 9,
    });
    expect(current.id).not.toBe(stale.id);
  });
});
