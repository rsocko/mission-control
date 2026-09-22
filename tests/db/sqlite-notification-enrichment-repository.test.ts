import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { resolve } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { _runMigrationsIndividually } from '@/db';
import * as schema from '@/db/schema';
import { createSqliteConnectorExecutionRepositories } from '@/db/persistence/sqlite-connector-execution-repositories';
import { createSqliteNotificationEnrichmentRepository } from '@/db/persistence/sqlite-notification-enrichment-repository';
import type { ConnectorNotificationCommand } from '@/db/persistence/connector-execution';

vi.unmock('drizzle-orm');

let sqlite: Database.Database;
let repository: ReturnType<typeof createSqliteNotificationEnrichmentRepository>;

function payload(notificationId = 'n1') {
  return {
    notificationId,
    title: 'Review requested',
    body: 'Please review',
    connectorType: 'github-issues',
    category: 'development',
    metadata: { repository: 'owner/repo' },
    presentation: { reason: 'review_requested' },
  };
}

function seed(revision = 'r1') {
  sqlite.prepare(`
    INSERT INTO notifications (
      id, source_id, connector_type, connector_instance_id, title, level, level_rank,
      category, state, read_state, disposition, source_state, sync_state, is_actionable,
      received_at, sort_at, metadata, presentation, enrichment_revision, enrichment_generation
    ) VALUES (
      'n1', 'c1:s1', 'github-issues', 'c1', 'Review requested', 'fyi', 3,
      'development', 'unread', 'unread', 'inbox', 'active', 'synced', 1,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}', '{}', ?, 1
    )
  `).run(revision);
  sqlite.prepare(`
    INSERT INTO notification_enrichment_jobs (
      id, notification_id, source_id, source_revision, source_generation, payload, status,
      attempt_count, next_attempt_at, created_at, updated_at
    ) VALUES ('j1', 'n1', 'c1:s1', ?, 1, ?, 'pending', 0, NULL,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(revision, JSON.stringify(payload()));
}

function command(): ConnectorNotificationCommand {
  return {
    input: {
      id: 'n-ingest',
      sourceId: 'c1:ingest',
      connectorType: 'github-issues',
      connectorInstanceId: 'c1',
      title: 'Review requested',
      body: 'Please review',
      level: 'fyi',
      category: 'development',
      templateKey: null,
      readState: 'unread',
      sourceState: 'active',
      sourceActivityAt: null,
      sourceActivityKey: null,
      reopenPolicy: 'handled',
      occurrenceKey: 'initial',
      isActionable: true,
      primaryActionId: null,
      receivedAt: '2026-01-01T00:00:00.000Z',
      sortAt: '2026-01-01T00:00:00.000Z',
      relatedTaskId: null,
      relatedProjectId: null,
      relatedEntityType: null,
      relatedEntityId: null,
      navigationTarget: null,
      metadata: {},
      presentation: {},
    },
    actions: [],
    enrichment: { sourceRevision: 'r-ingest', payload: payload('n-ingest') },
  };
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));
  repository = createSqliteNotificationEnrichmentRepository(sqlite);
});

afterEach(() => sqlite.close());

describe('SQLite notification enrichment persistence', () => {
  it('claims with owner/token fencing and recovers an expired lease', async () => {
    seed();
    const stale = await repository.claimNext({
      now: new Date('2026-01-01T00:00:00.000Z'),
      leaseMs: 1_000,
      owner: 'worker-a',
    });
    expect(stale).toMatchObject({ attemptCount: 1, leaseOwner: 'worker-a' });
    expect(await repository.claimNext({
      now: new Date('2026-01-01T00:00:00.500Z'),
      leaseMs: 1_000,
      owner: 'worker-b',
    })).toBeNull();
    const recovered = await repository.claimNext({
      now: new Date('2026-01-01T00:00:02.000Z'),
      leaseMs: 1_000,
      owner: 'worker-b',
    });
    expect(recovered).toMatchObject({ id: 'j1', attemptCount: 2, leaseOwner: 'worker-b' });
    expect(recovered!.leaseToken).not.toBe(stale!.leaseToken);
    expect(await repository.deadLetter(stale!, {
      lastError: 'stale',
      completedAt: '2026-01-01T00:00:03.000Z',
    })).toBe(false);
  });

  it('merges metadata only while the notification revision is current', async () => {
    seed();
    const claim = await repository.claimNext({
      now: new Date('2026-01-01T00:00:00.000Z'),
      leaseMs: 60_000,
      owner: 'worker',
    });
    expect(await repository.complete(claim!, {
      metadata: { aiSummary: 'Review the change' },
      completedAt: '2026-01-01T00:00:01.000Z',
    })).toBe('completed');
    expect(JSON.parse(sqlite.prepare(
      'SELECT metadata FROM notifications WHERE id = ?',
    ).pluck().get('n1') as string)).toEqual({ aiSummary: 'Review the change' });
  });

  it.each([
    ['changed revision', "UPDATE notifications SET enrichment_revision = 'r2'"],
    ['deleted source', "UPDATE notifications SET source_state = 'deleted'"],
  ])('marks stale work superseded for a %s', async (_label, mutation) => {
    seed();
    const claim = await repository.claimNext({
      now: new Date('2026-01-01T00:00:00.000Z'),
      leaseMs: 60_000,
      owner: 'worker',
    });
    sqlite.exec(mutation);
    expect(await repository.complete(claim!, {
      metadata: { aiSummary: 'must-not-merge' },
      completedAt: '2026-01-01T00:00:01.000Z',
    })).toBe('superseded');
    expect(sqlite.prepare(
      'SELECT status FROM notification_enrichment_jobs WHERE id = ?',
    ).pluck().get('j1')).toBe('superseded');
    expect(sqlite.prepare(
      'SELECT metadata FROM notifications WHERE id = ?',
    ).pluck().get('n1')).toBe('{}');
  });

  it('persists retry and terminal dead-letter outcomes without sensitive payload data', async () => {
    seed();
    const first = await repository.claimNext({
      now: new Date('2026-01-01T00:00:00.000Z'),
      leaseMs: 60_000,
      owner: 'worker',
    });
    expect(await repository.scheduleRetry(first!, {
      nextAttemptAt: '2026-01-01T00:01:00.000Z',
      lastError: 'enrichment_failed',
    })).toBe(true);
    expect(await repository.claimNext({
      now: new Date('2026-01-01T00:00:30.000Z'),
      leaseMs: 60_000,
      owner: 'worker',
    })).toBeNull();
    const second = await repository.claimNext({
      now: new Date('2026-01-01T00:01:00.000Z'),
      leaseMs: 60_000,
      owner: 'worker',
    });
    expect(await repository.deadLetter(second!, {
      lastError: 'retry_limit_exhausted',
      completedAt: '2026-01-01T00:01:01.000Z',
    })).toBe(true);
    const stored = sqlite.prepare(
      'SELECT status, attempt_count, last_error FROM notification_enrichment_jobs',
    ).get();
    expect(stored).toEqual({
      status: 'dead_letter',
      attempt_count: 2,
      last_error: 'retry_limit_exhausted',
    });
    expect(JSON.stringify(stored)).not.toContain('owner/repo');
  });

  it('dead-letters poisoned SQLite payloads without exposing their contents', async () => {
    seed();
    sqlite.prepare(
      "UPDATE notification_enrichment_jobs SET payload = 'super-secret-not-json'",
    ).run();
    expect(await repository.claimNext({
      now: new Date(),
      leaseMs: 60_000,
      owner: 'worker',
    })).toBeNull();
    expect(sqlite.prepare(
      'SELECT status, last_error FROM notification_enrichment_jobs',
    ).get()).toEqual({ status: 'dead_letter', last_error: 'invalid_payload' });
  });

  it('atomically couples notification ingest and enqueue', async () => {
    const execution = createSqliteConnectorExecutionRepositories(
      sqlite,
      drizzle(sqlite, { schema }),
    );
    await execution.notifications.ingest([command()]);
    expect(sqlite.prepare(
      'SELECT id, enrichment_revision, enrichment_generation FROM notifications WHERE id = ?',
    ).get('n-ingest')).toEqual({
      id: 'n-ingest',
      enrichment_revision: 'r-ingest',
      enrichment_generation: 1,
    });
    expect(sqlite.prepare(
      'SELECT notification_id, source_revision FROM notification_enrichment_jobs',
    ).get()).toEqual({ notification_id: 'n-ingest', source_revision: 'r-ingest' });
  });

  it('preserves current-revision enrichment across replay without duplicate work or delivery', async () => {
    const execution = createSqliteConnectorExecutionRepositories(
      sqlite,
      drizzle(sqlite, { schema }),
    );
    const initial = command();
    initial.input.metadata = { sourceOwned: 'current' };
    await execution.notifications.ingest([initial]);
    const claim = await repository.claimNext({
      now: new Date('2099-01-01T00:00:00.000Z'),
      leaseMs: 60_000,
      owner: 'worker',
    });
    await repository.complete(claim!, {
      metadata: {
        aiSummary: 'Durable summary',
        aiContextTags: ['review'],
        aiEnrichedAt: '2099-01-01T00:00:01.000Z',
      },
      completedAt: '2099-01-01T00:00:01.000Z',
    });
    const deliveryCount = sqlite.prepare(
      'SELECT count(*) FROM notification_delivery_events',
    ).pluck().get();

    await execution.notifications.ingest([{
      ...initial,
      input: { ...initial.input, id: 'ignored-replay-id' },
    }]);

    expect(JSON.parse(sqlite.prepare(
      'SELECT metadata FROM notifications WHERE id = ?',
    ).pluck().get('n-ingest') as string)).toEqual({
      sourceOwned: 'current',
      aiSummary: 'Durable summary',
      aiContextTags: ['review'],
      aiEnrichedAt: '2099-01-01T00:00:01.000Z',
    });
    expect(sqlite.prepare(
      'SELECT count(*) FROM notification_enrichment_jobs',
    ).pluck().get()).toBe(1);
    expect(sqlite.prepare(
      'SELECT count(*) FROM notification_delivery_events',
    ).pluck().get()).toBe(deliveryCount);
  });

  it('drops stale enrichment and fences an in-flight claim when the source revision changes', async () => {
    const execution = createSqliteConnectorExecutionRepositories(
      sqlite,
      drizzle(sqlite, { schema }),
    );
    const initial = command();
    initial.input.metadata = { sourceOwned: 'old' };
    await execution.notifications.ingest([initial]);
    const staleClaim = await repository.claimNext({
      now: new Date('2099-01-01T00:00:00.000Z'),
      leaseMs: 60_000,
      owner: 'worker',
    });
    await sqlite.prepare(
      "UPDATE notifications SET metadata = json_set(metadata, '$.aiSummary', 'Old summary')",
    ).run();

    await execution.notifications.ingest([{
      ...initial,
      input: {
        ...initial.input,
        id: 'ignored-replacement-id',
        body: 'Changed source body',
        metadata: { sourceOwned: 'new', aiSummary: 'source-spoofed' },
      },
      enrichment: {
        sourceRevision: 'r-new',
        payload: { ...initial.enrichment!.payload!, body: 'Changed source body' },
      },
    }]);

    expect(JSON.parse(sqlite.prepare(
      'SELECT metadata FROM notifications WHERE id = ?',
    ).pluck().get('n-ingest') as string)).toEqual({ sourceOwned: 'new' });
    expect(await repository.complete(staleClaim!, {
      metadata: { aiSummary: 'Stale completion' },
      completedAt: '2099-01-01T00:00:01.000Z',
    })).toBe('superseded');
    expect(sqlite.prepare(`
      SELECT source_revision, status
      FROM notification_enrichment_jobs
      ORDER BY source_revision
    `).all()).toEqual([
      { source_revision: 'r-ingest', status: 'superseded' },
      { source_revision: 'r-new', status: 'pending' },
    ]);
  });

  it('fences claimed enrichment when the source is deleted without enqueueing replacement work', async () => {
    const execution = createSqliteConnectorExecutionRepositories(
      sqlite,
      drizzle(sqlite, { schema }),
    );
    const initial = command();
    await execution.notifications.ingest([initial]);
    const staleClaim = await repository.claimNext({
      now: new Date('2099-01-01T00:00:00.000Z'),
      leaseMs: 60_000,
      owner: 'worker',
    });

    await execution.notifications.ingest([{
      ...initial,
      input: {
        ...initial.input,
        id: 'ignored-deletion-id',
        sourceState: 'deleted',
        metadata: { aiSummary: 'source-spoofed' },
      },
      enrichment: { sourceRevision: 'r-deleted', payload: null },
    }]);

    expect(await repository.complete(staleClaim!, {
      metadata: { aiSummary: 'Stale completion' },
      completedAt: '2099-01-01T00:00:01.000Z',
    })).toBe('superseded');
    expect(sqlite.prepare(
      'SELECT count(*) FROM notification_enrichment_jobs',
    ).pluck().get()).toBe(1);
    expect(sqlite.prepare(
      'SELECT source_state, enrichment_revision, metadata FROM notifications WHERE id = ?',
    ).get('n-ingest')).toEqual({
      source_state: 'deleted',
      enrichment_revision: 'r-deleted',
      metadata: '{}',
    });
  });

  it('enqueues one new generation when content returns to an earlier revision', async () => {
    const execution = createSqliteConnectorExecutionRepositories(
      sqlite,
      drizzle(sqlite, { schema }),
    );
    const initial = command();
    await execution.notifications.ingest([initial]);
    const originalClaim = await repository.claimNext({
      now: new Date('2099-01-01T00:00:00.000Z'),
      leaseMs: 60_000,
      owner: 'worker',
    });
    await repository.complete(originalClaim!, {
      metadata: { aiSummary: 'Original summary' },
      completedAt: '2099-01-01T00:00:01.000Z',
    });
    const changed = {
      ...initial,
      input: { ...initial.input, id: 'ignored-b-id', body: 'Revision B' },
      enrichment: {
        sourceRevision: 'r-b',
        payload: { ...initial.enrichment!.payload!, body: 'Revision B' },
      },
    };
    await execution.notifications.ingest([changed]);
    await Promise.all([
      execution.notifications.ingest([{
        ...initial,
        input: { ...initial.input, id: 'ignored-a-id' },
      }]),
      execution.notifications.ingest([{
        ...initial,
        input: { ...initial.input, id: 'ignored-a-replay-id' },
      }]),
    ]);

    expect(sqlite.prepare(`
      SELECT source_revision, source_generation, status, attempt_count
      FROM notification_enrichment_jobs
      ORDER BY source_generation
    `).all()).toEqual([
      {
        source_revision: 'r-ingest',
        source_generation: 1,
        status: 'completed',
        attempt_count: 1,
      },
      { source_revision: 'r-b', source_generation: 2, status: 'superseded', attempt_count: 0 },
      { source_revision: 'r-ingest', source_generation: 3, status: 'pending', attempt_count: 0 },
    ]);
    expect(sqlite.prepare(
      'SELECT count(*) FROM notification_enrichment_jobs',
    ).pluck().get()).toBe(3);
    expect(sqlite.prepare(
      'SELECT metadata FROM notifications WHERE id = ?',
    ).pluck().get('n-ingest')).toBe('{}');
  });

  it('deduplicates the same revision and supersedes pending work on a newer revision', async () => {
    const execution = createSqliteConnectorExecutionRepositories(
      sqlite,
      drizzle(sqlite, { schema }),
    );
    const initial = command();
    await execution.notifications.ingest([initial]);
    await execution.notifications.ingest([{
      ...initial,
      input: { ...initial.input, id: 'ignored-replacement-id' },
    }]);
    expect(sqlite.prepare(
      'SELECT count(*) FROM notification_enrichment_jobs',
    ).pluck().get()).toBe(1);

    await execution.notifications.ingest([{
      ...initial,
      input: { ...initial.input, id: 'another-ignored-id', body: 'Updated body' },
      enrichment: {
        sourceRevision: 'r-new',
        payload: { ...initial.enrichment!.payload!, body: 'Updated body' },
      },
    }]);
    expect(sqlite.prepare(`
      SELECT source_revision, status, notification_id
      FROM notification_enrichment_jobs
      ORDER BY created_at, source_revision
    `).all()).toEqual(expect.arrayContaining([
      { source_revision: 'r-ingest', status: 'superseded', notification_id: 'n-ingest' },
      { source_revision: 'r-new', status: 'pending', notification_id: 'n-ingest' },
    ]));
  });

  it('rolls notification ingest back when enqueue fails', async () => {
    sqlite.exec(`
      CREATE TRIGGER reject_notification_enrichment
      BEFORE INSERT ON notification_enrichment_jobs
      BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END;
    `);
    const execution = createSqliteConnectorExecutionRepositories(
      sqlite,
      drizzle(sqlite, { schema }),
    );
    await expect(execution.notifications.ingest([command()])).rejects.toThrow('queue unavailable');
    expect(sqlite.prepare(
      "SELECT count(*) FROM notifications WHERE id = 'n-ingest'",
    ).pluck().get()).toBe(0);
  });
});
