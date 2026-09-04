/**
 * Shared contract tests for NotificationWebPersistence implementations.
 * Both SQLite and PostgreSQL adapters must pass these tests.
 *
 * The suite has two tiers:
 *  1. Interface-only tests that exercise the public contract against an empty
 *     database (always run).
 *  2. Seeded parity tests that require a backend-specific `seed` helper to insert
 *     fixtures and read raw rows back. These cover ordering/cursors, inbox
 *     visibility, lifecycle mutations and null handling, writeback dedupe,
 *     claim ordering and per-connector serialization, lease recovery/fencing,
 *     retry scheduling/order, idempotency, redacted errors, and
 *     JSONB/boolean/null marshalling. They only register when a seed helper is
 *     supplied, so the same suite verifies genuine backend parity on both the
 *     SQLite adapter and a live PostgreSQL connection.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { NotificationQuery } from '@/lib/notifications/query';
import type { NotificationWebPersistence } from '@/db/persistence/notification-web';

// ─── Backend-neutral seed capability ─────────────────────────────────────────

export interface ContractSeedNotification {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  receivedAt: string;
  sortAt: string;
  metadata?: unknown;
  presentation?: unknown;
  isActionable?: boolean;
}

export interface ContractSeedNotificationAction {
  id: string;
  notificationId: string;
  actionType: string;
  label: string;
  isPrimary?: boolean;
  payload?: unknown;
  opensExternal?: boolean;
  requiresConfirmation?: boolean;
}

export interface ContractSeedWritebackJob {
  id: string;
  notificationId: string;
  connectorInstanceId: string;
  connectorType: string;
  sourceId: string;
  actionType: string;
  dedupeKey: string;
  status: string;
  retryable: boolean;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractSeededNotification {
  readState: string;
  disposition: string;
  syncState: string;
  mutedAt: string | null;
  presentation: unknown;
}

export interface ContractSeededJob {
  id: string;
  notificationId: string;
  status: string;
  retryable: boolean;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
}

/**
 * Backend-specific fixture helpers. Implemented by each adapter's test harness
 * (better-sqlite3 handle for SQLite, pg Pool for PostgreSQL). All methods must
 * normalize backend representation differences (e.g. integer vs boolean, jsonb
 * text vs parsed object) into the shapes declared above so the shared
 * assertions hold identically on both engines.
 */
export interface NotificationWebContractSeed {
  reset(): Promise<void>;
  insertNotification(row: ContractSeedNotification): Promise<void>;
  insertNotificationAction(row: ContractSeedNotificationAction): Promise<void>;
  insertWritebackJob(row: ContractSeedWritebackJob): Promise<void>;
  getNotification(id: string): Promise<ContractSeededNotification | null>;
  listWritebackJobs(notificationId?: string): Promise<ContractSeededJob[]>;
}

const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

function emptyQuery(overrides: Partial<NotificationQuery> = {}): NotificationQuery {
  return {
    q: null, level: null, category: null, merchant: null,
    source: null, sourceAccount: null, state: null,
    actionableOnly: false, dateRange: null, repository: null,
    owner: null, reason: null, subjectType: null,
    participating: false, sort: 'newest',
    ...overrides,
  };
}

function jobRow(overrides: Partial<ContractSeedWritebackJob> & { id: string; notificationId: string }): ContractSeedWritebackJob {
  return {
    connectorInstanceId: 'gh-conn',
    connectorType: 'github-issues',
    sourceId: 'gh-1',
    actionType: 'mark_done',
    dedupeKey: `dedupe:${overrides.id}`,
    status: 'pending',
    retryable: true,
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: PAST,
    leaseExpiresAt: null,
    createdAt: PAST,
    updatedAt: PAST,
    ...overrides,
  };
}

