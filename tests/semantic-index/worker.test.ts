import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SemanticIndexWorker } from '@/lib/semantic-index/worker';
import { getSemanticWorkerConfig } from '@/lib/semantic-index/config';
import type { SemanticIndexRepository } from '@/lib/semantic-index/contracts';
import {
  FakeEmbeddingProvider,
  createSemanticHarness,
  taskFixture,
  type SemanticHarness,
} from './harness';

/**
 * Counts every repository call so a "disabled" worker can be proven to touch
 * nothing at all, and so lease renewals can be asserted without timing luck.
 */
function instrument(repository: SemanticIndexRepository) {
  const calls: string[] = [];
  const proxy = new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { proxy, calls };
}

describe('SemanticIndexWorker', () => {
  let harness: SemanticHarness;

  beforeEach(() => {
    harness = createSemanticHarness();
  });

  afterEach(() => {
    harness.close();
    vi.restoreAllMocks();
  });

  function createWorker(overrides: Partial<{
    repository: SemanticIndexRepository;
    isEnabled: () => boolean;
    config: Partial<ReturnType<typeof getSemanticWorkerConfig>>;
    owner: string;
  }> = {}) {
    return new SemanticIndexWorker({
      repository: overrides.repository ?? harness.repository,
      source: harness.source,
      embeddings: harness.embeddings,
      service: harness.service,
      config: { ...harness.config, ...overrides.config },
      isEnabled: overrides.isEnabled ?? (() => true),
      owner: overrides.owner ?? 'worker-under-test',
    });
  }

  // ─── Feature gate ───────────────────────────────────────────────────

  describe('when semantic search is disabled', () => {
    it('does no work and touches no storage', async () => {
      const { proxy, calls } = instrument(harness.repository);
      const worker = createWorker({ repository: proxy, isEnabled: () => false });

      const report = await worker.runCycle();

      expect(report).toMatchObject({ status: 'disabled', reason: 'semantic-search-disabled' });
      expect(calls).toEqual([]);
      expect(harness.embeddings.calls).toEqual([]);
    });

    it('starts and stops cleanly without provisioning anything', async () => {
      const worker = createWorker({ isEnabled: () => false });
      worker.start();
      expect(worker.isRunning).toBe(true);
      await worker.stop();
      expect(worker.isRunning).toBe(false);
      expect(await harness.repository.listIdentities()).toEqual([]);
    });
  });

  describe('when no provider is configured', () => {
    it('reports unavailable instead of creating an identity', async () => {
      const unconfigured = createSemanticHarness({
        embeddings: new FakeEmbeddingProvider({
          route: { status: 'unconfigured', reason: 'provider-unconfigured' },
        }),
      });
      try {
        const worker = new SemanticIndexWorker({
          repository: unconfigured.repository,
          source: unconfigured.source,
          embeddings: unconfigured.embeddings,
          service: unconfigured.service,
          config: unconfigured.config,
          isEnabled: () => true,
          owner: 'worker-unconfigured',
        });
        const report = await worker.runCycle();
        expect(report).toMatchObject({
          status: 'unavailable',
          reason: 'provider-unconfigured',
        });
        expect(await unconfigured.repository.listIdentities()).toEqual([]);
      } finally {
        unconfigured.close();
      }
    });
  });

  // ─── Normal operation ───────────────────────────────────────────────

  describe('cycles', () => {
    it('provisions an identity, backfills, and drains the queue over cycles', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      harness.source.putTask(taskFixture({ id: 'task-2' }));
      const worker = createWorker();

      // Cycle 1: maintenance is due, so the identity is created, runs are
      // scheduled, and the highest-priority run (backfill) executes.
      const first = await worker.runCycle();
      expect(first.identityId).toBeTruthy();
      expect(first.runsExecuted).toBe(1);
      expect(first.intentsClaimed).toBe(0);

      // Cycle 2: the intents the backfill enqueued are claimed and processed.
      const second = await worker.runCycle();
      expect(second.intentsClaimed).toBe(2);
      expect(second.intentsSucceeded).toBe(2);

      const identity = (await harness.repository.listIdentities())[0];
      for (const entityId of ['task-1', 'task-2']) {
        expect(await harness.repository.getDocument(identity.id, 'task', entityId)).not.toBeNull();
        expect(await harness.repository.getVector(identity.id, 'task', entityId)).not.toBeNull();
      }
    });

    it('activates the identity only once the backfill has produced vectors', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      const worker = createWorker();

      // Backfill completes as soon as the intents are enqueued, so no vector
      // exists yet: activation must be refused and the identity must wait.
      await worker.runCycle();
      const identityId = (await harness.repository.listIdentities())[0].id;
      expect((await harness.repository.getIdentity(identityId))?.status).toBe('ready');
      expect(await harness.repository.getActiveIdentity()).toBeNull();

      // Drain the queue so vectors exist.
      await worker.runCycle();
      expect(await harness.repository.getActiveIdentity()).toBeNull();

      // Promotion is retried on the next maintenance tick, without needing
      // another backfill run to complete.
      const retrying = createWorker({ config: { maintenanceIntervalMs: 30_000 } });
      await retrying.runCycle();
      expect((await harness.repository.getActiveIdentity())?.id).toBe(identityId);
    });

    it('claims no more than the configured batch size', async () => {
      for (let index = 1; index <= 6; index++) {
        harness.source.putTask(taskFixture({ id: `task-${index}` }));
      }
      const worker = createWorker({ config: { batchSize: 2, concurrency: 2 } });
      await worker.runCycle();

      const drained = await worker.runCycle();
      expect(drained.intentsClaimed).toBe(2);
      expect(drained.intentsSucceeded).toBe(2);
    });

    it('processes a batch with bounded concurrency', async () => {
      for (let index = 1; index <= 4; index++) {
        harness.source.putTask(taskFixture({ id: `task-${index}` }));
      }
      let inFlight = 0;
      let peak = 0;
      const embed = harness.embeddings.embed.bind(harness.embeddings);
      vi.spyOn(harness.embeddings, 'embed').mockImplementation(async (request) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        inFlight -= 1;
        return embed(request);
      });

      const worker = createWorker({ config: { batchSize: 4, concurrency: 2 } });
      await worker.runCycle();
      const drained = await worker.runCycle();

      expect(drained.intentsClaimed).toBe(4);
      expect(peak).toBeLessThanOrEqual(2);
      expect(peak).toBeGreaterThan(0);
    });

    it('reports retries and denials separately from successes', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      harness.source.putTask(taskFixture({ id: 'task-2' }));
      const worker = createWorker({ config: { batchSize: 4, concurrency: 1 } });
      await worker.runCycle();

      harness.embeddings.enqueue({ status: 'retryable', reason: 'http-503', retryAfter: null });
      harness.embeddings.enqueue({ status: 'denied', reason: 'routing-denied', retryAfter: null });

      const drained = await worker.runCycle();
      expect(drained.intentsClaimed).toBe(2);
      expect(drained.intentsRetried).toBe(1);
      expect(drained.intentsDenied).toBe(1);
      expect(drained.intentsSucceeded).toBe(0);
    });
  });

  // ─── Cutover ────────────────────────────────────────────────────────

  describe('identity cutover', () => {
    /** Runs maintenance cycles until the configured route has an active identity. */
    async function settle(cycles = 4) {
      for (let index = 0; index < cycles; index++) {
        // A fresh worker always has maintenance due, which is what re-evaluates
        // identity resolution, run scheduling, and promotion.
        await createWorker().runCycle();
      }
    }

    it('cuts over to the new identity after a model change and keeps the old one for rollback', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      await settle();

      const first = await harness.repository.getActiveIdentity();
      expect(first).toMatchObject({ status: 'active', model: 'text-embedding-3-small' });

      // The operator changes the embedding model. The active identity's vectors
      // are no longer comparable to anything the live route produces.
      harness.embeddings.model = 'text-embedding-3-large';
      await settle();

      const second = await harness.repository.getActiveIdentity();
      expect(second).toMatchObject({ status: 'active', model: 'text-embedding-3-large' });
      expect(second?.id).not.toBe(first!.id);
      expect(second!.vectorCount).toBeGreaterThan(0);

      // The displaced identity is demoted to `ready`, never retired, so it is
      // still a rollback target.
      const demoted = await harness.repository.getIdentity(first!.id);
      expect(demoted).toMatchObject({ status: 'ready', model: 'text-embedding-3-small' });

      const rolledBack = await harness.repository.rollbackToIdentity(
        first!.id,
        new Date().toISOString(),
      );
      expect(rolledBack).toMatchObject({
        status: 'rolled-back',
        activatedId: first!.id,
        previousActiveId: second!.id,
      });
      expect((await harness.repository.getActiveIdentity())?.id).toBe(first!.id);
      // Rollback is identity-space safe rather than route-safe: the provider and
      // model may differ from the current configuration, but every vector the
      // target holds must belong to the space that identity declares.
      expect((await harness.repository.getIdentity(second!.id))?.status).toBe('ready');
    });

    it('leaves the serving identity alone when the candidate is not the configured route', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      await settle();
      const first = await harness.repository.getActiveIdentity();
      expect(first).not.toBeNull();

      harness.embeddings.model = 'text-embedding-3-large';
      // The route moved again between resolution and promotion: the candidate is
      // no longer the space the configuration resolves to, so it must not
      // displace whatever is currently answering queries.
      const matches = vi.spyOn(harness.service, 'matchesConfiguredRoute')
        .mockResolvedValue(false);
      await settle();

      expect(matches).toHaveBeenCalled();
      expect((await harness.repository.getActiveIdentity())?.id).toBe(first!.id);
      const candidate = (await harness.repository.listIdentities())
        .find((identity) => identity.model === 'text-embedding-3-large');
      expect(candidate).toMatchObject({ status: 'ready' });
    });

    it('still activates the first identity when nothing is serving yet', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      // No active identity exists, so the route check is not consulted at all.
      const matches = vi.spyOn(harness.service, 'matchesConfiguredRoute');
      await settle();

      expect(await harness.repository.getActiveIdentity()).not.toBeNull();
      expect(matches).not.toHaveBeenCalled();
    });
  });

  // ─── Leases ─────────────────────────────────────────────────────────

  describe('leases', () => {
    it('claims intents under its own owner id and renews while working', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      const renew = vi.spyOn(harness.repository, 'renewIntentLease');
      const worker = createWorker({
        // A 1ms heartbeat forces at least one renewal during a 20ms embed.
        config: { intentLeaseMs: 5_000, heartbeatIntervalMs: 1 },
        owner: 'lease-owner',
      });
      const embed = harness.embeddings.embed.bind(harness.embeddings);
      vi.spyOn(harness.embeddings, 'embed').mockImplementation(async (request) => {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        return embed(request);
      });

      await worker.runCycle();
      await worker.runCycle();

      expect(renew).toHaveBeenCalled();
      expect(renew.mock.calls[0][0]).toMatchObject({ owner: 'lease-owner', leaseMs: 5_000 });
    });

    it('recovers leases abandoned by a crashed worker', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      const worker = createWorker();
      // Cycle 1 provisions and backfills; the intent is queued afterwards.
      await worker.runCycle();

      // Simulate a crash: an intent left running with an already-elapsed lease.
      const identity = (await harness.repository.listIdentities())[0];
      const [claimed] = await harness.repository.claimIntents({
        indexId: identity.id,
        owner: 'crashed-worker',
        limit: 1,
        leaseMs: 60_000,
        now: new Date().toISOString(),
      });
      expect(claimed?.status).toBe('running');
      harness.db.prepare(`
        UPDATE semantic_intents SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
      `).run(claimed.id);

      const recovering = createWorker({ config: { maintenanceIntervalMs: 30_000 } });
      const report = await recovering.runCycle();
      expect(report.leasesRecovered).toBeGreaterThan(0);
      expect((await harness.repository.getIntent(claimed.id))?.status).not.toBe('running');
    });

    it('stops the intent when its duration budget elapses', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      const worker = createWorker({ config: { intentBudgetMs: 5 } });
      await worker.runCycle();

      vi.spyOn(harness.embeddings, 'embed').mockImplementation(
        async (request) => new Promise((resolve) => {
          request.signal?.addEventListener('abort', () => {
            resolve({ status: 'aborted', reason: 'aborted', retryAfter: null });
          });
        }),
      );

      const drained = await worker.runCycle();
      expect(drained.intentsClaimed).toBe(1);
      const identity = (await harness.repository.listIdentities())[0];
      const queued = await harness.repository.claimIntents({
        indexId: identity.id,
        owner: 'inspector',
        limit: 5,
        leaseMs: 1_000,
        now: new Date().toISOString(),
      });
      // The budget released the intent for another attempt rather than
      // recording a bogus success.
      expect(queued).toHaveLength(1);
    });
  });

  // ─── Shutdown ───────────────────────────────────────────────────────

  describe('shutdown', () => {
    it('aborts in-flight work and stops within its grace period', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      const worker = createWorker({ config: { shutdownGraceMs: 50 } });
      await worker.runCycle();

      worker.start();
      const stopped = worker.stop();
      await expect(stopped).resolves.toBeUndefined();
      expect(worker.isRunning).toBe(false);
    });

    it('is idempotent', async () => {
      const worker = createWorker();
      worker.start();
      worker.start();
      await worker.stop();
      await worker.stop();
      expect(worker.isRunning).toBe(false);
    });
  });

  // ─── Redaction ──────────────────────────────────────────────────────

  describe('logging', () => {
    it('never emits document content, embeddings, or queries', async () => {
      const logger = await import('@/lib/logger');
      const emitted: unknown[] = [];
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.spyOn(logger.semanticIndexLogger, level).mockImplementation(((...args: unknown[]) => {
          emitted.push(args);
        }) as never);
      }

      harness.source.putTask(taskFixture({
        id: 'task-1',
        title: 'Extremely-Secret-Title',
        description: 'Extremely-Secret-Body',
      }));
      const worker = createWorker();
      await worker.runCycle();
      await worker.runCycle();

      const serialized = JSON.stringify(emitted);
      expect(serialized).not.toContain('Extremely-Secret-Title');
      expect(serialized).not.toContain('Extremely-Secret-Body');
      // Vector payloads and raw text never appear as log fields. (The model
      // name legitimately contains the word "embedding", so the key is what
      // matters here.)
      expect(serialized).not.toContain('"embedding"');
      expect(serialized).not.toContain('"body"');
      expect(serialized).not.toContain('"title"');
    });
  });
});
