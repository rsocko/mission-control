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

  async function createIdentity(overrides: {
    id?: string;
    status?: 'building' | 'ready';
  } = {}) {
    const id = overrides.id ?? `semantic-${randomUUID()}`;
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

  it('returns a bounded claim in deterministic FIFO order', async () => {
    const indexId = await createIdentity();
    for (const [id, requestedAt] of [
      ['newest', T2],
      ['oldest', T0],
      ['middle', T1],
    ] as const) {
      await repository.enqueueIntent(intentFor(indexId, {
        idempotencyKey: `${indexId}:upsert:task:${id}`,
        entityId: id,
        requestedAt,
      }));
    }

    const claimed = await repository.claimIntents({
      indexId, owner: 'fifo-worker', limit: 2, leaseMs: 60_000, now: T2,
    });

    expect(claimed.map((intent) => intent.entityId)).toEqual(['oldest', 'middle']);
  });

  it('round-trips arbitrary idempotency keys and coalesces concurrent publication', async () => {
    const indexId = await createIdentity();
    const keys = [
      `${indexId}\u0000\u0000`,
      `${indexId}\u0000task\u0000café-東京-🚀`,
      '\u0000',
      'mc-semantic-key:v1:AA',
      'mc-semantic-key:v1:',
      '\ud800',
    ];
    const intentIds: string[] = [];

    for (const [position, idempotencyKey] of keys.entries()) {
      const entityId = `key-shape-${position}`;
      const [left, right] = await Promise.all([
        repository.enqueueIntent(intentFor(indexId, { idempotencyKey, entityId })),
        repository.enqueueIntent(intentFor(indexId, { idempotencyKey, entityId })),
      ]);
      expect(new Set([left.status, right.status])).toEqual(new Set(['enqueued', 'coalesced']));
      expect(left.intent.id).toBe(right.intent.id);
      expect(left.intent.idempotencyKey).toBe(idempotencyKey);
      expect((await repository.getIntent(left.intent.id))?.idempotencyKey).toBe(idempotencyKey);
      intentIds.push(left.intent.id);
    }

    const stored = await backend.context.pool.query<{
      idempotency_key: string;
      idempotency_key_version: number;
    }>(
      `SELECT idempotency_key, idempotency_key_version
       FROM semantic_intents WHERE id = ANY($1::text[])`,
      [intentIds],
    );
    expect(stored.rows).toHaveLength(keys.length);
    expect(new Set(stored.rows.map((row) => row.idempotency_key)).size).toBe(keys.length);
    expect(stored.rows.every((row) => !row.idempotency_key.includes('\u0000'))).toBe(true);
    expect(stored.rows.every((row) => row.idempotency_key_version === 1)).toBe(true);
  });

  it('preserves canonical legacy prefix lookalikes without colliding with encoded keys', async () => {
    const indexId = await createIdentity();
    const logicalKey = `legacy-logical-${randomUUID()}`;
    const legacyLookalike =
      `mc-semantic-key:v1:${Buffer.from(logicalKey, 'utf16le').toString('base64url')}`;
    const legacyId = `legacy-intent-${randomUUID()}`;
    await backend.context.pool.query(
      `INSERT INTO semantic_intents (
         id, idempotency_key, index_id, kind, entity_type, entity_id,
         requested_at, status, attempt, max_attempts, available_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'upsert', 'task', 'legacy-entity',
         $4, 'queued', 0, 5, $4, $4, $4)`,
      [legacyId, legacyLookalike, indexId, T1],
    );

    const preserved = await repository.enqueueIntent(intentFor(indexId, {
      id: `ignored-${randomUUID()}`,
      idempotencyKey: legacyLookalike,
      entityId: 'legacy-entity',
      requestedAt: T0,
    }));
    expect(preserved).toMatchObject({
      status: 'ignored',
      intent: { id: legacyId, idempotencyKey: legacyLookalike },
    });

    const encoded = await repository.enqueueIntent(intentFor(indexId, {
      id: `encoded-${randomUUID()}`,
      idempotencyKey: logicalKey,
      entityId: 'encoded-entity',
    }));
    expect(encoded).toMatchObject({
      status: 'enqueued',
      intent: { idempotencyKey: logicalKey },
    });

    const rows = await backend.context.pool.query<{
      idempotency_key: string;
      idempotency_key_version: number;
    }>(
      `SELECT idempotency_key, idempotency_key_version
       FROM semantic_intents
       WHERE id = ANY($1::text[])
       ORDER BY idempotency_key_version`,
      [[legacyId, encoded.intent.id]],
    );
    expect(rows.rows).toEqual([
      { idempotency_key: legacyLookalike, idempotency_key_version: 0 },
      { idempotency_key: legacyLookalike, idempotency_key_version: 1 },
    ]);

    const runLogicalKey = `legacy-run-${randomUUID()}`;
    const runLegacyLookalike =
      `mc-semantic-key:v1:${Buffer.from(runLogicalKey, 'utf16le').toString('base64url')}`;
    const legacyRunId = `legacy-run-row-${randomUUID()}`;
    await backend.context.pool.query(
      `INSERT INTO semantic_runs (
         id, index_id, kind, idempotency_key, status, checkpoint,
         processed_count, failed_count, skipped_count, attempt, max_attempts,
         available_at, created_at, updated_at, completed_at
       ) VALUES ($1, $2, 'reconcile', $3, 'succeeded', NULL,
         0, 0, 0, 0, 3, $4, $4, $4, $4)`,
      [legacyRunId, indexId, runLegacyLookalike, T0],
    );
    const preservedRun = await repository.createRun({
      id: `ignored-run-${randomUUID()}`,
      indexId,
      kind: 'reconcile',
      idempotencyKey: runLegacyLookalike,
      now: T1,
    });
    expect(preservedRun).toMatchObject({
      status: 'existing',
      run: { id: legacyRunId, idempotencyKey: runLegacyLookalike },
    });
    const encodedRun = await repository.createRun({
      id: `encoded-run-${randomUUID()}`,
      indexId,
      kind: 'reconcile',
      idempotencyKey: runLogicalKey,
      now: T1,
    });
    expect(encodedRun).toMatchObject({
      status: 'created',
      run: { idempotencyKey: runLogicalKey },
    });
    const runRows = await backend.context.pool.query<{
      idempotency_key: string;
      idempotency_key_version: number;
    }>(
      `SELECT idempotency_key, idempotency_key_version
       FROM semantic_runs
       WHERE id = ANY($1::text[])
       ORDER BY idempotency_key_version`,
      [[legacyRunId, encodedRun.run.id]],
    );
    expect(runRows.rows).toEqual([
      { idempotency_key: runLegacyLookalike, idempotency_key_version: 0 },
      { idempotency_key: runLegacyLookalike, idempotency_key_version: 1 },
    ]);
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

  it('fences every stale same-owner intent mutation after recovery and reclaim', async () => {
    const indexId = await createIdentity();
    const document = (await repository.upsertDocument(documentFor(indexId))).document!;
    await repository.upsertVector(vectorFor(indexId, document.id));
    const created = await repository.enqueueIntent(intentFor(indexId, { maxAttempts: 4 }));
    await repository.claimIntents({
      indexId, owner: 'worker-a', limit: 1, leaseMs: 1_000, now: T0,
    });
    expect(await repository.recoverExpiredIntentLeases(T1))
      .toEqual({ requeued: 1, expired: 0 });
    const availableAt = (await repository.getIntent(created.intent.id))!.availableAt;
    expect(await repository.claimIntents({
      indexId,
      owner: 'worker-a',
      limit: 1,
      leaseMs: 60_000,
      now: availableAt,
    })).toMatchObject([{ attempt: 2, leaseOwner: 'worker-a' }]);

    expect(await repository.renewIntentLease({
      id: created.intent.id,
      owner: 'worker-a',
      attempt: 1,
      leaseMs: 60_000,
      now: availableAt,
    })).toBe(false);
    expect(await repository.completeIntent({
      id: created.intent.id, owner: 'worker-a', attempt: 1, now: availableAt,
    })).toBe(false);
    expect(await repository.failIntent({
      id: created.intent.id,
      owner: 'worker-a',
      attempt: 1,
      error: 'stale failure',
      now: availableAt,
    })).toBeNull();
    expect(await repository.upsertDocument(documentFor(indexId, {
      id: document.id,
      title: 'stale title',
      sourceRevision: 'rev-stale-worker',
      sourceUpdatedAt: T2,
      now: availableAt,
      leaseFence: { intentId: created.intent.id, owner: 'worker-a', attempt: 1 },
    }))).toEqual({ status: 'stale', document: null, reason: 'lease-lost' });
    expect(await repository.upsertVector(vectorFor(indexId, document.id, {
      embedding: new Float32Array([0, 1, 0]),
      now: availableAt,
      leaseFence: { intentId: created.intent.id, owner: 'worker-a', attempt: 1 },
    }))).toEqual({ status: 'stale', reason: 'lease-lost' });
    expect(await repository.deleteDocument({
      indexId,
      entityType: 'task',
      entityId: 'task-1',
      now: availableAt,
      leaseFence: { intentId: created.intent.id, owner: 'worker-a', attempt: 1 },
    })).toEqual({ status: 'lease-lost', removedVectors: 0 });
    expect(await repository.getDocument(indexId, 'task', 'task-1'))
      .toMatchObject({ title: 'Integration task', deletedAt: null });
    expect(await repository.getVector(indexId, 'task', 'task-1')).not.toBeNull();
    expect(await repository.completeIntent({
      id: created.intent.id, owner: 'worker-a', attempt: 2, now: availableAt,
    })).toBe(true);
  });

  it('rejects intent failure and settlement exactly at the lease expiry boundary', async () => {
    const indexId = await createIdentity();
    const expiresAt = '2026-08-29T00:01:00.000Z';
    const created = await repository.enqueueIntent(intentFor(indexId));
    await repository.claimIntents({
      indexId, owner: 'worker-a', limit: 1, leaseMs: 60_000, now: T0,
    });

    expect(await repository.failIntent({
      id: created.intent.id, owner: 'worker-a', attempt: 1, error: 'too late', now: expiresAt,
    })).toBeNull();
    expect(await repository.renewIntentLease({
      id: created.intent.id,
      owner: 'worker-a',
      attempt: 1,
      leaseMs: 60_000,
      now: expiresAt,
    })).toBe(false);
    expect(await repository.completeIntent({
      id: created.intent.id, owner: 'worker-a', attempt: 1, now: expiresAt,
    })).toBe(false);
    expect(await repository.getIntent(created.intent.id))
      .toMatchObject({ status: 'running', attempt: 1 });
  });

  it('retries, denies, and recovers expired intent leases', async () => {
    const indexId = await createIdentity();
    await repository.enqueueIntent(intentFor(indexId, {
      id: 'retryable', idempotencyKey: `${indexId}:retryable`, maxAttempts: 2,
    }));
    await repository.claimIntents({ indexId, owner: 'w', limit: 5, leaseMs: 60_000, now: T0 });

    expect(await repository.failIntent({
      id: 'retryable', owner: 'w', attempt: 1, error: 'rate limited', now: T0, retryAfter: T1,
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
      id: 'denied', owner: 'w', attempt: 1, error: 'sensitivity policy', now: T2, denied: true,
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
      id: created.run.id,
      owner: 'w',
      attempt: 0,
      now: T0,
      checkpoint: 'task:250',
      processedDelta: 250,
    });

    expect(await repository.recoverExpiredRunLeases(T1)).toMatchObject({ requeued: 1 });
    const resumed = await repository.claimRun({ owner: 'w', leaseMs: 60_000, now: T2, indexId });
    expect(resumed).toMatchObject({
      // One abandoned lease was recovered, so exactly one attempt was spent —
      // the two claims themselves cost nothing.
      status: 'running', checkpoint: 'task:250', processedCount: 250, attempt: 1,
    });
    expect(await repository.checkpointRun({
      id: created.run.id,
      owner: 'w',
      attempt: 0,
      now: T2,
      checkpoint: 'stale-overwrite',
      processedDelta: 99,
    })).toBe(false);
    expect(await repository.renewRunLease({
      id: created.run.id, owner: 'w', attempt: 0, leaseMs: 60_000, now: T2,
    })).toBe(false);
    expect(await repository.failRun({
      id: created.run.id, owner: 'w', attempt: 0, error: 'stale failure', now: T2,
    })).toBeNull();
    expect(await repository.completeRun({
      id: created.run.id, owner: 'w', attempt: 0, now: T2,
    })).toBe(false);
    expect(await repository.releaseRun({
      id: created.run.id, owner: 'w', attempt: 0, now: T2,
    })).toBe(false);

    expect(await repository.completeRun({
      id: created.run.id, owner: 'w', attempt: 1, now: T2, checkpoint: 'task:end',
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

  it('allows only one concurrent running claim per identity and run kind', async () => {
    const indexId = await createIdentity();
    await Promise.all([
      repository.createRun({
        id: `run-a-${indexId}`,
        indexId,
        kind: 'reconcile',
        idempotencyKey: `${indexId}:reconcile:first`,
        now: T0,
      }),
      repository.createRun({
        id: `run-b-${indexId}`,
        indexId,
        kind: 'reconcile',
        idempotencyKey: `${indexId}:reconcile:second`,
        now: T0,
      }),
    ]);

    const claims = await Promise.all([
      repository.claimRun({
        owner: 'run-worker-a', leaseMs: 600_000, now: T0, indexId, kinds: ['reconcile'],
      }),
      repository.claimRun({
        owner: 'run-worker-b', leaseMs: 600_000, now: T0, indexId, kinds: ['reconcile'],
      }),
    ]);
    const active = claims.filter((run) => run !== null);
    expect(active).toHaveLength(1);
    const claimedRun = active[0];
    if (!claimedRun?.leaseOwner) throw new Error('Expected one leased reconcile run');
    expect(claimedRun.id).toBe(`run-a-${indexId}`);

    const otherIndexId = await createIdentity();
    await Promise.all([
      repository.createRun({
        id: `run-other-${otherIndexId}`,
        indexId: otherIndexId,
        kind: 'reconcile',
        idempotencyKey: `${otherIndexId}:reconcile`,
        now: T0,
      }),
      repository.createRun({
        id: `run-cleanup-${indexId}`,
        indexId,
        kind: 'cleanup',
        idempotencyKey: `${indexId}:cleanup`,
        now: T0,
      }),
    ]);
    const independent = await Promise.all([
      repository.claimRun({
        owner: 'run-worker-other',
        leaseMs: 600_000,
        now: T0,
        indexId: otherIndexId,
        kinds: ['reconcile'],
      }),
      repository.claimRun({
        owner: 'run-worker-cleanup',
        leaseMs: 600_000,
        now: T0,
        indexId,
        kinds: ['cleanup'],
      }),
    ]);
    expect(independent).toMatchObject([
      { id: `run-other-${otherIndexId}` },
      { id: `run-cleanup-${indexId}` },
    ]);

    expect(await repository.releaseRun({
      id: claimedRun.id,
      owner: claimedRun.leaseOwner,
      attempt: claimedRun.attempt,
      now: T0,
      availableAt: T2,
    })).toBe(true);
    expect(await repository.claimRun({
      owner: 'run-worker-c', leaseMs: 600_000, now: T0, indexId, kinds: ['reconcile'],
    })).toMatchObject({ id: `run-b-${indexId}` });
  });

  it('serializes advisory-hash collisions without coalescing unrelated runs', async () => {
    const collision = await backend.context.pool.query<{ identities: string[] }>(`
      WITH candidates AS (
        SELECT
          'semantic-collision-' || value::text AS identity,
          hashtext(
            'mission-control-semantic-run:'
            || 'semantic-collision-'
            || value::text
          ) AS lock_key
        FROM generate_series(1, 500000) AS value
      )
      SELECT array_agg(identity ORDER BY identity) AS identities
      FROM candidates
      GROUP BY lock_key
      HAVING COUNT(*) > 1
      LIMIT 1
    `);
    const [firstId, secondId] = collision.rows[0]?.identities ?? [];
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    if (!firstId || !secondId) throw new Error('Expected a deterministic advisory hash collision');

    await Promise.all([
      createIdentity({ id: firstId }),
      createIdentity({ id: secondId }),
    ]);
    await Promise.all([
      repository.createRun({
        id: `run-${firstId}`,
        indexId: firstId,
        kind: 'cleanup',
        idempotencyKey: `${firstId}:cleanup`,
        now: T0,
      }),
      repository.createRun({
        id: `run-${secondId}`,
        indexId: secondId,
        kind: 'cleanup',
        idempotencyKey: `${secondId}:cleanup`,
        now: T0,
      }),
    ]);

    const claims = await Promise.all([
      repository.claimRun({
        owner: 'collision-worker-a',
        leaseMs: 60_000,
        now: T0,
        indexId: firstId,
        kinds: ['cleanup'],
      }),
      repository.claimRun({
        owner: 'collision-worker-b',
        leaseMs: 60_000,
        now: T0,
        indexId: secondId,
        kinds: ['cleanup'],
      }),
    ]);
    expect(claims).toMatchObject([
      { id: `run-${firstId}`, indexId: firstId },
      { id: `run-${secondId}`, indexId: secondId },
    ]);
  }, 120_000);

  it('releases the run coalescing lock when a claim transaction rolls back', async () => {
    const indexId = await createIdentity();
    const probeName = `semantic_claim_rollback_probe_${process.pid}_${Date.now()}`;
    if (!/^semantic_claim_rollback_probe_\d+_\d+$/.test(probeName)) {
      throw new Error('Generated semantic rollback probe name is unsafe');
    }
    const created = await repository.createRun({
      id: `run-${randomUUID()}`,
      indexId,
      kind: 'cleanup',
      idempotencyKey: `${indexId}:cleanup:rollback`,
      now: T0,
    });

    try {
      await backend.context.pool.query(`
        CREATE FUNCTION "${probeName}"()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.lease_owner = 'rollback-worker' THEN
            RAISE EXCEPTION 'forced semantic claim rollback';
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await backend.context.pool.query(`
        CREATE TRIGGER "${probeName}"
        BEFORE UPDATE ON semantic_runs
        FOR EACH ROW EXECUTE FUNCTION "${probeName}"()
      `);
      await expect(repository.claimRun({
        owner: 'rollback-worker',
        leaseMs: 60_000,
        now: T0,
        indexId,
        kinds: ['cleanup'],
      })).rejects.toThrow('forced semantic claim rollback');
    } finally {
      await backend.context.pool.query(
        `DROP TRIGGER IF EXISTS "${probeName}" ON semantic_runs`,
      );
      await backend.context.pool.query(
        `DROP FUNCTION IF EXISTS "${probeName}"()`,
      );
    }

    expect(await repository.claimRun({
      owner: 'recovery-worker',
      leaseMs: 60_000,
      now: T0,
      indexId,
      kinds: ['cleanup'],
    })).toMatchObject({ id: created.run.id, leaseOwner: 'recovery-worker' });
  });

  it('rejects run failure and settlement exactly at the lease expiry boundary', async () => {
    const indexId = await createIdentity();
    const expiresAt = '2026-08-29T00:01:00.000Z';
    const created = await repository.createRun({
      id: `run-${randomUUID()}`,
      indexId,
      kind: 'backfill',
      idempotencyKey: `${indexId}:expiry-boundary`,
      now: T0,
    });
    await repository.claimRun({ owner: 'w', leaseMs: 60_000, now: T0, indexId });

    expect(await repository.failRun({
      id: created.run.id, owner: 'w', attempt: 0, error: 'too late', now: expiresAt,
    })).toBeNull();
    expect(await repository.renewRunLease({
      id: created.run.id, owner: 'w', attempt: 0, leaseMs: 60_000, now: expiresAt,
    })).toBe(false);
    expect(await repository.checkpointRun({
      id: created.run.id, owner: 'w', attempt: 0, checkpoint: 'too-late', now: expiresAt,
    })).toBe(false);
    expect(await repository.completeRun({
      id: created.run.id, owner: 'w', attempt: 0, now: expiresAt,
    })).toBe(false);
    expect(await repository.releaseRun({
      id: created.run.id, owner: 'w', attempt: 0, now: expiresAt,
    })).toBe(false);
    expect(await repository.getRun(created.run.id))
      .toMatchObject({ status: 'running', attempt: 0 });
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
        id: created.run.id,
        owner: `w${slice}`,
        attempt: 0,
        now: T0,
        checkpoint: `task:${slice}`,
        processedDelta: 10,
      });
      await repository.releaseRun({
        id: created.run.id, owner: `w${slice}`, attempt: 0, now: T0,
      });
    }
    expect(await repository.getRun(created.run.id)).toMatchObject({
      status: 'queued', attempt: 0, processedCount: 60, checkpoint: 'task:6',
    });

    // Spend the whole budget on real failures.
    for (const [attempt, expected] of (['queued', 'queued', 'failed'] as const).entries()) {
      const at = (await repository.getRun(created.run.id))!.availableAt;
      await repository.claimRun({ owner: 'w', leaseMs: 60_000, now: at, indexId });
      expect(await repository.failRun({
        id: created.run.id,
        owner: 'w',
        attempt,
        error: 'provider down',
        now: at,
        availableAt: at,
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

  it('uses identity-scoped HNSW retrieval when pgvector is available', async () => {
    if (!backend.context.vector.available) {
      expect(backend.context.vector.reason).toBe('extension-unavailable');
      return;
    }
    const indexed = new PostgresSemanticIndexRepository(
      backend.context.pool,
      100,
      backend.context.vector,
    );
    const indexId = `semantic-${randomUUID()}`;
    identityIds.add(indexId);
    await indexed.createIdentity({
      id: indexId,
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 3,
      projectionVersion: 1,
      now: T0,
    });
    for (const [entityId, status, embedding] of [
      ['allowed-near', 'todo', [1, 0, 0]],
      ['excluded-near', 'done', [0.99, 0.01, 0]],
      ['allowed-far', 'todo', [0, 0, 1]],
    ] as const) {
      const document = (await indexed.upsertDocument(documentFor(indexId, {
        id: `doc-${entityId}`,
        entityId,
        title: entityId,
        metadata: { status },
      }))).document!;
      await indexed.upsertVector(vectorFor(indexId, document.id, {
        id: `vec-${entityId}`,
        entityId,
        embedding: new Float32Array(embedding),
      }));
    }
    await indexed.markIdentityReady(indexId, T0);
    await indexed.activateIdentity(indexId, T0);

    const response = await indexed.queryVectors({
      queryEmbedding: new Float32Array([1, 0, 0]),
      limit: 10,
      metadataFilters: [{ keys: ['status'], match: 'any', values: ['todo'] }],
      now: T1,
    });
    expect(response.scan).toMatchObject({
      kind: 'postgres-hnsw',
      extensionVersion: backend.context.vector.extensionVersion,
      guaranteedScale: 100_000,
    });
    expect(response.results.map((result) => result.entityId)).toEqual([
      'allowed-near',
      'allowed-far',
    ]);

    expect(await indexed.deleteVector(indexId, 'task', 'allowed-near')).toBe(true);
    expect((await indexed.queryVectors({
      queryEmbedding: new Float32Array([1, 0, 0]),
      limit: 10,
      now: T1,
    })).results.map((result) => result.entityId)).not.toContain('allowed-near');
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