export function notificationWebRepositoryContractSuite(
  getName: () => string,
  getRepo: () => NotificationWebPersistence,
  getSeed?: () => NotificationWebContractSeed,
) {
  describe(`NotificationWebPersistence contract: ${getName()}`, () => {
    it('queryNotifications returns empty result for empty database', async () => {
      const repo = getRepo();
      const result = await repo.queryNotifications({
        query: emptyQuery(),
        limit: 50,
        cursor: null,
      });
      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.stats.total).toBe(0);
    });

    it('listSavedViews returns empty array initially', async () => {
      const repo = getRepo();
      const views = await repo.listSavedViews();
      expect(views).toEqual([]);
    });

    it('createSavedView and deleteSavedView round-trip', async () => {
      const repo = getRepo();
      const now = new Date().toISOString();
      const view = await repo.createSavedView({
        id: 'test-view-1',
        name: 'Test View',
        query: emptyQuery({ state: 'unread' }),
        now,
      });
      expect(view.name).toBe('Test View');
      const views = await repo.listSavedViews();
      expect(views.length).toBeGreaterThanOrEqual(1);
      const deleted = await repo.deleteSavedView('test-view-1');
      expect(deleted).toBe(true);
      const deletedAgain = await repo.deleteSavedView('test-view-1');
      expect(deletedAgain).toBe(false);
    });

    it('createSavedView rejects a duplicate name', async () => {
      const repo = getRepo();
      const now = new Date().toISOString();
      await repo.createSavedView({
        id: 'dup-view-a',
        name: 'Duplicate View',
        query: emptyQuery(),
        now,
      });
      await expect(
        repo.createSavedView({
          id: 'dup-view-b',
          name: 'Duplicate View',
          query: emptyQuery(),
          now,
        }),
      ).rejects.toThrow();
      // Cleanup so the shared database is left pristine for other tests.
      await repo.deleteSavedView('dup-view-a');
      await repo.deleteSavedView('dup-view-b');
    });

    it('findSubscriptionByEndpoint returns null for non-existent', async () => {
      const repo = getRepo();
      const result = await repo.findSubscriptionByEndpoint('https://example.com/nonexistent');
      expect(result).toBeNull();
    });

    it('registerSubscription and findSubscriptionByEndpoint round-trip', async () => {
      const repo = getRepo();
      const id = await repo.registerSubscription({
        endpoint: 'https://fcm.googleapis.com/test-endpoint-1',
        keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
        userAgent: 'TestAgent/1.0',
      });
      expect(typeof id).toBe('string');
      const found = await repo.findSubscriptionByEndpoint('https://fcm.googleapis.com/test-endpoint-1');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
      await repo.removeSubscription('https://fcm.googleapis.com/test-endpoint-1');
    });

    it('registerSubscription tolerates concurrent duplicate registration', async () => {
      const repo = getRepo();
      const endpoint = 'https://fcm.googleapis.com/concurrent-endpoint';
      const [idA, idB] = await Promise.all([
        repo.registerSubscription({
          endpoint,
          keys: { p256dh: 'a', auth: 'a' },
          userAgent: null,
        }),
        repo.registerSubscription({
          endpoint,
          keys: { p256dh: 'b', auth: 'b' },
          userAgent: null,
        }),
      ]);
      expect(typeof idA).toBe('string');
      expect(typeof idB).toBe('string');
      const found = await repo.findSubscriptionByEndpoint(endpoint);
      expect(found).not.toBeNull();
      await repo.removeSubscription(endpoint);
      const gone = await repo.findSubscriptionByEndpoint(endpoint);
      expect(gone).toBeNull();
    });

    it('removeSubscription is idempotent', async () => {
      const repo = getRepo();
      await repo.removeSubscription('https://fcm.googleapis.com/nonexistent');
      // No error thrown
    });

    it('snoozeNotification returns false for non-existent', async () => {
      const repo = getRepo();
      const result = await repo.snoozeNotification('nonexistent', new Date().toISOString());
      expect(result).toBe(false);
    });

    it('listWritebackStatus returns synced for empty database', async () => {
      const repo = getRepo();
      const status = await repo.listWritebackStatus(null);
      expect(status.syncState).toBe('synced');
      expect(status.jobs).toEqual([]);
    });
  });

  if (!getSeed) return;
  const seedFactory = getSeed;

  describe(`NotificationWebPersistence seeded parity: ${getName()}`, () => {
    let repo: NotificationWebPersistence;
    let seed: NotificationWebContractSeed;

    beforeEach(async () => {
      repo = getRepo();
      seed = seedFactory();
      await seed.reset();
    });

    it('orders newest-first, paginates by cursor, and reports stats', async () => {
      await seed.insertNotification({
        id: 'n1', sourceId: 'di:1', connectorType: 'document-intelligence',
        connectorInstanceId: 'di-conn', title: 'One',
        receivedAt: '2024-01-01T00:00:00.000Z', sortAt: '2024-01-01T00:00:00.000Z',
      });
      await seed.insertNotification({
        id: 'n2', sourceId: 'di:2', connectorType: 'document-intelligence',
        connectorInstanceId: 'di-conn', title: 'Two',
        receivedAt: '2024-01-02T00:00:00.000Z', sortAt: '2024-01-02T00:00:00.000Z',
      });
      await seed.insertNotification({
        id: 'n3', sourceId: 'di:3', connectorType: 'document-intelligence',
        connectorInstanceId: 'di-conn', title: 'Three',
        receivedAt: '2024-01-03T00:00:00.000Z', sortAt: '2024-01-03T00:00:00.000Z',
      });

      const first = await repo.queryNotifications({ query: emptyQuery(), limit: 50, cursor: null });
      expect(first.items.map(n => n.id)).toEqual(['n3', 'n2', 'n1']);
      expect(first.hasMore).toBe(false);
      expect(first.matchingCount).toBe(3);
      expect(first.stats.total).toBe(3);
      expect(first.stats.unread).toBe(3);

      const page1 = await repo.queryNotifications({ query: emptyQuery(), limit: 2, cursor: null });
      expect(page1.items.map(n => n.id)).toEqual(['n3', 'n2']);
      expect(page1.hasMore).toBe(true);
      expect(page1.cursor).toBe('2024-01-02T00:00:00.000Z|n2');

      const page2 = await repo.queryNotifications({ query: emptyQuery(), limit: 2, cursor: page1.cursor });
      expect(page2.items.map(n => n.id)).toEqual(['n1']);
      expect(page2.hasMore).toBe(false);

      const oldest = await repo.queryNotifications({ query: emptyQuery({ sort: 'oldest' }), limit: 50, cursor: null });
      expect(oldest.items.map(n => n.id)).toEqual(['n1', 'n2', 'n3']);
    });

    it('hides dismissed notifications from the inbox but includes them under the dismissed filter', async () => {
      await seed.insertNotification({
        id: 'v1', sourceId: 'di:v1', connectorType: 'document-intelligence',
        connectorInstanceId: 'di-conn', title: 'Visible',
        receivedAt: '2024-02-01T00:00:00.000Z', sortAt: '2024-02-01T00:00:00.000Z',
      });
      await seed.insertNotification({
        id: 'v2', sourceId: 'di:v2', connectorType: 'document-intelligence',
        connectorInstanceId: 'di-conn', title: 'Hidden',
        receivedAt: '2024-02-02T00:00:00.000Z', sortAt: '2024-02-02T00:00:00.000Z',
      });

      await repo.mutateNotificationsAndEnqueueWritebacks(['v2'], 'dismiss', new Date().toISOString());

      const inbox = await repo.queryNotifications({ query: emptyQuery(), limit: 50, cursor: null });
      expect(inbox.items.map(n => n.id)).toEqual(['v1']);

      const dismissed = await repo.queryNotifications({ query: emptyQuery({ state: 'dismissed' }), limit: 50, cursor: null });
      expect(dismissed.items.map(n => n.id)).toContain('v2');

      const stored = await seed.getNotification('v2');
      expect(stored?.disposition).toBe('dismissed');
    });

    it('applies lifecycle mutations and clears nullable fields', async () => {
      await seed.insertNotification({
        id: 'lc', sourceId: 'di:lc', connectorType: 'document-intelligence',
        connectorInstanceId: 'di-conn', title: 'Lifecycle',
        receivedAt: '2024-03-01T00:00:00.000Z', sortAt: '2024-03-01T00:00:00.000Z',
      });
      const now = new Date().toISOString();

      await repo.mutateNotificationsAndEnqueueWritebacks(['lc'], 'mark_read', now);
      expect((await seed.getNotification('lc'))?.readState).toBe('read');

      await repo.mutateNotificationsAndEnqueueWritebacks(['lc'], 'mark_done', now);
      expect((await seed.getNotification('lc'))?.disposition).toBe('handled');

      await repo.mutateNotificationsAndEnqueueWritebacks(['lc'], 'mute', now);
      const muted = await seed.getNotification('lc');
      expect(muted?.disposition).toBe('dismissed');
      expect(muted?.mutedAt).not.toBeNull();

      await repo.mutateNotificationsAndEnqueueWritebacks(['lc'], 'unmute', now);
      const unmuted = await seed.getNotification('lc');
      expect(unmuted?.disposition).toBe('inbox');
      expect(unmuted?.mutedAt).toBeNull();
    });

    it('deduplicates repeated writeback enqueues for the same action and timestamp', async () => {
      await seed.insertNotification({
        id: 'wb', sourceId: 'github-instance:issue-7', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'Writeback',
        receivedAt: '2024-04-01T00:00:00.000Z', sortAt: '2024-04-01T00:00:00.000Z',
      });
      const now = new Date().toISOString();

      const firstResult = await repo.mutateNotificationsAndEnqueueWritebacks(['wb'], 'mark_read', now);
      expect(firstResult.queuedCount).toBe(1);

      const secondResult = await repo.mutateNotificationsAndEnqueueWritebacks(['wb'], 'mark_read', now);
      expect(secondResult.queuedCount).toBe(0);

      const jobs = await seed.listWritebackJobs('wb');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('pending');
      expect(jobs[0].retryable).toBe(true);
      expect(jobs[0].attemptCount).toBe(0);
      expect(jobs[0].maxAttempts).toBe(5);
    });

    it('claims a pending job, increments the attempt, and applies a lease', async () => {
      await seed.insertNotification({
        id: 'c1', sourceId: 'gh:c1', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'Claim',
        receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertWritebackJob(jobRow({ id: 'job-c1', notificationId: 'c1' }));

      const claimed = await repo.claimNextConnectorBatch({
        batchSize: 50, leaseMs: 60_000, singleJobConnectorIds: new Set(),
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0].id).toBe('job-c1');
      expect(claimed[0].attemptCount).toBe(1);
      expect(claimed[0].leaseExpiresAt).toBeTruthy();

      const jobs = await seed.listWritebackJobs('c1');
      expect(jobs[0].status).toBe('sending');
      expect(jobs[0].attemptCount).toBe(1);
      expect(jobs[0].leaseExpiresAt).not.toBeNull();
    });

    it('claims jobs across a connector in FIFO order', async () => {
      await seed.insertNotification({
        id: 'f1', sourceId: 'gh:f1', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'F1', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertNotification({
        id: 'f2', sourceId: 'gh:f2', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'F2', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertWritebackJob(jobRow({
        id: 'job-f1', notificationId: 'f1',
        createdAt: '2024-01-01T00:00:01.000Z', updatedAt: '2024-01-01T00:00:01.000Z',
      }));
      await seed.insertWritebackJob(jobRow({
        id: 'job-f2', notificationId: 'f2',
        createdAt: '2024-01-01T00:00:02.000Z', updatedAt: '2024-01-01T00:00:02.000Z',
      }));

      const claimed = await repo.claimNextConnectorBatch({
        batchSize: 50, leaseMs: 60_000, singleJobConnectorIds: new Set(),
      });
      expect(claimed.map(j => j.id)).toEqual(['job-f1', 'job-f2']);
    });

    it('claims only one job when the connector is throttled to a single job', async () => {
      await seed.insertNotification({
        id: 's1', sourceId: 'gh:s1', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'S1', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertNotification({
        id: 's2', sourceId: 'gh:s2', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'S2', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertWritebackJob(jobRow({
        id: 'job-s1', notificationId: 's1',
        createdAt: '2024-01-01T00:00:01.000Z', updatedAt: '2024-01-01T00:00:01.000Z',
      }));
      await seed.insertWritebackJob(jobRow({
        id: 'job-s2', notificationId: 's2',
        createdAt: '2024-01-01T00:00:02.000Z', updatedAt: '2024-01-01T00:00:02.000Z',
      }));

      const claimed = await repo.claimNextConnectorBatch({
        batchSize: 50, leaseMs: 60_000, singleJobConnectorIds: new Set(['gh-conn']),
      });
      expect(claimed.map(j => j.id)).toEqual(['job-s1']);
    });

    it('serializes multiple jobs for one notification', async () => {
      await seed.insertNotification({
        id: 'seq', sourceId: 'gh:seq', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'Seq', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertWritebackJob(jobRow({
        id: 'job-early', notificationId: 'seq', dedupeKey: 'dedupe:early',
        createdAt: '2024-01-01T00:00:01.000Z', updatedAt: '2024-01-01T00:00:01.000Z',
      }));
      await seed.insertWritebackJob(jobRow({
        id: 'job-late', notificationId: 'seq', dedupeKey: 'dedupe:late',
        createdAt: '2024-01-01T00:00:02.000Z', updatedAt: '2024-01-01T00:00:02.000Z',
      }));

      const firstClaim = await repo.claimNextConnectorBatch({
        batchSize: 50, leaseMs: 60_000, singleJobConnectorIds: new Set(),
      });
      expect(firstClaim.map(j => j.id)).toEqual(['job-early']);

      await repo.completeWritebackJobs(firstClaim);

      const secondClaim = await repo.claimNextConnectorBatch({
        batchSize: 50, leaseMs: 60_000, singleJobConnectorIds: new Set(),
      });
      expect(secondClaim.map(j => j.id)).toEqual(['job-late']);
    });

    it('recovers an expired lease and re-claims the job', async () => {
      await seed.insertNotification({
        id: 'exp', sourceId: 'gh:exp', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'Expired', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertWritebackJob(jobRow({
        id: 'job-exp', notificationId: 'exp', status: 'sending',
        attemptCount: 1, leaseExpiresAt: PAST,
      }));

      const claimed = await repo.claimNextConnectorBatch({
        batchSize: 50, leaseMs: 60_000, singleJobConnectorIds: new Set(),
      });
      expect(claimed.map(j => j.id)).toEqual(['job-exp']);
      expect(claimed[0].attemptCount).toBe(2);
    });

    it('fences completion against a stale lease and is idempotent', async () => {
      await seed.insertNotification({
        id: 'fence', sourceId: 'gh:fence', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'Fence', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertWritebackJob(jobRow({ id: 'job-fence', notificationId: 'fence' }));

      const [claim] = await repo.claimNextConnectorBatch({
        batchSize: 50, leaseMs: 60_000, singleJobConnectorIds: new Set(),
      });

      await repo.completeWritebackJobs([{ ...claim, leaseExpiresAt: 'stale-token' }]);
      expect((await seed.listWritebackJobs('fence'))[0].status).toBe('sending');

      await repo.completeWritebackJobs([claim]);
      expect((await seed.listWritebackJobs('fence'))[0].status).toBe('succeeded');

      // Completing again is a no-op (job is no longer 'sending').
      await repo.completeWritebackJobs([claim]);
      expect((await seed.listWritebackJobs('fence'))[0].status).toBe('succeeded');
    });

    it('renews a live lease and fences renewal against a stale token', async () => {
      await seed.insertNotification({
        id: 'renew', sourceId: 'gh:renew', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'Renew', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertWritebackJob(jobRow({ id: 'job-renew', notificationId: 'renew' }));

      const [claim] = await repo.claimNextConnectorBatch({
        batchSize: 50, leaseMs: 60_000, singleJobConnectorIds: new Set(),
      });

      const renewed = await repo.renewWritebackLeases([claim], 120_000);
      expect(renewed).toHaveLength(1);
      expect(renewed[0].leaseExpiresAt).not.toBe(claim.leaseExpiresAt);

      const stale = await repo.renewWritebackLeases([{ ...claim, leaseExpiresAt: 'stale-token' }], 120_000);
      expect(stale).toEqual([]);
    });

    it('reschedules a retryable failure and redacts an overlong error', async () => {
      await seed.insertNotification({
        id: 'fail', sourceId: 'gh:fail', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'Fail', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertWritebackJob(jobRow({ id: 'job-fail', notificationId: 'fail' }));

      const [claim] = await repo.claimNextConnectorBatch({
        batchSize: 50, leaseMs: 60_000, singleJobConnectorIds: new Set(),
      });

      const before = Date.now();
      await repo.failWritebackJobs(
        [claim],
        { message: 'x'.repeat(2_000), retryable: true },
        60_000,
        1_000,
      );

      const [job] = await seed.listWritebackJobs('fail');
      expect(job.status).toBe('pending');
      expect(job.retryable).toBe(true);
      expect(job.leaseExpiresAt).toBeNull();
      expect(job.lastError).not.toBeNull();
      expect(job.lastError!.length).toBe(1_000);
      expect(Date.parse(job.nextAttemptAt!)).toBeGreaterThanOrEqual(before);
    });

    it('marks a non-retryable failure terminal', async () => {
      await seed.insertNotification({
        id: 'term', sourceId: 'gh:term', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'Terminal', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertWritebackJob(jobRow({ id: 'job-term', notificationId: 'term' }));

      const [claim] = await repo.claimNextConnectorBatch({
        batchSize: 50, leaseMs: 60_000, singleJobConnectorIds: new Set(),
      });
      await repo.failWritebackJobs(
        [claim],
        { message: 'permanent', retryable: false },
        60_000,
        1_000,
      );

      const [job] = await seed.listWritebackJobs('term');
      expect(job.status).toBe('failed');
      expect(job.retryable).toBe(false);
    });

    it('retries failed retryable jobs and skips non-retryable ones', async () => {
      await seed.insertNotification({
        id: 'r1', sourceId: 'gh:r1', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'Retry', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertWritebackJob(jobRow({
        id: 'job-r1', notificationId: 'r1', status: 'failed',
        retryable: true, attemptCount: 3,
      }));
      await seed.insertNotification({
        id: 'r2', sourceId: 'gh:r2', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'NoRetry', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertWritebackJob(jobRow({
        id: 'job-r2', notificationId: 'r2', dedupeKey: 'dedupe:r2', status: 'failed',
        retryable: false, attemptCount: 3,
      }));

      const now = new Date().toISOString();
      const retried = await repo.retryWritebacks('notification_id', ['r1', 'r2'], now);
      expect(retried.retried.map(r => r.notificationId)).toEqual(['r1']);

      const [job1] = await seed.listWritebackJobs('r1');
      expect(job1.status).toBe('pending');
      expect(job1.attemptCount).toBe(0);
      expect(job1.nextAttemptAt).toBe(now);
      expect(job1.leaseExpiresAt).toBeNull();
      expect((await seed.getNotification('r1'))?.syncState).toBe('pending');

      const [job2] = await seed.listWritebackJobs('r2');
      expect(job2.status).toBe('failed');
    });

    it('reports the next scheduled writeback attempt time', async () => {
      await seed.insertNotification({
        id: 'sched', sourceId: 'gh:sched', connectorType: 'github-issues',
        connectorInstanceId: 'gh-conn', title: 'Sched', receivedAt: PAST, sortAt: PAST,
      });
      await seed.insertWritebackJob(jobRow({
        id: 'job-sched', notificationId: 'sched', nextAttemptAt: FUTURE,
      }));

      const next = await repo.getNextScheduledWriteback();
      expect(next?.nextAttemptAt).toBe(FUTURE);
    });

    it('returns camelCase notification and action rows with normalized JSON and booleans', async () => {
      const metadata = { source: 'contract', nullable: null };
      const presentation = {
        financeMerchantKey: 'acme',
        financeMerchantLabel: 'Acme Corp',
        nested: { flag: true, count: 3, missing: null },
      };
      await seed.insertNotification({
        id: 'json', sourceId: 'di:json', connectorType: 'document-intelligence',
        connectorInstanceId: 'di-conn', title: 'Json',
        receivedAt: '2024-05-01T00:00:00.000Z', sortAt: '2024-05-01T00:00:00.000Z',
        metadata,
        presentation,
        isActionable: true,
      });
      await seed.insertNotificationAction({
        id: 'action-json',
        notificationId: 'json',
        actionType: 'open_url',
        label: 'Open',
        isPrimary: true,
        payload: { href: 'https://example.com', nullable: null },
        opensExternal: true,
        requiresConfirmation: false,
      });

      const result = await repo.queryNotifications({ query: emptyQuery(), limit: 50, cursor: null });
      const item = result.items.find(n => n.id === 'json');
      expect(item).toBeDefined();
      expect(item).toMatchObject({
        sourceId: 'di:json',
        connectorInstanceId: 'di-conn',
        readState: 'unread',
        sourceState: 'active',
        sortAt: '2024-05-01T00:00:00.000Z',
        isActionable: true,
        metadata,
        presentation,
      });
      expect(result.actions).toContainEqual(expect.objectContaining({
        id: 'action-json',
        notificationId: 'json',
        actionType: 'open_url',
        isPrimary: true,
        payload: { href: 'https://example.com', nullable: null },
        opensExternal: true,
        requiresConfirmation: false,
      }));
    });
  });
}
