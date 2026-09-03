import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _runMigrationsIndividually } from '@/db';
import { createSqliteNotificationEnrichmentRepository } from '@/db/persistence/sqlite-notification-enrichment-repository';
import {
  NotificationEnrichmentWorker,
  calculateNotificationEnrichmentRetryDelayMs,
} from '@/lib/notifications/enrichment/worker';
import { NotificationEnrichmentPermanentError } from '@/lib/notifications/enrichment/ai-enrichment';

const { logged } = vi.hoisted(() => ({ logged: [] as unknown[] }));

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  const record = (payload: unknown, message?: unknown) => logged.push({ payload, message });
  const syncLogger = { info: record, warn: record, error: record, debug: record };
  return { ...actual, syncLogger, default: syncLogger };
});

let sqlite: Database.Database;
let repository: ReturnType<typeof createSqliteNotificationEnrichmentRepository>;

function seed() {
  sqlite.exec(`
    INSERT INTO notifications (
      id, source_id, connector_type, connector_instance_id, title, level, level_rank,
      category, state, read_state, disposition, source_state, sync_state, is_actionable,
      received_at, sort_at, metadata, presentation, enrichment_revision, enrichment_generation
    ) VALUES (
      'n1', 'c1:s1', 'github-issues', 'c1', 'Review requested', 'fyi', 3,
      'development', 'unread', 'unread', 'inbox', 'active', 'synced', 1,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}', '{}', 'r1', 1
    );
    INSERT INTO notification_enrichment_jobs (
      id, notification_id, source_id, source_revision, source_generation, payload, status,
      attempt_count, next_attempt_at, created_at, updated_at
    ) VALUES (
      'j1', 'n1', 'c1:s1', 'r1', 1,
      '{"notificationId":"n1","title":"Review requested","body":"Please review","connectorType":"github-issues","category":"development","metadata":{},"presentation":{"reason":"review_requested"}}',
      'pending', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `);
}

function job() {
  return sqlite.prepare(
    'SELECT status, attempt_count, next_attempt_at, last_error FROM notification_enrichment_jobs',
  ).get() as Record<string, unknown>;
}

beforeEach(() => {
  logged.length = 0;
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));
  repository = createSqliteNotificationEnrichmentRepository(sqlite);
});

afterEach(() => sqlite.close());

