import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseKindCursor,
  runBackfillSlice,
  runCleanupSlice,
  runReconcileSlice,
  serializeKindCursor,
  type SemanticRunContext,
  type SemanticRunDependencies,
} from '@/lib/semantic-index/runs';
import type {
  SemanticIndexIdentity,
  SemanticIntent,
  SemanticRun,
} from '@/lib/semantic-index/contracts';
import {
  alertFixture,
  createSemanticHarness,
  taskFixture,
  type SemanticHarness,
} from './harness';

const OWNER = 'run-worker';

function makeRun(overrides: Partial<SemanticRun> = {}): SemanticRun {
  return {
    id: 'run-1',
    indexId: 'idx',
    kind: 'backfill',
    idempotencyKey: 'key-1',
    status: 'running',
    checkpoint: null,
    processedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    attempt: 1,
    maxAttempts: 3,
    availableAt: '2026-08-29T00:00:00.000Z',
    leaseOwner: OWNER,
    leaseExpiresAt: '2026-08-29T01:00:00.000Z',
    errorMessage: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    startedAt: '2026-08-29T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

describe('semantic index runs', () => {
  let harness: SemanticHarness;
  let identity: SemanticIndexIdentity;
  let deps: SemanticRunDependencies;

  beforeEach(async () => {
    harness = createSemanticHarness();
    const resolved = await harness.service.ensureIdentity({ create: true });
    if (resolved.status !== 'ready') throw new Error('identity unavailable');
    identity = resolved.identity;
    deps = {
      repository: harness.repository,
      source: harness.source,
      service: harness.service,
      config: { ...harness.config, runPageSize: 2 },
      now: () => new Date().toISOString(),
    };
  });

  afterEach(() => {
    harness.close();
  });

  function context(overrides: Partial<SemanticRunContext> = {}): SemanticRunContext {
    return {
      run: makeRun({ indexId: identity.id }),
      identity,
      owner: OWNER,
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 60_000,
      ...overrides,
    };
  }

  async function drainQueue(): Promise<SemanticIntent[]> {
    const processed: SemanticIntent[] = [];
    for (;;) {
      const claimed = await harness.repository.claimIntents({
        indexId: identity.id,
        owner: OWNER,
        limit: 25,
        leaseMs: 60_000,
        now: new Date().toISOString(),
      });
      if (claimed.length === 0) return processed;
      for (const intent of claimed) {
        await harness.service.processIntent(intent, { owner: OWNER });
        processed.push(intent);
      }
    }
  }

  async function queuedEntityIds(): Promise<string[]> {
    const claimed = await harness.repository.claimIntents({
      indexId: identity.id,
      owner: 'inspector',
      limit: 100,
      leaseMs: 1_000,
      now: new Date().toISOString(),
    });
    return claimed.map((intent) => `${intent.kind}:${intent.entityType}:${intent.entityId}`).sort();
  }

  // ─── Checkpoints ────────────────────────────────────────────────────

  describe('checkpoints', () => {
    it('round-trips a kind cursor', () => {
      const cursor = { kind: 'alert' as const, after: 'a-9' };
      expect(parseKindCursor(serializeKindCursor(cursor))).toEqual(cursor);
    });

    it('restarts from the beginning rather than skipping on a corrupt checkpoint', () => {
      expect(parseKindCursor('not json')).toEqual({ kind: 'task', after: null });
      expect(parseKindCursor('{"kind":"unknown","after":"x"}'))
        .toEqual({ kind: 'task', after: null });
      expect(parseKindCursor(null)).toEqual({ kind: 'task', after: null });
    });
  });

  // ─── Backfill ───────────────────────────────────────────────────────

  describe('backfill', () => {
    beforeEach(() => {
      for (let index = 1; index <= 5; index++) {
        harness.source.putTask(taskFixture({ id: `task-${index}` }));
      }
      harness.source.putAlert(alertFixture({ id: 'alert-1' }));
    });

    it('walks every kind and enqueues one intent per entity', async () => {
      const result = await runBackfillSlice(context(), deps);
      expect(result.status).toBe('completed');
      expect(result.processed).toBe(6);
      expect(result.checkpoint).toBeNull();
      expect(await queuedEntityIds()).toEqual([
        'upsert:alert:alert-1',
        'upsert:task:task-1',
        'upsert:task:task-2',
        'upsert:task:task-3',
        'upsert:task:task-4',
        'upsert:task:task-5',
      ]);
    });

    it('yields at its deadline and resumes from the checkpoint without rescanning', async () => {
      // One page costs 20ms of simulated latency, so a 10ms budget always
      // yields after exactly one page — no reliance on wall-clock luck.
      harness.source.pageDelayMs = 20;
      const first = await runBackfillSlice(
        context({ deadlineMs: Date.now() + 10 }), deps,
      );
      harness.source.pageDelayMs = 0;
      expect(first.status).toBe('yielded');
      // A slice always completes at least the page it started, so the cursor
      // is the last id it actually handled — never the page it never read.
      expect(first.checkpoint).toBe(JSON.stringify({ kind: 'task', after: 'task-2' }));
      expect(first.processed).toBe(2);

      // Resume with a fresh, generous deadline from the persisted checkpoint.
      const resumed = await runBackfillSlice(
        context({ run: makeRun({ indexId: identity.id, checkpoint: first.checkpoint }) }),
        deps,
      );
      expect(resumed.status).toBe('completed');
      expect(await queuedEntityIds()).toHaveLength(6);
    });

    it('resumes strictly after the checkpointed id', async () => {
      const result = await runBackfillSlice(
        context({
          run: makeRun({
            indexId: identity.id,
            checkpoint: JSON.stringify({ kind: 'task', after: 'task-3' }),
          }),
        }),
        deps,
      );
      expect(result.status).toBe('completed');
      expect(await queuedEntityIds()).toEqual([
        'upsert:alert:alert-1',
        'upsert:task:task-4',
        'upsert:task:task-5',
      ]);
    });

    it('stops immediately when aborted, preserving its cursor', async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await runBackfillSlice(context({ signal: controller.signal }), deps);
      expect(result.status).toBe('aborted');
      expect(result.processed).toBe(0);
      expect(result.checkpoint).toBe(JSON.stringify({ kind: 'task', after: null }));
    });
  });

  // ─── Reconciliation ─────────────────────────────────────────────────

  describe('reconciliation', () => {
    it('enqueues nothing when the index already matches the source', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      await runBackfillSlice(context(), deps);
      await drainQueue();

      const result = await runReconcileSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'reconcile' }) }), deps,
      );
      expect(result.status).toBe('completed');
      expect(result.processed).toBe(0);
      expect(result.detail).toMatchObject({ missing: 0, stale: 0, incompatible: 0, orphaned: 0 });
    });

    it('detects a source entity with no document', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      const result = await runReconcileSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'reconcile' }) }), deps,
      );
      expect(result.detail).toMatchObject({ missing: 1 });
      expect(await queuedEntityIds()).toEqual(['upsert:task:task-1']);
    });

    it('detects a document whose revision drifted from the source', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      await runBackfillSlice(context(), deps);
      await drainQueue();

      harness.source.putTask(taskFixture({ id: 'task-1', title: 'Changed outside the queue' }));
      const result = await runReconcileSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'reconcile' }) }), deps,
      );
      expect(result.detail).toMatchObject({ stale: 1 });
      expect(await queuedEntityIds()).toEqual(['upsert:task:task-1']);
    });

    it('detects a document with no vector as incompatible', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      await runBackfillSlice(context(), deps);
      await drainQueue();
      await harness.repository.deleteVector(identity.id, 'task', 'task-1');

      const result = await runReconcileSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'reconcile' }) }), deps,
      );
      expect(result.detail).toMatchObject({ incompatible: 1 });
    });

    it('detects a vector from a foreign vector space as incompatible', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      await runBackfillSlice(context(), deps);
      await drainQueue();
      harness.db
        .prepare("UPDATE semantic_vectors SET model = 'other-model' WHERE entity_id = 'task-1'")
        .run();

      const result = await runReconcileSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'reconcile' }) }), deps,
      );
      expect(result.detail).toMatchObject({ incompatible: 1 });
    });

    it('enqueues a delete for a document whose source is gone', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      harness.source.putTask(taskFixture({ id: 'task-2' }));
      await runBackfillSlice(context(), deps);
      await drainQueue();
      harness.source.tasks.delete('task-2');

      const result = await runReconcileSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'reconcile' }) }), deps,
      );
      expect(result.detail).toMatchObject({ orphaned: 1 });
      expect(await queuedEntityIds()).toEqual(['delete:task:task-2']);
    });

    it('counts a retention-expired document without re-enqueuing it', async () => {
      harness.source.putAlert(alertFixture({
        id: 'alert-1',
        expiresAt: '2000-01-01T00:00:00.000Z',
      }));
      await runBackfillSlice(context(), deps);
      await drainQueue();

      const result = await runReconcileSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'reconcile' }) }), deps,
      );
      expect(result.detail).toMatchObject({ retentionExpired: 1 });
      expect(await queuedEntityIds()).toEqual([]);
    });

    it('never judges an entity outside the overlapping page window', async () => {
      // Five sources, one document, page size 2: the document page is exhausted
      // long before the source page is, so the run must not declare the
      // trailing documents orphaned.
      for (let index = 1; index <= 5; index++) {
        harness.source.putTask(taskFixture({ id: `task-${index}` }));
      }
      await runBackfillSlice(context(), deps);
      await drainQueue();
      harness.source.tasks.clear();

      const result = await runReconcileSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'reconcile' }) }), deps,
      );
      expect(result.detail).toMatchObject({ orphaned: 5, missing: 0 });
      expect(await queuedEntityIds()).toHaveLength(5);
    });

    it('resumes reconciliation from its checkpoint', async () => {
      for (let index = 1; index <= 5; index++) {
        harness.source.putTask(taskFixture({ id: `task-${index}` }));
      }
      harness.source.pageDelayMs = 20;
      const first = await runReconcileSlice(
        context({
          run: makeRun({ indexId: identity.id, kind: 'reconcile' }),
          deadlineMs: Date.now() + 10,
        }),
        deps,
      );
      harness.source.pageDelayMs = 0;
      expect(first.status).toBe('yielded');
      const resumed = await runReconcileSlice(
        context({
          run: makeRun({
            indexId: identity.id, kind: 'reconcile', checkpoint: first.checkpoint,
          }),
        }),
        deps,
      );
      expect(resumed.status).toBe('completed');
      expect(await queuedEntityIds()).toHaveLength(5);
    });
  });

  // ─── Cleanup ────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('expires documents past their retention deadline and drops their vectors', async () => {
      harness.source.putAlert(alertFixture({
        id: 'alert-1',
        expiresAt: '2000-01-01T00:00:00.000Z',
      }));
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      await runBackfillSlice(context(), deps);
      await drainQueue();

      const result = await runCleanupSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'cleanup' }) }), deps,
      );
      expect(result.status).toBe('completed');
      expect(result.detail).toMatchObject({ documentsExpired: 1, vectorsRemoved: 1 });

      const expired = await harness.repository.getDocument(identity.id, 'alert', 'alert-1');
      expect(expired?.deletedAt).not.toBeNull();
      expect(await harness.repository.getVector(identity.id, 'alert', 'alert-1')).toBeNull();
      // The unexpired task is untouched.
      const kept = await harness.repository.getDocument(identity.id, 'task', 'task-1');
      expect(kept?.deletedAt).toBeNull();
    });

    it('hard-deletes tombstones older than the retention window', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      await runBackfillSlice(context(), deps);
      await drainQueue();
      await harness.repository.deleteDocument({
        indexId: identity.id,
        entityType: 'task',
        entityId: 'task-1',
        now: '2000-01-01T00:00:00.000Z',
      });

      const result = await runCleanupSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'cleanup' }) }), deps,
      );
      expect(result.detail).toMatchObject({ documentsPurged: 1 });
      expect(await harness.repository.getDocument(identity.id, 'task', 'task-1')).toBeNull();
    });

    it('prunes terminal intent history but keeps live rows', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      await runBackfillSlice(context(), deps);
      await drainQueue();
      harness.db.prepare(`
        UPDATE semantic_intents SET completed_at = '2000-01-01T00:00:00.000Z'
        WHERE status = 'succeeded'
      `).run();
      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });

      const result = await runCleanupSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'cleanup' }) }), deps,
      );
      expect(result.detail?.intentsPruned).toBeGreaterThan(0);
      const remaining = harness.db
        .prepare('SELECT COUNT(*) AS count FROM semantic_intents').get() as { count: number };
      expect(remaining.count).toBe(1);
    });

    it('removes only aged retired identities and never the active one', async () => {
      harness.source.putTask(taskFixture({ id: 'task-1' }));
      await runBackfillSlice(context(), deps);
      await drainQueue();
      await harness.repository.markIdentityReady(identity.id, new Date().toISOString());
      await harness.repository.activateIdentity(identity.id, new Date().toISOString());

      const retired = await harness.repository.createIdentity({
        id: 'old-identity',
        provider: 'openai',
        model: 'legacy-model',
        dimensions: 3,
        projectionVersion: 1,
        now: '2000-01-01T00:00:00.000Z',
      });
      await harness.repository.retireIdentity(retired.id, '2000-01-02T00:00:00.000Z');

      const result = await runCleanupSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'cleanup' }) }), deps,
      );
      expect(result.detail).toMatchObject({ identitiesRemoved: 1 });
      expect(await harness.repository.getIdentity('old-identity')).toBeNull();
      expect(await harness.repository.getIdentity(identity.id)).not.toBeNull();
    });

    it('stops after the first step when aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await runCleanupSlice(
        context({ run: makeRun({ indexId: identity.id, kind: 'cleanup' }), signal: controller.signal }),
        deps,
      );
      expect(result.status).toBe('aborted');
    });
  });
});
