import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SemanticIndexService } from '@/lib/semantic-index/service';
import type { SemanticIntent } from '@/lib/semantic-index/contracts';
import {
  FakeEmbeddingProvider,
  alertFixture,
  createSemanticHarness,
  houstonSummaryFixture,
  projectFixture,
  tagFixture,
  taskFixture,
  triageItemFixture,
  type SemanticHarness,
} from './harness';

const OWNER = 'worker-a';

describe('SemanticIndexService', () => {
  let harness: SemanticHarness;

  beforeEach(() => {
    harness = createSemanticHarness();
  });

  afterEach(() => {
    harness.close();
  });

  async function bootstrap() {
    const resolved = await harness.service.ensureIdentity({ create: true });
    if (resolved.status !== 'ready') throw new Error(`identity unavailable: ${resolved.reason}`);
    return resolved.identity;
  }

  async function claimOne(indexId: string): Promise<SemanticIntent> {
    const [intent] = await harness.repository.claimIntents({
      indexId,
      owner: OWNER,
      limit: 1,
      leaseMs: 60_000,
      now: new Date().toISOString(),
    });
    if (!intent) throw new Error('expected a claimable intent');
    return intent;
  }

  async function publishAndProcess(entityId: string, kind: 'upsert' | 'delete' = 'upsert') {
    const identity = await bootstrap();
    await harness.service.publish({ kind, entityType: 'task', entityId, indexId: identity.id });
    const intent = await claimOne(identity.id);
    const outcome = await harness.service.processIntent(intent, { owner: OWNER });
    return { identity, intent, outcome };
  }

  // ─── Identity ───────────────────────────────────────────────────────

  describe('ensureIdentity', () => {
    it('creates an identity from a real provider response once dimensions are known', async () => {
      const identity = await bootstrap();
      expect(identity).toMatchObject({
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 3,
        status: 'building',
      });
      // The probe is the only embedding call; it carries no user content.
      expect(harness.embeddings.calls).toHaveLength(1);
      expect(harness.embeddings.calls[0].text).toBe(
        'mission control semantic index dimension probe',
      );
      expect(harness.embeddings.calls[0].sensitivity).toBe('standard');
    });

    it('reuses the existing identity instead of probing again', async () => {
      await bootstrap();
      harness.embeddings.calls.length = 0;
      const again = await harness.service.ensureIdentity({ create: true });
      expect(again.status).toBe('ready');
      expect(again.status === 'ready' && again.created).toBe(false);
      expect(harness.embeddings.calls).toHaveLength(0);
    });

    it('refuses to create an identity when it may not create one', async () => {
      const resolved = await harness.service.ensureIdentity();
      expect(resolved).toMatchObject({ status: 'unavailable', reason: 'identity-not-created' });
    });

    it('reports the route resolution failure rather than inventing an identity', async () => {
      const denied = createSemanticHarness({
        embeddings: new FakeEmbeddingProvider({
          route: { status: 'denied', reason: 'routing-denied' },
        }),
      });
      try {
        expect(await denied.service.ensureIdentity({ create: true }))
          .toMatchObject({ status: 'unavailable', reason: 'routing-denied' });
      } finally {
        denied.close();
      }
    });

    it('does not create an identity when the probe fails', async () => {
      const embeddings = new FakeEmbeddingProvider();
      embeddings.enqueue({ status: 'retryable', reason: 'http-503', retryAfter: null });
      const flaky = createSemanticHarness({ embeddings });
      try {
        expect(await flaky.service.ensureIdentity({ create: true })).toMatchObject({
          status: 'unavailable',
          reason: 'dimension-probe-http-503',
        });
        expect(await flaky.repository.listIdentities()).toHaveLength(0);
      } finally {
        flaky.close();
      }
    });
  });

  describe('matchesConfiguredRoute', () => {
    it('recognises the identity built for the current provider, model, and projection', async () => {
      const identity = await bootstrap();
      expect(await harness.service.matchesConfiguredRoute(identity)).toBe(true);
    });

    it('rejects an identity whose model, provider, or projection has moved on', async () => {
      const identity = await bootstrap();

      harness.embeddings.model = 'text-embedding-3-large';
      expect(await harness.service.matchesConfiguredRoute(identity)).toBe(false);

      harness.embeddings.model = identity.model;
      harness.embeddings.provider = 'ollama';
      expect(await harness.service.matchesConfiguredRoute(identity)).toBe(false);

      harness.embeddings.provider = identity.provider;
      expect(await harness.service.matchesConfiguredRoute({
        ...identity,
        projectionVersion: identity.projectionVersion + 1,
      })).toBe(false);
    });

    it('rejects every identity when no route resolves at all', async () => {
      const unconfigured = createSemanticHarness({
        embeddings: new FakeEmbeddingProvider({
          route: { status: 'unconfigured', reason: 'provider-unconfigured' },
        }),
      });
      try {
        expect(await unconfigured.service.matchesConfiguredRoute({
          id: 'idx-1',
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 3,
          projectionVersion: 1,
          status: 'ready',
          documentCount: 0,
          vectorCount: 0,
          createdAt: '2026-08-29T00:00:00.000Z',
          updatedAt: '2026-08-29T00:00:00.000Z',
          readyAt: null,
          activatedAt: null,
          retiredAt: null,
          failureReason: null,
        })).toBe(false);
      } finally {
        unconfigured.close();
      }
    });
  });

  // ─── Publishing ─────────────────────────────────────────────────────

  describe('publish', () => {
    it('coalesces repeated work for one entity into a single queued row', async () => {
      const identity = await bootstrap();
      const first = await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      const second = await harness.service.publish({
        kind: 'delete', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      expect(first.reason).toBe('enqueued');
      expect(second.reason).toBe('coalesced');

      const intent = await claimOne(identity.id);
      // The newest intent wins, including its kind.
      expect(intent.kind).toBe('delete');
      expect(await harness.repository.claimIntents({
        indexId: identity.id, owner: OWNER, limit: 5, leaseMs: 1_000, now: new Date().toISOString(),
      })).toHaveLength(0);
    });

    it('skips rather than throws when no identity exists yet', async () => {
      const result = await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1',
      });
      expect(result).toMatchObject({ status: 'skipped', reason: 'identity-not-created' });
    });

    it('uses one kind-free idempotency key per entity', () => {
      expect(SemanticIndexService.idempotencyKey('idx', 'task', 't1'))
        .toBe('idx\u0000task\u0000t1');
    });
  });

  // ─── Intent processing ──────────────────────────────────────────────

  describe('processIntent', () => {
    it('projects, writes, and embeds a task on first sight', async () => {
      harness.source.putTask(taskFixture());
      const { identity, outcome } = await publishAndProcess('task-1');

      expect(outcome).toMatchObject({ status: 'succeeded', outcome: 'embedded' });
      const document = await harness.repository.getDocument(identity.id, 'task', 'task-1');
      expect(document).toMatchObject({
        title: 'Ship the semantic index',
        version: 1,
        projectionVersion: identity.projectionVersion,
        sensitivity: 'standard',
      });
      const vector = await harness.repository.getVector(identity.id, 'task', 'task-1');
      expect(vector).toMatchObject({
        documentVersion: 1,
        provider: 'openai',
        dimensions: 3,
        sourceRevision: document!.sourceRevision,
        contentFingerprint: document!.contentFingerprint,
      });
    });

    it('rereads the newest snapshot rather than trusting the intent', async () => {
      harness.source.putTask(taskFixture());
      const identity = await bootstrap();
      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      // The source changes between publish and claim.
      harness.source.putTask(taskFixture({
        title: 'Renamed after publish',
        updatedAt: '2026-08-21T00:00:00.000Z',
      }));
      const intent = await claimOne(identity.id);
      await harness.service.processIntent(intent, { owner: OWNER });

      const document = await harness.repository.getDocument(identity.id, 'task', 'task-1');
      expect(document?.title).toBe('Renamed after publish');
    });

    it('reports unchanged without touching the provider on a repeat', async () => {
      harness.source.putTask(taskFixture());
      const { identity } = await publishAndProcess('task-1');
      const before = harness.embeddings.calls.length;

      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      const outcome = await harness.service.processIntent(
        await claimOne(identity.id), { owner: OWNER },
      );

      expect(outcome).toMatchObject({ status: 'succeeded', outcome: 'unchanged' });
      expect(harness.embeddings.calls).toHaveLength(before);
    });

    it('rebinds the existing vector when only the source revision moved', async () => {
      harness.source.putTask(taskFixture());
      const { identity } = await publishAndProcess('task-1');
      const originalVector = await harness.repository.getVector(identity.id, 'task', 'task-1');
      const before = harness.embeddings.calls.length;

      // A sync touch bumps `updated_at` without changing any projected field,
      // so the revision moves while the fingerprint does not.
      harness.source.putTask(taskFixture({ updatedAt: '2026-08-22T00:00:00.000Z' }));
      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      const outcome = await harness.service.processIntent(
        await claimOne(identity.id), { owner: OWNER },
      );

      expect(outcome).toMatchObject({ status: 'succeeded', outcome: 'rebound' });
      expect(harness.embeddings.calls).toHaveLength(before);
      const rebound = await harness.repository.getVector(identity.id, 'task', 'task-1');
      const document = await harness.repository.getDocument(identity.id, 'task', 'task-1');
      expect(rebound?.documentVersion).toBe(document!.version);
      expect(rebound?.sourceRevision).toBe(document!.sourceRevision);
      expect(Array.from(rebound!.embedding)).toEqual(Array.from(originalVector!.embedding));
    });

    it('re-embeds when the projected content actually changes', async () => {
      harness.source.putTask(taskFixture());
      const { identity } = await publishAndProcess('task-1');
      const before = harness.embeddings.calls.length;

      harness.source.putTask(taskFixture({
        title: 'A materially different title',
        updatedAt: '2026-08-23T00:00:00.000Z',
      }));
      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      const outcome = await harness.service.processIntent(
        await claimOne(identity.id), { owner: OWNER },
      );

      expect(outcome).toMatchObject({ status: 'succeeded', outcome: 'embedded' });
      expect(harness.embeddings.calls.length).toBe(before + 1);
    });

    it('never lets a stale worker overwrite newer work', async () => {
      harness.source.putTask(taskFixture());
      const { identity } = await publishAndProcess('task-1');

      // A newer projection lands first.
      harness.source.putTask(taskFixture({
        title: 'Newer title',
        updatedAt: '2036-09-01T00:00:00.000Z',
      }));
      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      await harness.service.processIntent(await claimOne(identity.id), { owner: OWNER });

      // Now a delayed worker arrives carrying the older source snapshot.
      harness.source.putTask(taskFixture({
        title: 'Older title',
        updatedAt: '2036-08-01T00:00:00.000Z',
      }));
      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      const outcome = await harness.service.processIntent(
        await claimOne(identity.id), { owner: OWNER },
      );

      expect(outcome.status).toBe('succeeded');
      expect(outcome.outcome).toContain('document-stale');
      const document = await harness.repository.getDocument(identity.id, 'task', 'task-1');
      expect(document?.title).toBe('Newer title');
    });

    it('tombstones the document and drops the vector on delete', async () => {
      harness.source.putTask(taskFixture());
      const { identity } = await publishAndProcess('task-1');

      harness.source.tasks.delete('task-1');
      await harness.service.publish({
        kind: 'delete', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      const outcome = await harness.service.processIntent(
        await claimOne(identity.id), { owner: OWNER },
      );

      expect(outcome).toMatchObject({ status: 'succeeded', outcome: 'deleted' });
      const document = await harness.repository.getDocument(identity.id, 'task', 'task-1');
      expect(document?.deletedAt).not.toBeNull();
      expect(await harness.repository.getVector(identity.id, 'task', 'task-1')).toBeNull();
    });

    it('deletes when the source has vanished even on an upsert intent', async () => {
      harness.source.putTask(taskFixture());
      const { identity } = await publishAndProcess('task-1');
      harness.source.tasks.delete('task-1');

      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      const outcome = await harness.service.processIntent(
        await claimOne(identity.id), { owner: OWNER },
      );
      expect(outcome).toMatchObject({ status: 'succeeded', outcome: 'deleted' });
    });

    it('indexes a resurrected entity rather than honouring a stale delete', async () => {
      harness.source.putTask(taskFixture());
      const { identity, outcome } = await publishAndProcess('task-1', 'delete');
      expect(outcome).toMatchObject({ status: 'succeeded', outcome: 'embedded' });
      const document = await harness.repository.getDocument(identity.id, 'task', 'task-1');
      expect(document?.deletedAt).toBeNull();
    });

    it('records a policy denial as terminal', async () => {
      harness.source.putTask(taskFixture());
      const identity = await bootstrap();
      harness.embeddings.enqueue({
        status: 'denied', reason: 'local-only-egress-blocked', retryAfter: null,
      });
      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      const intent = await claimOne(identity.id);
      const outcome = await harness.service.processIntent(intent, { owner: OWNER });

      expect(outcome.status).toBe('denied');
      const stored = await harness.repository.getIntent(intent.id);
      expect(stored).toMatchObject({ status: 'denied', outcome: 'denied' });
    });

    it('requeues a retryable provider failure and honours its retry hint', async () => {
      harness.source.putTask(taskFixture());
      const identity = await bootstrap();
      harness.embeddings.enqueue({
        status: 'retryable', reason: 'http-429', retryAfter: '2099-01-01T00:00:00.000Z',
      });
      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      const intent = await claimOne(identity.id);
      const outcome = await harness.service.processIntent(intent, { owner: OWNER });

      expect(outcome.status).toBe('retry');
      const stored = await harness.repository.getIntent(intent.id);
      expect(stored).toMatchObject({
        status: 'queued',
        attempt: 1,
        retryAfter: '2099-01-01T00:00:00.000Z',
        availableAt: '2099-01-01T00:00:00.000Z',
      });
      // The document was still written; only the vector is outstanding.
      expect(await harness.repository.getDocument(identity.id, 'task', 'task-1')).not.toBeNull();
    });

    it('fails terminally on a deterministic provider failure', async () => {
      harness.source.putTask(taskFixture());
      const identity = await bootstrap();
      harness.embeddings.enqueue({
        status: 'failed', reason: 'route-mismatch', retryAfter: null,
      });
      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      const intent = await claimOne(identity.id);
      await harness.service.processIntent(intent, { owner: OWNER });
      expect(await harness.repository.getIntent(intent.id)).toMatchObject({ status: 'failed' });
    });

    it('releases immediately for reclaim when aborted', async () => {
      harness.source.putTask(taskFixture());
      const identity = await bootstrap();
      const controller = new AbortController();
      controller.abort();
      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      const intent = await claimOne(identity.id);
      const outcome = await harness.service.processIntent(intent, {
        owner: OWNER, signal: controller.signal,
      });

      expect(outcome.status).toBe('aborted');
      const stored = await harness.repository.getIntent(intent.id);
      expect(stored?.status).toBe('queued');
      expect(new Date(stored!.availableAt).getTime())
        .toBeLessThanOrEqual(Date.now() + 1_000);
    });

    it('records nothing when the lease has already been lost', async () => {
      harness.source.putTask(taskFixture());
      const identity = await bootstrap();
      await harness.service.publish({
        kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.id,
      });
      const intent = await claimOne(identity.id);
      const outcome = await harness.service.processIntent(intent, { owner: 'someone-else' });

      expect(outcome).toMatchObject({ status: 'lease-lost' });
      const stored = await harness.repository.getIntent(intent.id);
      expect(stored).toMatchObject({ status: 'running', leaseOwner: OWNER });
    });

    it('indexes minimized Houston summaries with retention and authorization metadata', async () => {
      harness.source.putHoustonSummary({
        entityType: 'houston-summary',
        semanticEligible: true,
        id: 'conversation-1',
        authorizationScope: 'installation',
        title: 'Release planning',
        summary: 'Use a staged rollout.',
        decisions: ['Ship Friday'],
        commitments: [],
        topics: ['release'],
        linkedEntities: [],
        sensitivity: 'restricted',
        retainUntil: '2099-01-01T00:00:00.000Z',
        excludedAt: null,
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      });
      const identity = await bootstrap();
      await harness.repository.enqueueIntent({
        id: 'intent-houston',
        idempotencyKey: 'k1',
        indexId: identity.id,
        kind: 'upsert',
        entityType: 'houston-summary',
        entityId: 'conversation-1',
        requestedAt: new Date().toISOString(),
        now: new Date().toISOString(),
      });
      const intent = await claimOne(identity.id);
      const outcome = await harness.service.processIntent(intent, { owner: OWNER });
      expect(outcome).toMatchObject({ status: 'succeeded' });
      const document = await harness.repository.getDocument(identity.id, 'houston-summary', 'conversation-1');
      expect(document).toMatchObject({
        retainUntil: '2099-01-01T00:00:00.000Z',
        metadata: { authorizationScope: 'installation' },
      });
    });

    it('filters disabled entity kinds before applying the intent claim limit', async () => {
      const identity = await bootstrap();
      const now = new Date().toISOString();
      await harness.repository.enqueueIntent({
        id: 'intent-task-first',
        idempotencyKey: 'task-first',
        indexId: identity.id,
        kind: 'upsert',
        entityType: 'task',
        entityId: 'task-1',
        requestedAt: '2020-01-01T00:00:00.000Z',
        now,
      });
      await harness.repository.enqueueIntent({
        id: 'intent-houston-second',
        idempotencyKey: 'houston-second',
        indexId: identity.id,
        kind: 'upsert',
        entityType: 'houston-summary',
        entityId: 'conversation-1',
        requestedAt: '2020-01-02T00:00:00.000Z',
        now,
      });

      const claimed = await harness.repository.claimIntents({
        indexId: identity.id,
        owner: OWNER,
        entityTypes: ['houston-summary'],
        limit: 1,
        leaseMs: 60_000,
        now,
      });

      expect(claimed).toHaveLength(1);
      expect(claimed[0].entityType).toBe('houston-summary');
    });

    it('tombstones expired Houston summaries before embedding', async () => {
      harness.source.putHoustonSummary({
        entityType: 'houston-summary',
        semanticEligible: true,
        id: 'conversation-expired',
        authorizationScope: 'installation',
        title: 'Old planning',
        summary: 'This memory has expired.',
        decisions: [],
        commitments: [],
        topics: [],
        linkedEntities: [],
        sensitivity: 'restricted',
        retainUntil: '2000-01-01T00:00:00.000Z',
        excludedAt: null,
        createdAt: '1999-01-01T00:00:00.000Z',
        updatedAt: '1999-01-01T00:00:00.000Z',
      });
      const identity = await bootstrap();
      const embeddingCalls = harness.embeddings.calls.length;
      await harness.service.publish({
        kind: 'upsert',
        entityType: 'houston-summary',
        entityId: 'conversation-expired',
        indexId: identity.id,
      });
      const intent = await claimOne(identity.id);
      const outcome = await harness.service.processIntent(intent, { owner: OWNER });

      expect(outcome).toMatchObject({ status: 'succeeded', outcome: 'missing' });
      expect(harness.embeddings.calls).toHaveLength(embeddingCalls);
      expect(await harness.repository.getVector(
        identity.id,
        'houston-summary',
        'conversation-expired',
      )).toBeNull();
    });

    it('uses the same upsert and delete lifecycle for all six entity kinds', async () => {
      harness.source.putTask(taskFixture());
      harness.source.putProject(projectFixture());
      harness.source.putTag(tagFixture());
      harness.source.putTriageItem(triageItemFixture());
      harness.source.putAlert(alertFixture());
      harness.source.putHoustonSummary(houstonSummaryFixture());
      const identity = await bootstrap();

      for (const [entityType, entityId, remove] of [
        ['task', 'task-1', () => harness.source.tasks.delete('task-1')],
        ['project', 'project-1', () => harness.source.projects.delete('project-1')],
        ['tag', 'tag-1', () => harness.source.tags.delete('tag-1')],
        ['triage-item', 'triage-1', () => harness.source.triageItems.delete('triage-1')],
        ['alert', 'alert-1', () => harness.source.alerts.delete('alert-1')],
        ['houston-summary', 'conversation-1',
          () => harness.source.houstonSummaries.delete('conversation-1')],
      ] as const) {
        await harness.service.publish({ kind: 'upsert', entityType, entityId, indexId: identity.id });
        const created = await harness.service.processIntent(
          await claimOne(identity.id), { owner: OWNER },
        );
        expect(created).toMatchObject({ status: 'succeeded', outcome: 'embedded' });
        expect(await harness.repository.getVector(identity.id, entityType, entityId)).not.toBeNull();

        remove();
        await harness.service.publish({ kind: 'delete', entityType, entityId, indexId: identity.id });
        const deleted = await harness.service.processIntent(
          await claimOne(identity.id), { owner: OWNER },
        );
        expect(deleted).toMatchObject({ status: 'succeeded', outcome: 'deleted' });
        expect(await harness.repository.getVector(identity.id, entityType, entityId)).toBeNull();
      }
    });

    it('tombstones and resurrects sources when eligibility changes without a newer timestamp', async () => {
      harness.source.putProject(projectFixture());
      const identity = await bootstrap();
      const processProject = async () => {
        await harness.service.publish({
          kind: 'upsert',
          entityType: 'project',
          entityId: 'project-1',
          indexId: identity.id,
        });
        return harness.service.processIntent(
          await claimOne(identity.id),
          { owner: OWNER },
        );
      };

      await expect(processProject()).resolves.toMatchObject({ outcome: 'embedded' });
      const initiallyStored = await harness.repository.getDocument(
        identity.id,
        'project',
        'project-1',
      );
      expect(initiallyStored).not.toBeNull();
      expect(initiallyStored!.sourceUpdatedAt > '2026-08-20T00:00:00.000Z').toBe(true);
      harness.source.putProject(projectFixture({ semanticEligible: false, hidden: true }));
      await expect(processProject()).resolves.toMatchObject({ outcome: 'deleted' });
      expect(await harness.repository.getDocument(identity.id, 'project', 'project-1'))
        .toMatchObject({ entityId: 'project-1' });
      expect((await harness.repository.getDocument(identity.id, 'project', 'project-1'))?.deletedAt)
        .not.toBeNull();

      harness.source.putProject(projectFixture());
      await expect(processProject()).resolves.toMatchObject({ outcome: 'embedded' });
      expect(await harness.repository.getDocument(identity.id, 'project', 'project-1'))
        .toMatchObject({ entityId: 'project-1', deletedAt: null });
    });

    it('carries alert retention onto the document and its vector', async () => {
      harness.source.putAlert(alertFixture({ expiresAt: '2026-12-01T00:00:00.000Z' }));
      const identity = await bootstrap();
      await harness.service.publish({
        kind: 'upsert', entityType: 'alert', entityId: 'alert-1', indexId: identity.id,
      });
      await harness.service.processIntent(await claimOne(identity.id), { owner: OWNER });

      const document = await harness.repository.getDocument(identity.id, 'alert', 'alert-1');
      const vector = await harness.repository.getVector(identity.id, 'alert', 'alert-1');
      expect(document?.retainUntil).toBe('2026-12-01T00:00:00.000Z');
      expect(vector?.expiresAt).toBe('2026-12-01T00:00:00.000Z');
    });

    it('passes the document sensitivity and connector source to the provider', async () => {
      harness.source.putTask(taskFixture({ connectorType: 'monarch-money' }));
      const restricted = createSemanticHarness({ sensitivity: 'restricted' });
      try {
        const identity = await restricted.service.ensureIdentity({ create: true });
        if (identity.status !== 'ready') throw new Error('identity unavailable');
        restricted.source.putTask(taskFixture({ connectorType: 'monarch-money' }));
        await restricted.service.publish({
          kind: 'upsert', entityType: 'task', entityId: 'task-1', indexId: identity.identity.id,
        });
        const [intent] = await restricted.repository.claimIntents({
          indexId: identity.identity.id,
          owner: OWNER,
          limit: 1,
          leaseMs: 60_000,
          now: new Date().toISOString(),
        });
        await restricted.service.processIntent(intent, { owner: OWNER });

        const call = restricted.embeddings.calls.at(-1)!;
        expect(call.sensitivity).toBe('restricted');
        expect(call.sources).toEqual(['mission-control', 'monarch-money']);
        expect(call.expect).toMatchObject({
          provider: 'openai', model: 'text-embedding-3-small', dimensions: 3,
        });
      } finally {
        restricted.close();
      }
    });

    it('passes every contributing connector source for aggregate projections', async () => {
      const aggregate = createSemanticHarness({
        sensitivity: (connectorType) =>
          connectorType === 'monarch-money' ? 'restricted' : 'standard',
      });
      try {
        const identity = await aggregate.service.ensureIdentity({ create: true });
        if (identity.status !== 'ready') throw new Error('identity unavailable');
        aggregate.source.putProject(projectFixture({
          representativeTaskConnectorTypes: ['github-issues', 'monarch-money'],
        }));
        await aggregate.service.publish({
          kind: 'upsert',
          entityType: 'project',
          entityId: 'project-1',
          indexId: identity.identity.id,
        });
        const [intent] = await aggregate.repository.claimIntents({
          indexId: identity.identity.id,
          owner: OWNER,
          limit: 1,
          leaseMs: 60_000,
          now: new Date().toISOString(),
        });
        await aggregate.service.processIntent(intent, { owner: OWNER });

        const call = aggregate.embeddings.calls.at(-1)!;
        expect(call.sensitivity).toBe('restricted');
        expect(call.sources).toEqual(['github-issues', 'mission-control', 'monarch-money']);
      } finally {
        aggregate.close();
      }
    });
  });
});