describe('notification enrichment worker', () => {
  it('stays dormant until activation and wakes immediately once activated', async () => {
    seed();
    let enabled = false;
    const claimNext = vi.spyOn(repository, 'claimNext');
    const worker = new NotificationEnrichmentWorker({
      repository,
      execute: async () => ({ summary: 'Activated' }),
      owner: 'worker',
      pollMs: 60_000,
      isEnabled: () => enabled,
    });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(claimNext).not.toHaveBeenCalled();
    expect(job().status).toBe('pending');

    enabled = true;
    worker.wake();
    worker.wake();
    await vi.waitFor(() => expect(job().status).toBe('completed'));
    await worker.stop();
  });

  it('completes a claim and merges AI metadata without touching delivery state', async () => {
    seed();
    const execute = vi.fn(async () => ({
      summary: 'Review the requested changes',
      suggestedAction: 'open_url',
      urgencyBoost: false,
      contextTags: ['review'],
    }));
    const worker = new NotificationEnrichmentWorker({
      repository,
      execute,
      owner: 'worker',
      now: () => new Date('2026-01-01T00:00:01.000Z'),
    });

    expect(await worker.runOnce()).toBe(true);
    expect(job()).toMatchObject({ status: 'completed', attempt_count: 1, last_error: null });
    const metadata = JSON.parse(sqlite.prepare(
      'SELECT metadata FROM notifications WHERE id = ?',
    ).pluck().get('n1') as string);
    expect(metadata).toMatchObject({
      aiSummary: 'Review the requested changes',
      aiSuggestedAction: 'open_url',
      aiContextTags: ['review'],
      aiEnrichedAt: '2026-01-01T00:00:01.000Z',
    });
    expect(sqlite.prepare(
      'SELECT count(*) FROM notification_delivery_events',
    ).pluck().get()).toBe(0);
  });

  it('retries transient failures and dead-letters at the bounded attempt limit', async () => {
    seed();
    const secret = 'provider-key-super-secret';
    const worker = new NotificationEnrichmentWorker({
      repository,
      execute: async () => {
        throw new Error(secret);
      },
      owner: 'worker',
      maxAttempts: 2,
      retryBaseMs: 0,
      now: () => new Date('2026-01-01T00:00:01.000Z'),
    });

    await worker.runOnce();
    expect(job()).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_error: 'enrichment_failed',
    });
    await worker.runOnce();
    expect(job()).toMatchObject({
      status: 'dead_letter',
      attempt_count: 2,
      last_error: 'retry_limit_exhausted',
    });
    expect(JSON.stringify(logged)).not.toContain(secret);
  });

  it('dead-letters invalid AI responses as permanent failures', async () => {
    seed();
    const worker = new NotificationEnrichmentWorker({
      repository,
      execute: async () => {
        throw new NotificationEnrichmentPermanentError('sensitive malformed output');
      },
      owner: 'worker',
      maxAttempts: 5,
      now: () => new Date('2026-01-01T00:00:01.000Z'),
    });
    await worker.runOnce();
    expect(job()).toMatchObject({
      status: 'dead_letter',
      attempt_count: 1,
      last_error: 'invalid_ai_response',
    });
    expect(JSON.stringify(logged)).not.toContain('sensitive malformed output');
  });

  it('bounds execution even when an AI provider ignores cancellation', async () => {
    seed();
    const worker = new NotificationEnrichmentWorker({
      repository,
      execute: async () => new Promise(() => {}),
      owner: 'worker',
      timeoutMs: 5,
      retryBaseMs: 1,
    });

    await worker.runOnce();
    expect(job()).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_error: 'execution_timeout',
    });
  });

  it('continues after transient repository failures without logging secrets', async () => {
    seed();
    const secret = 'database-connection-secret';
    let claimAttempts = 0;
    const worker = new NotificationEnrichmentWorker({
      repository: {
        ...repository,
        claimNext: async (input) => {
          claimAttempts++;
          if (claimAttempts === 1) throw new Error(secret);
          return repository.claimNext(input);
        },
      },
      execute: async () => ({ summary: 'Recovered after database interruption' }),
      owner: 'worker',
      pollMs: 1,
    });

    worker.start();
    await vi.waitFor(() => expect(job().status).toBe('completed'));
    await worker.stop();
    expect(claimAttempts).toBeGreaterThan(1);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });

  it('recovers an abandoned claim after restart and shuts down cleanly', async () => {
    seed();
    await repository.claimNext({
      now: new Date('2025-12-31T23:00:00.000Z'),
      leaseMs: 1_000,
      owner: 'dead-worker',
    });
    const worker = new NotificationEnrichmentWorker({
      repository,
      execute: async () => ({ summary: 'Recovered' }),
      owner: 'replacement-worker',
      pollMs: 5,
      now: () => new Date('2026-01-01T00:00:01.000Z'),
    });
    worker.start();
    await vi.waitFor(() => expect(job().status).toBe('completed'));
    await worker.stop();
    expect(JSON.stringify(logged)).toContain('Recovered stale notification enrichment leases');
  });

  it('returns in-flight work to retryable state during graceful shutdown', async () => {
    seed();
    let started!: () => void;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker = new NotificationEnrichmentWorker({
      repository,
      owner: 'worker',
      pollMs: 5,
      retryBaseMs: 1,
      execute: async (_input, { signal }) => {
        started();
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return null;
      },
    });
    worker.start();
    await executing;
    await worker.stop();
    expect(job()).toMatchObject({ status: 'pending', last_error: 'execution_aborted' });
  });

  it('uses capped exponential retry backoff', () => {
    expect(calculateNotificationEnrichmentRetryDelayMs(1, 1_000)).toBe(1_000);
    expect(calculateNotificationEnrichmentRetryDelayMs(3, 1_000)).toBe(4_000);
    expect(calculateNotificationEnrichmentRetryDelayMs(99, 1_000)).toBe(3_600_000);
  });
});
