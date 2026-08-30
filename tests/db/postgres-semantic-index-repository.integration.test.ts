import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { PostgresSemanticIndexRepository } from '@/db/postgres/semantic-index/repository';
import { supersededRunIdempotencyKey } from '@/lib/semantic-index/validation';
import type {
  SemanticDocumentWrite,
  SemanticIntentEnqueue,
  SemanticMetadataFilter,
  SemanticVectorWrite,
} from '@/lib/semantic-index/contracts';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

const T0 = '2026-08-29T00:00:00.000Z';
const T1 = '2026-08-29T01:00:00.000Z';
const T2 = '2026-08-29T02:00:00.000Z';

describePostgres('PostgreSQL semantic index repository integration', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-semantic-index-test',
          }),
        }
      : {}),
  });
  let repository: PostgresSemanticIndexRepository;
  const identityIds = new Set<string>();

  beforeAll(async () => {
    if (connectionString) assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
    repository = new PostgresSemanticIndexRepository(backend.context.pool, 100);
  }, 120_000);

  afterEach(async () => {
    for (const id of identityIds) {
      await backend.context.pool.query('DELETE FROM semantic_vectors WHERE index_id = $1', [id]);
      await backend.context.pool.query('DELETE FROM semantic_documents WHERE index_id = $1', [id]);
      await backend.context.pool.query('DELETE FROM semantic_intents WHERE index_id = $1', [id]);
      await backend.context.pool.query('DELETE FROM semantic_runs WHERE index_id = $1', [id]);
      await backend.context.pool.query('DELETE FROM semantic_index_identities WHERE id = $1', [id]);
    }
    identityIds.clear();
  });

  afterAll(async () => {
    await backend.shutdown();
  });

  async function createIdentity(overrides: { status?: 'building' | 'ready' } = {}) {
    const id = `semantic-${randomUUID()}`;
    identityIds.add(id);
    await repository.createIdentity({
      id,
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 3,
      projectionVersion: 1,
      now: T0,
      ...overrides,
    });
    return id;
  }

  function documentFor(indexId: string, overrides: Partial<SemanticDocumentWrite> = {}): SemanticDocumentWrite {
    return {
      id: `doc-${randomUUID()}`,
      indexId,
      entityType: 'task',
      entityId: 'task-1',
      title: 'Integration task',
      body: 'Body text',
      keywords: ['integration'],
      metadata: { status: 'todo', flagged: true },
      sourceRevision: 'rev-1',
      contentFingerprint: 'fp-1',
      projectionVersion: 1,
      sensitivity: 'standard',
      retainUntil: null,
      sourceUpdatedAt: T0,
      now: T0,
      ...overrides,
    };
  }

  function vectorFor(
    indexId: string,
    documentId: string,
    overrides: Partial<SemanticVectorWrite> = {},
  ): SemanticVectorWrite {
    return {
      id: `vec-${randomUUID()}`,
      indexId,
      documentId,
      documentVersion: 1,
      entityType: 'task',
      entityId: 'task-1',
      sourceRevision: 'rev-1',
      contentFingerprint: 'fp-1',
      projectionVersion: 1,
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 3,
      sensitivity: 'standard',
      embedding: new Float32Array([1, 0, 0]),
      sourceUpdatedAt: T0,
      embeddedAt: T0,
      indexRunId: null,
      intentId: null,
      expiresAt: null,
      now: T0,
      ...overrides,
    };
  }

  function intentFor(indexId: string, overrides: Partial<SemanticIntentEnqueue> = {}): SemanticIntentEnqueue {
    return {
      id: `intent-${randomUUID()}`,
      idempotencyKey: `${indexId}:upsert:task:task-1`,
      indexId,
      kind: 'upsert',
      entityType: 'task',
      entityId: 'task-1',
      sourceRevision: 'rev-1',
      contentFingerprint: 'fp-1',
      projectionVersion: 1,
      requestedAt: T0,
      now: T0,
      ...overrides,
    };
  }

  it('persists a versioned document with jsonb keywords and metadata intact', async () => {
    const indexId = await createIdentity();
    const created = await repository.upsertDocument(documentFor(indexId));
    expect(created.status).toBe('created');
    expect(created.document).toMatchObject({
      version: 1,
      keywords: ['integration'],
      metadata: { status: 'todo', flagged: true },
    });

    const unchanged = await repository.upsertDocument(
      documentFor(indexId, { id: created.document!.id }),
    );
    expect(unchanged.status).toBe('unchanged');

    const updated = await repository.upsertDocument(documentFor(indexId, {
      id: created.document!.id,
      title: 'Renamed',
      sourceRevision: 'rev-2',
      contentFingerprint: 'fp-2',
      sourceUpdatedAt: T1,
      now: T1,
    }));
    expect(updated.status).toBe('updated');
    expect(updated.document?.version).toBe(2);

    const stale = await repository.upsertDocument(documentFor(indexId, {
      id: created.document!.id, sourceUpdatedAt: T0, now: T2,
    }));
    expect(stale).toMatchObject({ status: 'stale', reason: 'older-source-update' });

    expect((await repository.getIdentity(indexId))?.documentCount).toBe(1);
  });

  it('reports a re-ordered jsonb metadata rewrite as unchanged, leaving the vector current', async () => {
    const indexId = await createIdentity();
    const created = await repository.upsertDocument(documentFor(indexId, {
      metadata: { status: 'todo', connectorType: 'github-issues', effort: 3, flagged: true },
    }));
    expect(created.status).toBe('created');
    const vector = await repository.upsertVector(vectorFor(indexId, created.document!.id));
    expect(vector.status).toBe('created');

    // PostgreSQL stores metadata as jsonb and hands it back in its own key
    // order; the same projection written again must not be seen as a change.
    const rewritten = await repository.upsertDocument(documentFor(indexId, {
      id: created.document!.id,
      metadata: { flagged: true, effort: 3, connectorType: 'github-issues', status: 'todo' },
    }));
    expect(rewritten.status).toBe('unchanged');
    expect(rewritten.document?.version).toBe(1);

    // The vector therefore still matches the current document version — it was
    // neither invalidated nor rewritten.
    const stored = await repository.getVector(indexId, 'task', 'task-1');
    expect(stored).toMatchObject({ documentVersion: 1, embeddedAt: T0 });
    const readiness = await repository.getReadiness(T1);
    expect(readiness.byEntityType.find((kind) => kind.entityType === 'task')?.stale).toBe(0);

    // A real metadata change is still a new version.
    const changed = await repository.upsertDocument(documentFor(indexId, {
      id: created.document!.id,
      metadata: { flagged: false, effort: 3, connectorType: 'github-issues', status: 'todo' },
      now: T1,
    }));
    expect(changed).toMatchObject({ status: 'updated', document: { version: 2 } });
  });

  it('filters numeric, boolean, and string metadata identically to SQLite', async () => {
    const indexId = await createIdentity({ status: 'ready' });
    const alpha = (await repository.upsertDocument(documentFor(indexId, {
      entityId: 'alpha',
      metadata: { status: 'todo', effort: 3, isChecklistItem: true, parentId: null },
    }))).document!;
    await repository.upsertVector(vectorFor(indexId, alpha.id, { entityId: 'alpha' }));
    const beta = (await repository.upsertDocument(documentFor(indexId, {
      entityId: 'beta',
      metadata: { status: 'done', effort: 5, isChecklistItem: false },
    }))).document!;
    await repository.upsertVector(vectorFor(indexId, beta.id, { entityId: 'beta' }));

    const query = async (filter: SemanticMetadataFilter) => {
      const response = await repository.queryVectors({
        indexId,
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 10,
        now: T2,
        metadataFilters: [filter],
      });
      return response.results.map((result) => result.entityId).sort();
    };

    expect(await query({ keys: ['effort'], match: 'any', values: ['3'] })).toEqual(['alpha']);
    expect(await query({ keys: ['isChecklistItem'], match: 'any', values: ['true'] }))
      .toEqual(['alpha']);
    expect(await query({ keys: ['isChecklistItem'], match: 'any', values: ['false'] }))
      .toEqual(['beta']);
    expect(await query({ keys: ['isChecklistItem'], match: 'any', values: ['1'] })).toEqual([]);
    expect(await query({ keys: ['status'], match: 'any', values: ['todo'] })).toEqual(['alpha']);

    expect(await query({ keys: ['effort'], match: 'none', values: ['3'] })).toEqual(['beta']);
    expect(await query({ keys: ['isChecklistItem'], match: 'none', values: ['true'] }))
      .toEqual(['beta']);
    // A JSON null passes an exclusion exactly as an absent key does.
    expect(await query({ keys: ['parentId'], match: 'none', values: ['task-9'] }))
      .toEqual(['alpha', 'beta']);
    expect(await query({ keys: ['parentId'], match: 'any', values: ['task-9'] })).toEqual([]);
    expect(await query({
      keys: ['isChecklistItem'], match: 'any', values: ['TRUE'], caseInsensitive: true,
    })).toEqual(['alpha']);
  });

  it('does not let delayed work resurrect a deleted document', async () => {
    const indexId = await createIdentity();
    const document = (await repository.upsertDocument(documentFor(indexId))).document!;
    await repository.upsertVector(vectorFor(indexId, document.id));

    expect(await repository.deleteDocument({
      indexId, entityType: 'task', entityId: 'task-1', now: T1,
    })).toEqual({ status: 'deleted', removedVectors: 1 });

    expect(await repository.upsertDocument(documentFor(indexId, {
      id: document.id, sourceUpdatedAt: T0, now: T2,
    }))).toMatchObject({ status: 'stale', reason: 'older-source-update' });
    expect((await repository.getDocument(indexId, 'task', 'task-1'))?.deletedAt).toBe(T1);

    // A genuinely newer projection does restore it.
    expect(await repository.upsertDocument(documentFor(indexId, {
      id: document.id, sourceRevision: 'rev-3', sourceUpdatedAt: T2, now: T2,
    }))).toMatchObject({ status: 'updated' });
    expect((await repository.getIdentity(indexId))?.documentCount).toBe(1);
  });

  it('lists documents with their vector state by a keyset entity-id cursor', async () => {
    const indexId = await createIdentity();
    const first = (await repository.upsertDocument(documentFor(indexId))).document!;
    await repository.upsertVector(vectorFor(indexId, first.id));
    const second = (await repository.upsertDocument(documentFor(indexId, {
      id: `${first.id}-b`, entityId: 'task-2',
    }))).document!;
    expect(second.entityId).toBe('task-2');

    const page = await repository.listDocuments({
      indexId, entityType: 'task', limit: 1,
    });
    expect(page.map((document) => document.entityId)).toEqual(['task-1']);
    expect(page[0].vector).toMatchObject({ documentVersion: 1, provider: 'openai' });

    const next = await repository.listDocuments({
      indexId, entityType: 'task', afterEntityId: 'task-1', limit: 10,
    });
    expect(next.map((document) => document.entityId)).toEqual(['task-2']);
    expect(next[0].vector).toBeNull();

    await repository.deleteDocument({
      indexId, entityType: 'task', entityId: 'task-2', now: T1,
    });
    expect(await repository.listDocuments({
      indexId, entityType: 'task', afterEntityId: 'task-1', limit: 10,
    })).toHaveLength(0);
    expect(await repository.listDocuments({
      indexId, entityType: 'task', afterEntityId: 'task-1', limit: 10, includeDeleted: true,
    })).toHaveLength(1);
  });

  it('enforces conditional vector writes against the current document version', async () => {
    const indexId = await createIdentity();
    const document = (await repository.upsertDocument(documentFor(indexId))).document!;

    expect(await repository.upsertVector(vectorFor(indexId, document.id)))
      .toEqual({ status: 'created' });

    await repository.upsertDocument(documentFor(indexId, {
      id: document.id, sourceRevision: 'rev-2', contentFingerprint: 'fp-2',
      sourceUpdatedAt: T1, now: T1,
    }));

    // A worker holding the old projection must not overwrite the new version.
    expect(await repository.upsertVector(vectorFor(indexId, document.id, {
      documentVersion: 1, sourceRevision: 'rev-1', sourceUpdatedAt: T1, now: T1,
    }))).toEqual({ status: 'stale', reason: 'document-superseded' });

    expect(await repository.upsertVector(vectorFor(indexId, document.id, {
      documentVersion: 2, sourceRevision: 'rev-2', contentFingerprint: 'fp-2',
      sourceUpdatedAt: T1, now: T1, embedding: new Float32Array([0, 1, 0]),
    }))).toEqual({ status: 'updated' });

    expect((await repository.getIdentity(indexId))?.vectorCount).toBe(1);
    const stored = await repository.getVector(indexId, 'task', 'task-1');
    expect(Array.from(stored!.embedding)).toEqual([0, 1, 0]);
    expect(stored?.norm).toBeCloseTo(1);
  });

  it('claims each queued intent exactly once under concurrent workers', async () => {
    const indexId = await createIdentity();
    for (let index = 0; index < 6; index++) {
      await repository.enqueueIntent(intentFor(indexId, {
        idempotencyKey: `${indexId}:upsert:task:task-${index}`,
        entityId: `task-${index}`,
        requestedAt: new Date(Date.parse(T0) + index * 1000).toISOString(),
      }));
    }

    const [a, b, c] = await Promise.all([
      repository.claimIntents({ indexId, owner: 'worker-a', limit: 3, leaseMs: 60_000, now: T1 }),
      repository.claimIntents({ indexId, owner: 'worker-b', limit: 3, leaseMs: 60_000, now: T1 }),
      repository.claimIntents({ indexId, owner: 'worker-c', limit: 3, leaseMs: 60_000, now: T1 }),
    ]);

    const claimedIds = [...a, ...b, ...c].map((intent) => intent.id);
    expect(claimedIds).toHaveLength(6);
    expect(new Set(claimedIds).size).toBe(6);
    expect([...a, ...b, ...c].every((intent) => intent.status === 'running')).toBe(true);
    expect([...a, ...b, ...c].every((intent) => intent.attempt === 1)).toBe(true);

    const metrics = await repository.getMetrics(indexId, T1);
    expect(metrics.intents).toMatchObject({ queued: 0, running: 6 });
  });

  it('coalesces newer work, ignores older work, and never mutates a running attempt', async () => {
    const indexId = await createIdentity();
    const first = await repository.enqueueIntent(intentFor(indexId));
    expect(first.status).toBe('enqueued');

    const coalesced = await repository.enqueueIntent(intentFor(indexId, {
      sourceRevision: 'rev-2', requestedAt: T1, now: T1,
    }));
    expect(coalesced).toMatchObject({ status: 'coalesced' });
    expect(coalesced.intent.id).toBe(first.intent.id);
    expect(coalesced.intent.sourceRevision).toBe('rev-2');

    const ignored = await repository.enqueueIntent(intentFor(indexId, {
      sourceRevision: 'rev-0', requestedAt: T0, now: T2,
    }));
    expect(ignored.status).toBe('ignored');
    expect(ignored.intent.sourceRevision).toBe('rev-2');

    await repository.claimIntents({ indexId, owner: 'w', limit: 5, leaseMs: 60_000, now: T1 });
    const superseded = await repository.enqueueIntent(intentFor(indexId, {
      sourceRevision: 'rev-3', requestedAt: T2, now: T2,
    }));
    expect(superseded.status).toBe('superseded');
    expect(superseded.intent.id).not.toBe(first.intent.id);
    expect((await repository.getIntent(first.intent.id))?.sourceRevision).toBe('rev-2');
  });

  it('retries, denies, and recovers expired intent leases', async () => {
    const indexId = await createIdentity();
    await repository.enqueueIntent(intentFor(indexId, {
      id: 'retryable', idempotencyKey: `${indexId}:retryable`, maxAttempts: 2,
    }));
    await repository.claimIntents({ indexId, owner: 'w', limit: 5, leaseMs: 60_000, now: T0 });

    expect(await repository.failIntent({
      id: 'retryable', owner: 'w', error: 'rate limited', now: T0, retryAfter: T1,
    })).toBe('queued');
    expect(await repository.getIntent('retryable')).toMatchObject({
      status: 'queued', attempt: 1, availableAt: T1, retryAfter: T1,
    });

    await repository.claimIntents({ indexId, owner: 'w', limit: 5, leaseMs: 1_000, now: T1 });
    expect(await repository.recoverExpiredIntentLeases(T2)).toMatchObject({ requeued: 0, expired: 1 });
    expect(await repository.getIntent('retryable')).toMatchObject({
      status: 'expired', outcome: 'attempts-exhausted', leaseOwner: null,
    });

    await repository.enqueueIntent(intentFor(indexId, {
      id: 'denied', idempotencyKey: `${indexId}:denied`, entityId: 'task-2',
    }));
    await repository.claimIntents({ indexId, owner: 'w', limit: 5, leaseMs: 60_000, now: T2 });
    expect(await repository.failIntent({
      id: 'denied', owner: 'w', error: 'sensitivity policy', now: T2, denied: true,
    })).toBe('denied');
  });

  it('resumes a run from its checkpoint after a lease expires', async () => {
    const indexId = await createIdentity();
    const created = await repository.createRun({
      id: `run-${randomUUID()}`,
      indexId,
      kind: 'backfill',
      idempotencyKey: `${indexId}:backfill`,
      now: T0,
    });
    expect(created.status).toBe('created');

    const again = await repository.createRun({
      id: `run-${randomUUID()}`,
      indexId,
      kind: 'backfill',
      idempotencyKey: `${indexId}:backfill`,
      now: T0,
    });
    expect(again).toMatchObject({ status: 'existing' });
    expect(again.run.id).toBe(created.run.id);

    const claimed = await repository.claimRun({ owner: 'w', leaseMs: 1_000, now: T0, indexId });
    expect(claimed?.id).toBe(created.run.id);
    await repository.checkpointRun({
      id: created.run.id, owner: 'w', now: T0, checkpoint: 'task:250', processedDelta: 250,
    });

    expect(await repository.recoverExpiredRunLeases(T1)).toMatchObject({ requeued: 1 });
    const resumed = await repository.claimRun({ owner: 'w2', leaseMs: 60_000, now: T2, indexId });
    expect(resumed).toMatchObject({
      // One abandoned lease was recovered, so exactly one attempt was spent —
      // the two claims themselves cost nothing.
      status: 'running', checkpoint: 'task:250', processedCount: 250, attempt: 1,
    });

    expect(await repository.completeRun({
      id: created.run.id, owner: 'w2', now: T2, checkpoint: 'task:end',
    })).toBe(true);
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'succeeded', checkpoint: 'task:end',
    });

    // A completed run keeps its key, so the once-per-identity backfill is not
    // queued again on the next maintenance tick.
    expect(await repository.createRun({
      id: `run-${randomUUID()}`,
      indexId,
      kind: 'backfill',
      idempotencyKey: `${indexId}:backfill`,
      now: T2,
    })).toMatchObject({ status: 'existing', run: { id: created.run.id } });
  });

  it('keeps a run claimable across many clean yields and re-schedules it after terminal failure', async () => {
    const indexId = await createIdentity();
    const key = `${indexId}:backfill`;
    const created = await repository.createRun({
      id: `run-${randomUUID()}`, indexId, kind: 'backfill', idempotencyKey: key,
      now: T0, maxAttempts: 3,
    });

    // Six clean yields against a budget of three: `attempt` counts failures, so
    // a long backfill never runs out of claims.
    for (let slice = 1; slice <= 6; slice++) {
      const claimed = await repository.claimRun({ owner: `w${slice}`, leaseMs: 60_000, now: T0, indexId });
      expect(claimed?.id, `slice ${slice}`).toBe(created.run.id);
      await repository.checkpointRun({
        id: created.run.id, owner: `w${slice}`, now: T0, checkpoint: `task:${slice}`, processedDelta: 10,
      });
      await repository.releaseRun({ id: created.run.id, owner: `w${slice}`, now: T0 });
    }
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'queued', attempt: 0, processedCount: 60, checkpoint: 'task:6',
    });

    // Spend the whole budget on real failures.
    for (const expected of ['queued', 'queued', 'failed'] as const) {
      const at = (await repository.getRun(created.run.id))!.availableAt;
      await repository.claimRun({ owner: 'w', leaseMs: 60_000, now: at, indexId });
      expect(await repository.failRun({
        id: created.run.id, owner: 'w', error: 'provider down', now: at, availableAt: at,
      })).toBe(expected);
    }
    expect(await repository.getRun(created.run.id)).toMatchObject({ status: 'failed', attempt: 3 });

    // The fixed key is schedulable again, resuming from the failed checkpoint,
    // and the terminal attempt is preserved under a superseded key.
    const replacement = await repository.createRun({
      id: `run-${randomUUID()}`, indexId, kind: 'backfill', idempotencyKey: key, now: T2,
    });
    expect(replacement).toMatchObject({
      status: 'created', run: { status: 'queued', attempt: 0, checkpoint: 'task:6' },
    });
    expect((await repository.claimRun({ owner: 'w9', leaseMs: 60_000, now: T2, indexId }))?.id)
      .toBe(replacement.run.id);
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'failed',
      idempotencyKey: supersededRunIdempotencyKey(key, created.run.id),
    });
  });

  it('cuts over, rolls back, and cleans up without ever deleting the active identity', async () => {
    const first = await createIdentity();
    const firstDocument = (await repository.upsertDocument(documentFor(first))).document!;
    await repository.upsertVector(vectorFor(first, firstDocument.id));
    await repository.markIdentityReady(first, T0);
    expect(await repository.activateIdentity(first, T0)).toMatchObject({ status: 'activated' });

    const second = await createIdentity();
    const secondDocument = (await repository.upsertDocument(documentFor(second))).document!;
    await repository.upsertVector(vectorFor(second, secondDocument.id));
    await repository.markIdentityReady(second, T1);

    expect(await repository.activateIdentity(second, T1)).toMatchObject({
      status: 'activated', activatedId: second, previousActiveId: first,
    });
    expect((await repository.getIdentity(first))?.status).toBe('ready');

    expect(await repository.rollbackToIdentity(first, T2)).toMatchObject({
      status: 'rolled-back', activatedId: first, previousActiveId: second,
    });
    expect((await repository.getActiveIdentity())?.id).toBe(first);

    // The active identity can neither be retired nor cleaned up.
    expect(await repository.retireIdentity(first, T2)).toBe(false);
    await repository.retireIdentity(second, T0);
    const cleanup = await repository.cleanupIdentities({ before: T1, now: T2 });
    expect(cleanup.identitiesRemoved).toBeGreaterThanOrEqual(1);
    expect(await repository.getIdentity(second)).toBeNull();
    expect((await repository.getActiveIdentity())?.id).toBe(first);
    identityIds.delete(second);
  });

  it('queries the active identity with deterministic ordering and bounded-scan metadata', async () => {
    const indexId = await createIdentity();
    const rows: Array<[string, 'task' | 'project', string, number[]]> = [
      ['b', 'task', 'Beta', [1, 0, 0]],
      ['a', 'task', 'alpha', [1, 0, 0]],
      ['p', 'project', 'Zeta', [1, 0, 0]],
      ['far', 'task', 'Far', [0, 0, 1]],
    ];
    for (const [entityId, entityType, title, embedding] of rows) {
      const document = (await repository.upsertDocument(documentFor(indexId, {
        entityType, entityId, title,
      }))).document!;
      await repository.upsertVector(vectorFor(indexId, document.id, {
        entityType, entityId, embedding: new Float32Array(embedding),
      }));
    }
    await repository.markIdentityReady(indexId, T0);
    await repository.activateIdentity(indexId, T0);

    const response = await repository.queryVectors({
      queryEmbedding: new Float32Array([1, 0, 0]), limit: 10, now: T1,
    });
    expect(response.identityId).toBe(indexId);
    expect(response.results.slice(0, 3).map((result) => result.entityId)).toEqual(['p', 'a', 'b']);
    expect(response.scan).toMatchObject({
      kind: 'bounded-in-process', guaranteesFullRecall: false, truncated: false,
    });

    const filtered = await repository.queryVectors({
      queryEmbedding: new Float32Array([1, 0, 0]),
      limit: 10,
      entityTypes: ['project'],
      now: T1,
    });
    expect(filtered.results.map((result) => result.entityId)).toEqual(['p']);
  });

  it('expires retained documents and removes their vector projections', async () => {
    const indexId = await createIdentity();
    const document = (await repository.upsertDocument(documentFor(indexId, {
      retainUntil: T1,
    }))).document!;
    await repository.upsertVector(vectorFor(indexId, document.id));

    expect(await repository.expireDocuments({ now: T2, indexId })).toEqual({
      documentsExpired: 1, vectorsRemoved: 1,
    });
    expect((await repository.getDocument(indexId, 'task', 'task-1'))?.deletedAt).toBe(T2);
    expect(await repository.getVector(indexId, 'task', 'task-1')).toBeNull();
    expect(await repository.getIdentity(indexId)).toMatchObject({
      documentCount: 0, vectorCount: 0,
    });

    expect(await repository.purgeDeletedDocuments({ before: '2026-08-30T00:00:00.000Z' })).toBe(1);
    expect(await repository.getDocument(indexId, 'task', 'task-1')).toBeNull();
  });
});
