import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSemanticIndexRepository } from '@/lib/semantic-index/sqlite-repository';
import {
  addMs,
  computeSemanticRetryAt,
  supersededRunIdempotencyKey,
} from '@/lib/semantic-index/validation';
import {
  SemanticIndexValidationError,
  type SemanticDocumentWrite,
  type SemanticIntentEnqueue,
  type SemanticMetadataFilter,
  type SemanticVectorWrite,
} from '@/lib/semantic-index/contracts';

const MIGRATION = readFileSync(
  resolve(process.cwd(), 'drizzle', '0121_semantic_index.sql'),
  'utf8',
);

const T0 = '2026-08-29T00:00:00.000Z';
const T1 = '2026-08-29T01:00:00.000Z';
const T2 = '2026-08-29T02:00:00.000Z';

function makeDocument(overrides: Partial<SemanticDocumentWrite> = {}): SemanticDocumentWrite {
  return {
    id: 'doc-1',
    indexId: 'idx-1',
    entityType: 'task',
    entityId: 'task-1',
    title: 'Ship the semantic index',
    body: 'Persist versioned documents and vectors.',
    keywords: ['semantic', 'index'],
    metadata: { status: 'todo', priority: 1 },
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

function makeVector(overrides: Partial<SemanticVectorWrite> = {}): SemanticVectorWrite {
  return {
    id: 'vec-1',
    indexId: 'idx-1',
    documentId: 'doc-1',
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
    indexRunId: 'run-1',
    intentId: 'intent-1',
    expiresAt: null,
    now: T0,
    ...overrides,
  };
}

function makeIntent(overrides: Partial<SemanticIntentEnqueue> = {}): SemanticIntentEnqueue {
  return {
    id: 'intent-1',
    idempotencyKey: 'idx-1:upsert:task:task-1',
    indexId: 'idx-1',
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

describe('SqliteSemanticIndexRepository', () => {
  let db: Database.Database;
  let repo: SqliteSemanticIndexRepository;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const statement of MIGRATION.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement);
    }
    repo = new SqliteSemanticIndexRepository(db, 100);
    await repo.createIdentity({
      id: 'idx-1',
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 3,
      projectionVersion: 1,
      now: T0,
    });
  });

  afterEach(() => {
    db.close();
  });

  async function seedIndexedTask(overrides: {
    document?: Partial<SemanticDocumentWrite>;
    vector?: Partial<SemanticVectorWrite>;
  } = {}) {
    const document = await repo.upsertDocument(makeDocument(overrides.document));
    await repo.upsertVector(makeVector({
      documentId: document.document!.id,
      documentVersion: document.document!.version,
      ...overrides.vector,
    }));
    return document.document!;
  }

  // ─── Identity lifecycle ─────────────────────────────────────────────

  describe('identity lifecycle', () => {
    it('creates identities in building state with zero counts', async () => {
      const identity = await repo.getIdentity('idx-1');
      expect(identity).toMatchObject({
        status: 'building',
        documentCount: 0,
        vectorCount: 0,
        readyAt: null,
        activatedAt: null,
      });
    });

    it('rejects non-positive dimensions and projection versions', async () => {
      await expect(repo.createIdentity({
        id: 'bad', provider: 'p', model: 'm', dimensions: 0, projectionVersion: 1, now: T0,
      })).rejects.toBeInstanceOf(SemanticIndexValidationError);
      await expect(repo.createIdentity({
        id: 'bad', provider: 'p', model: 'm', dimensions: 3, projectionVersion: 0, now: T0,
      })).rejects.toBeInstanceOf(SemanticIndexValidationError);
    });

    it('promotes building to ready and allows several ready identities at once', async () => {
      await repo.createIdentity({
        id: 'idx-2', provider: 'openai', model: 'text-embedding-3-small',
        dimensions: 3, projectionVersion: 1, now: T0,
      });
      expect(await repo.markIdentityReady('idx-1', T1)).toBe(true);
      expect(await repo.markIdentityReady('idx-2', T1)).toBe(true);
      // Not building any more — a second promotion is a no-op, not an error.
      expect(await repo.markIdentityReady('idx-1', T2)).toBe(false);

      const ready = await repo.listIdentities('ready');
      expect(ready.map((identity) => identity.id).sort()).toEqual(['idx-1', 'idx-2']);
      expect(await repo.getActiveIdentity()).toBeNull();
    });

    it('cuts over only from ready and only when the readiness gate passes', async () => {
      await seedIndexedTask();

      const beforeReady = await repo.activateIdentity('idx-1', T1);
      expect(beforeReady).toMatchObject({ status: 'rejected', reason: 'identity-not-ready' });

      await repo.markIdentityReady('idx-1', T1);
      const activated = await repo.activateIdentity('idx-1', T1);
      expect(activated).toMatchObject({ status: 'activated', activatedId: 'idx-1', previousActiveId: null });
      expect((await repo.getActiveIdentity())?.id).toBe('idx-1');
    });

    it('rejects cutover when the identity holds no vectors', async () => {
      await repo.markIdentityReady('idx-1', T1);
      expect(await repo.activateIdentity('idx-1', T1)).toMatchObject({
        status: 'rejected',
        reason: 'gate-vector-count',
      });
    });

    it('rejects cutover when documents are still missing a current vector', async () => {
      await seedIndexedTask();
      // A second document with no vector leaves the identity stale.
      await repo.upsertDocument(makeDocument({
        id: 'doc-2', entityId: 'task-2', sourceRevision: 'rev-2', contentFingerprint: 'fp-2',
      }));
      await repo.markIdentityReady('idx-1', T1);

      expect(await repo.activateIdentity('idx-1', T1)).toMatchObject({
        status: 'rejected',
        reason: 'gate-stale-documents',
      });
      // An explicit tolerance lets an operator accept a known gap.
      expect(await repo.activateIdentity('idx-1', T1, { maxStaleDocuments: 1 })).toMatchObject({
        status: 'activated',
      });
    });

    it('keeps the former active identity ready so rollback has a target', async () => {
      await seedIndexedTask();
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);

      await repo.createIdentity({
        id: 'idx-2', provider: 'openai', model: 'text-embedding-3-small',
        dimensions: 3, projectionVersion: 1, now: T1,
      });
      await repo.upsertDocument(makeDocument({ id: 'doc-2', indexId: 'idx-2', now: T1 }));
      await repo.upsertVector(makeVector({ id: 'vec-2', indexId: 'idx-2', documentId: 'doc-2', now: T1 }));
      await repo.markIdentityReady('idx-2', T1);

      const cutover = await repo.activateIdentity('idx-2', T2);
      expect(cutover).toMatchObject({
        status: 'activated', activatedId: 'idx-2', previousActiveId: 'idx-1',
      });
      expect((await repo.getIdentity('idx-1'))?.status).toBe('ready');
      expect((await repo.getActiveIdentity())?.id).toBe('idx-2');
    });

    it('rolls back by activating the specified prior ready identity', async () => {
      await seedIndexedTask();
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);

      await repo.createIdentity({
        id: 'idx-2', provider: 'openai', model: 'text-embedding-3-small',
        dimensions: 3, projectionVersion: 1, now: T1,
      });
      await repo.upsertDocument(makeDocument({ id: 'doc-2', indexId: 'idx-2', now: T1 }));
      await repo.upsertVector(makeVector({ id: 'vec-2', indexId: 'idx-2', documentId: 'doc-2', now: T1 }));
      await repo.markIdentityReady('idx-2', T1);
      await repo.activateIdentity('idx-2', T2);

      const rollback = await repo.rollbackToIdentity('idx-1', T2);
      expect(rollback).toMatchObject({
        status: 'rolled-back', activatedId: 'idx-1', previousActiveId: 'idx-2',
      });
      // Rollback activates a prior identity; it does not merely retire the build.
      expect((await repo.getActiveIdentity())?.id).toBe('idx-1');
      expect((await repo.getIdentity('idx-2'))?.status).toBe('ready');
    });

    it('refuses to roll back to an empty or incompatible identity', async () => {
      await seedIndexedTask();
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);

      await repo.createIdentity({
        id: 'idx-empty', provider: 'openai', model: 'text-embedding-3-small',
        dimensions: 3, projectionVersion: 1, now: T1,
      });
      await repo.markIdentityReady('idx-empty', T1);

      expect(await repo.rollbackToIdentity('idx-empty', T2)).toMatchObject({
        status: 'rejected', reason: 'incompatible-identity',
      });
      expect(await repo.rollbackToIdentity('idx-1', T2)).toMatchObject({
        status: 'rejected', reason: 'already-active',
      });
      expect(await repo.rollbackToIdentity('nope', T2)).toMatchObject({
        status: 'rejected', reason: 'identity-not-found',
      });
      expect((await repo.getActiveIdentity())?.id).toBe('idx-1');
    });

    it('never retires or fails the active identity', async () => {
      await seedIndexedTask();
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);

      expect(await repo.retireIdentity('idx-1', T2)).toBe(false);
      expect(await repo.markIdentityFailed('idx-1', 'boom', T2)).toBe(false);
      expect((await repo.getActiveIdentity())?.id).toBe('idx-1');
    });

    it('cleans up only retired and failed identities, cascading their rows', async () => {
      await seedIndexedTask();
      await repo.enqueueIntent(makeIntent());
      await repo.createRun({
        id: 'run-1', indexId: 'idx-1', kind: 'backfill', idempotencyKey: 'run-key', now: T0,
      });
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);

      await repo.createIdentity({
        id: 'idx-retired', provider: 'openai', model: 'text-embedding-3-small',
        dimensions: 3, projectionVersion: 1, now: T0,
      });
      await repo.upsertDocument(makeDocument({ id: 'doc-r', indexId: 'idx-retired' }));
      await repo.retireIdentity('idx-retired', T0);

      await repo.createIdentity({
        id: 'idx-recent', provider: 'openai', model: 'text-embedding-3-small',
        dimensions: 3, projectionVersion: 1, now: T2,
      });
      await repo.retireIdentity('idx-recent', T2);

      const cleanup = await repo.cleanupIdentities({ before: T1, now: T2 });
      expect(cleanup.identitiesRemoved).toBe(1);
      expect(cleanup.documentsRemoved).toBe(1);
      expect(cleanup.skippedIds).toEqual(['idx-recent']);

      expect(await repo.getIdentity('idx-retired')).toBeNull();
      expect(await repo.getIdentity('idx-recent')).not.toBeNull();
      // The active identity and all of its rows are untouched.
      expect((await repo.getActiveIdentity())?.id).toBe('idx-1');
      expect(await repo.getDocument('idx-1', 'task', 'task-1')).not.toBeNull();
      expect(await repo.getVector('idx-1', 'task', 'task-1')).not.toBeNull();
      expect(await repo.getRun('run-1')).not.toBeNull();
    });
  });

  // ─── Documents ──────────────────────────────────────────────────────

  describe('versioned documents', () => {
    it('persists documents independently of any vector', async () => {
      const result = await repo.upsertDocument(makeDocument());
      expect(result.status).toBe('created');
      expect(result.document).toMatchObject({
        version: 1,
        title: 'Ship the semantic index',
        keywords: ['semantic', 'index'],
        metadata: { status: 'todo', priority: 1 },
        sourceRevision: 'rev-1',
        contentFingerprint: 'fp-1',
        sensitivity: 'standard',
        retainUntil: null,
        deletedAt: null,
      });
      expect((await repo.getIdentity('idx-1'))?.documentCount).toBe(1);
      expect((await repo.getIdentity('idx-1'))?.vectorCount).toBe(0);
    });

    it('increments the version on every content change and reports unchanged writes', async () => {
      await repo.upsertDocument(makeDocument());
      const unchanged = await repo.upsertDocument(makeDocument());
      expect(unchanged.status).toBe('unchanged');
      expect(unchanged.document?.version).toBe(1);

      const updated = await repo.upsertDocument(makeDocument({
        title: 'Renamed', sourceRevision: 'rev-2', contentFingerprint: 'fp-2',
        sourceUpdatedAt: T1, now: T1,
      }));
      expect(updated.status).toBe('updated');
      expect(updated.document?.version).toBe(2);
      expect((await repo.getIdentity('idx-1'))?.documentCount).toBe(1);
    });

    it('compares metadata canonically so a re-ordered rewrite is not a new version', async () => {
      const created = await repo.upsertDocument(makeDocument({
        metadata: { connectorType: 'github-issues', priority: 1, status: 'todo' },
      }));
      expect(created.status).toBe('created');

      // Same document, keys supplied in a different order. Bumping the version
      // here would mark the entity's vector stale and pay for a re-embedding.
      const rewritten = await repo.upsertDocument(makeDocument({
        metadata: { status: 'todo', priority: 1, connectorType: 'github-issues' },
      }));
      expect(rewritten).toMatchObject({ status: 'unchanged', document: { version: 1 } });

      // A genuine metadata change is still a change.
      const changed = await repo.upsertDocument(makeDocument({
        metadata: { status: 'done', priority: 1, connectorType: 'github-issues' },
      }));
      expect(changed).toMatchObject({ status: 'updated', document: { version: 2 } });
    });

    it('refuses an older source update so delayed work cannot overwrite newer content', async () => {
      await repo.upsertDocument(makeDocument({ sourceUpdatedAt: T1, sourceRevision: 'rev-2', now: T1 }));
      const stale = await repo.upsertDocument(makeDocument({
        sourceUpdatedAt: T0, sourceRevision: 'rev-1', contentFingerprint: 'fp-0', now: T2,
      }));
      expect(stale).toMatchObject({ status: 'stale', reason: 'older-source-update' });
      expect(stale.document?.sourceRevision).toBe('rev-2');
    });

    it('rejects documents whose projection version disagrees with the identity', async () => {
      await expect(repo.upsertDocument(makeDocument({ projectionVersion: 2 })))
        .rejects.toMatchObject({ code: 'projection-version-mismatch' });
    });

    it('rejects unknown entity kinds and sensitivities', async () => {
      await expect(repo.upsertDocument(makeDocument({
        entityType: 'nope' as never,
      }))).rejects.toMatchObject({ code: 'unknown-entity-type' });
      await expect(repo.upsertDocument(makeDocument({
        sensitivity: 'secret' as never,
      }))).rejects.toMatchObject({ code: 'unknown-sensitivity' });
    });

    it('accepts every architecture-supported entity kind', async () => {
      const kinds = ['task', 'project', 'tag', 'triage-item', 'alert', 'houston-summary'] as const;
      for (const [index, entityType] of kinds.entries()) {
        const result = await repo.upsertDocument(makeDocument({
          id: `doc-${index}`, entityType, entityId: `${entityType}-1`,
        }));
        expect(result.status, entityType).toBe('created');
      }
      expect((await repo.getIdentity('idx-1'))?.documentCount).toBe(kinds.length);
    });

    it('refuses writes to retired identities', async () => {
      await repo.retireIdentity('idx-1', T1);
      await expect(repo.upsertDocument(makeDocument()))
        .rejects.toMatchObject({ code: 'identity-not-writable' });
    });

    it('tombstones a deleted document and removes its vector projection', async () => {
      await seedIndexedTask();
      const deleted = await repo.deleteDocument({
        indexId: 'idx-1', entityType: 'task', entityId: 'task-1', now: T1,
      });
      expect(deleted).toEqual({ status: 'deleted', removedVectors: 1 });
      expect((await repo.getDocument('idx-1', 'task', 'task-1'))?.deletedAt).toBe(T1);
      expect(await repo.getVector('idx-1', 'task', 'task-1')).toBeNull();

      const identity = await repo.getIdentity('idx-1');
      expect(identity).toMatchObject({ documentCount: 0, vectorCount: 0 });

      expect(await repo.deleteDocument({
        indexId: 'idx-1', entityType: 'task', entityId: 'task-1', now: T2,
      })).toEqual({ status: 'already-deleted', removedVectors: 0 });
      expect(await repo.deleteDocument({
        indexId: 'idx-1', entityType: 'task', entityId: 'absent', now: T2,
      })).toEqual({ status: 'missing', removedVectors: 0 });
    });

    it('resurrects a tombstoned document without double-counting', async () => {
      await seedIndexedTask();
      await repo.deleteDocument({ indexId: 'idx-1', entityType: 'task', entityId: 'task-1', now: T1 });
      const revived = await repo.upsertDocument(makeDocument({
        sourceRevision: 'rev-2', contentFingerprint: 'fp-2', sourceUpdatedAt: T2, now: T2,
      }));
      expect(revived.status).toBe('updated');
      expect(revived.document?.deletedAt).toBeNull();
      expect((await repo.getIdentity('idx-1'))?.documentCount).toBe(1);
    });

    it('does not let delayed work resurrect a document the domain deleted', async () => {
      await seedIndexedTask();
      // The delete happens at T1; a worker still holding the T0 projection
      // must not bring the entity back.
      await repo.deleteDocument({ indexId: 'idx-1', entityType: 'task', entityId: 'task-1', now: T1 });
      const stale = await repo.upsertDocument(makeDocument({ sourceUpdatedAt: T0, now: T2 }));
      expect(stale).toMatchObject({ status: 'stale', reason: 'older-source-update' });
      expect((await repo.getDocument('idx-1', 'task', 'task-1'))?.deletedAt).toBe(T1);
      expect((await repo.getIdentity('idx-1'))?.documentCount).toBe(0);
    });

    it('expires documents past retainUntil and purges the tombstones later', async () => {
      await seedIndexedTask({ document: { retainUntil: T1 } });
      await repo.upsertDocument(makeDocument({
        id: 'doc-keep', entityId: 'task-keep', retainUntil: null,
      }));

      const expired = await repo.expireDocuments({ now: T2 });
      expect(expired).toEqual({ documentsExpired: 1, vectorsRemoved: 1 });
      expect((await repo.getDocument('idx-1', 'task', 'task-1'))?.deletedAt).toBe(T2);
      expect((await repo.getIdentity('idx-1'))).toMatchObject({ documentCount: 1, vectorCount: 0 });

      expect(await repo.purgeDeletedDocuments({ before: T1 })).toBe(0);
      expect(await repo.purgeDeletedDocuments({ before: '2026-08-30T00:00:00.000Z' })).toBe(1);
      expect(await repo.getDocument('idx-1', 'task', 'task-1')).toBeNull();
    });
  });

  // ─── Bounded document listing ───────────────────────────────────────

  describe('listDocuments', () => {
    async function seedDocuments(count: number) {
      for (let index = 1; index <= count; index++) {
        const id = `task-${String(index).padStart(2, '0')}`;
        await repo.upsertDocument(makeDocument({ id: `doc-${id}`, entityId: id }));
      }
    }

    it('pages by an exclusive entity-id cursor in ascending order', async () => {
      await seedDocuments(5);

      const first = await repo.listDocuments({
        indexId: 'idx-1', entityType: 'task', limit: 2,
      });
      expect(first.map((document) => document.entityId)).toEqual(['task-01', 'task-02']);

      const second = await repo.listDocuments({
        indexId: 'idx-1', entityType: 'task', afterEntityId: 'task-02', limit: 2,
      });
      expect(second.map((document) => document.entityId)).toEqual(['task-03', 'task-04']);
    });

    it('joins the current vector state without returning the embedding payload', async () => {
      const document = await seedIndexedTask();
      const [summary] = await repo.listDocuments({
        indexId: 'idx-1', entityType: 'task', limit: 10,
      });
      expect(summary).toMatchObject({
        entityId: 'task-1',
        version: document.version,
        sourceRevision: 'rev-1',
        contentFingerprint: 'fp-1',
      });
      expect(summary.vector).toMatchObject({
        documentVersion: document.version,
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 3,
        sourceRevision: 'rev-1',
      });
      expect(summary.vector).not.toHaveProperty('embedding');
    });

    it('reports a document with no vector as null rather than omitting it', async () => {
      await repo.upsertDocument(makeDocument());
      const [summary] = await repo.listDocuments({
        indexId: 'idx-1', entityType: 'task', limit: 10,
      });
      expect(summary.vector).toBeNull();
    });

    it('hides tombstones unless they are explicitly requested', async () => {
      await seedIndexedTask();
      await repo.deleteDocument({
        indexId: 'idx-1', entityType: 'task', entityId: 'task-1', now: T1,
      });

      expect(await repo.listDocuments({
        indexId: 'idx-1', entityType: 'task', limit: 10,
      })).toHaveLength(0);

      const withDeleted = await repo.listDocuments({
        indexId: 'idx-1', entityType: 'task', limit: 10, includeDeleted: true,
      });
      expect(withDeleted).toHaveLength(1);
      expect(withDeleted[0].deletedAt).toBe(T1);
      expect(withDeleted[0].vector).toBeNull();
    });

    it('scopes results to one identity and one entity kind', async () => {
      await repo.createIdentity({
        id: 'idx-2',
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 3,
        projectionVersion: 1,
        now: T0,
      });
      await repo.upsertDocument(makeDocument());
      await repo.upsertDocument(makeDocument({
        id: 'doc-alert', entityType: 'alert', entityId: 'alert-1',
      }));
      await repo.upsertDocument(makeDocument({ id: 'doc-other', indexId: 'idx-2' }));

      expect((await repo.listDocuments({
        indexId: 'idx-1', entityType: 'task', limit: 10,
      })).map((document) => document.entityId)).toEqual(['task-1']);
      expect((await repo.listDocuments({
        indexId: 'idx-1', entityType: 'alert', limit: 10,
      })).map((document) => document.entityId)).toEqual(['alert-1']);
      expect((await repo.listDocuments({
        indexId: 'idx-2', entityType: 'task', limit: 10,
      })).map((document) => document.id)).toEqual(['doc-other']);
    });

    it('rejects a non-positive limit rather than scanning the corpus', async () => {
      await expect(repo.listDocuments({
        indexId: 'idx-1', entityType: 'task', limit: 0,
      })).rejects.toBeInstanceOf(SemanticIndexValidationError);
    });
  });

  // ─── Vectors ────────────────────────────────────────────────────────

  describe('vectors', () => {
    it('records provider, model, dimensions, timestamps, and job identity', async () => {
      await seedIndexedTask();
      const vector = await repo.getVector('idx-1', 'task', 'task-1');
      expect(vector).toMatchObject({
        documentId: 'doc-1',
        documentVersion: 1,
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 3,
        embeddedAt: T0,
        indexRunId: 'run-1',
        intentId: 'intent-1',
        expiresAt: null,
        sourceRevision: 'rev-1',
      });
      expect(vector?.norm).toBeCloseTo(1);
      expect((await repo.getIdentity('idx-1'))?.vectorCount).toBe(1);
    });

    it('rejects a vector whose embedding identity disagrees with the index identity', async () => {
      await repo.upsertDocument(makeDocument());
      await expect(repo.upsertVector(makeVector({ provider: 'azure' })))
        .rejects.toMatchObject({ code: 'provider-mismatch' });
      await expect(repo.upsertVector(makeVector({ model: 'other' })))
        .rejects.toMatchObject({ code: 'model-mismatch' });
      await expect(repo.upsertVector(makeVector({ dimensions: 1536 })))
        .rejects.toMatchObject({ code: 'dimension-mismatch' });
      await expect(repo.upsertVector(makeVector({ projectionVersion: 2 })))
        .rejects.toMatchObject({ code: 'projection-version-mismatch' });
    });

    it('rejects an embedding whose length does not match the declared dimensions', async () => {
      await repo.upsertDocument(makeDocument());
      await expect(repo.upsertVector(makeVector({
        embedding: new Float32Array([1, 0]),
      }))).rejects.toMatchObject({ code: 'dimension-mismatch' });
    });

    it('rejects non-finite and zero-norm embeddings', async () => {
      await repo.upsertDocument(makeDocument());
      await expect(repo.upsertVector(makeVector({
        embedding: new Float32Array([1, Number.NaN, 0]),
      }))).rejects.toMatchObject({ code: 'invalid-embedding' });
      await expect(repo.upsertVector(makeVector({
        embedding: new Float32Array([0, 0, 0]),
      }))).rejects.toMatchObject({ code: 'invalid-embedding' });
    });

    it('refuses a vector for a superseded or missing document version', async () => {
      await repo.upsertDocument(makeDocument());
      await repo.upsertDocument(makeDocument({
        sourceRevision: 'rev-2', contentFingerprint: 'fp-2', sourceUpdatedAt: T1, now: T1,
      }));

      // A worker that embedded version 1 must not overwrite version 2.
      expect(await repo.upsertVector(makeVector({
        documentVersion: 1, sourceRevision: 'rev-1',
      }))).toEqual({ status: 'stale', reason: 'document-superseded' });

      expect(await repo.upsertVector(makeVector({
        documentId: 'absent', documentVersion: 1,
      }))).toEqual({ status: 'stale', reason: 'document-missing' });

      expect(await repo.upsertVector(makeVector({
        documentVersion: 2, sourceRevision: 'rev-2', sourceUpdatedAt: T1, now: T1,
      }))).toEqual({ status: 'created' });
    });

    it('refuses an older source update over a newer stored vector', async () => {
      await repo.upsertDocument(makeDocument({ sourceUpdatedAt: T1, now: T1 }));
      await repo.upsertVector(makeVector({ sourceUpdatedAt: T1, now: T1 }));
      expect(await repo.upsertVector(makeVector({
        sourceUpdatedAt: T0, now: T2, embedding: new Float32Array([0, 1, 0]),
      }))).toEqual({ status: 'stale', reason: 'older-source-update' });
    });

    it('reports an identical rewrite as unchanged', async () => {
      await seedIndexedTask();
      expect(await repo.upsertVector(makeVector())).toEqual({ status: 'unchanged' });
      expect((await repo.getIdentity('idx-1'))?.vectorCount).toBe(1);
    });

    it('rejects a vector addressed to a different entity than its document', async () => {
      await repo.upsertDocument(makeDocument());
      await expect(repo.upsertVector(makeVector({ entityId: 'other' })))
        .rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('keeps identity counts accurate across delete', async () => {
      await seedIndexedTask();
      expect(await repo.deleteVector('idx-1', 'task', 'task-1')).toBe(true);
      expect(await repo.deleteVector('idx-1', 'task', 'task-1')).toBe(false);
      expect((await repo.getIdentity('idx-1'))).toMatchObject({ documentCount: 1, vectorCount: 0 });
    });
  });

  // ─── Query ──────────────────────────────────────────────────────────

  describe('query', () => {
    async function seedQueryableCorpus() {
      await repo.upsertDocument(makeDocument({ id: 'doc-close', entityId: 'close', title: 'Close' }));
      await repo.upsertVector(makeVector({
        id: 'vec-close', documentId: 'doc-close', entityId: 'close',
        embedding: new Float32Array([0.9, 0.1, 0]),
      }));
      await repo.upsertDocument(makeDocument({ id: 'doc-far', entityId: 'far', title: 'Far' }));
      await repo.upsertVector(makeVector({
        id: 'vec-far', documentId: 'doc-far', entityId: 'far',
        embedding: new Float32Array([0, 0, 1]),
      }));
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);
    }

    it('resolves the active identity, ranks by score, and reports the bounded scan', async () => {
      await seedQueryableCorpus();
      const response = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 10,
        now: T2,
      });

      expect(response.identityId).toBe('idx-1');
      expect(response.results.map((result) => result.entityId)).toEqual(['close', 'far']);
      expect(response.results[0].score).toBeGreaterThan(response.results[1].score);
      expect(response.results[0]).toMatchObject({
        title: 'Close', provider: 'openai', model: 'text-embedding-3-small', sensitivity: 'standard',
      });
      expect(response.scan).toEqual({
        kind: 'bounded-in-process',
        candidatesScanned: 2,
        candidateCeiling: 100,
        guaranteesFullRecall: false,
        guaranteedScale: 100,
        truncated: false,
      });
    });

    it('returns an empty, explicit response when no identity is active', async () => {
      const response = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]), limit: 5,
      });
      expect(response.identityId).toBeNull();
      expect(response.results).toEqual([]);
      expect(response.scan.guaranteesFullRecall).toBe(false);
    });

    it('refuses to query a building, retired, or failed identity', async () => {
      await expect(repo.queryVectors({
        indexId: 'idx-1', queryEmbedding: new Float32Array([1, 0, 0]), limit: 5,
      })).rejects.toMatchObject({ code: 'identity-not-queryable' });

      // A staged build may be evaluated once it is ready.
      await seedIndexedTask();
      await repo.markIdentityReady('idx-1', T1);
      const response = await repo.queryVectors({
        indexId: 'idx-1', queryEmbedding: new Float32Array([1, 0, 0]), limit: 5, now: T2,
      });
      expect(response.identityId).toBe('idx-1');
    });

    it('validates the query embedding against the identity dimensions', async () => {
      await seedQueryableCorpus();
      await expect(repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0]), limit: 5,
      })).rejects.toMatchObject({ code: 'dimension-mismatch' });
      await expect(repo.queryVectors({
        queryEmbedding: new Float32Array([Number.POSITIVE_INFINITY, 0, 0]), limit: 5,
      })).rejects.toMatchObject({ code: 'invalid-embedding' });
    });

    it('breaks score ties deterministically by kind, then title, then id', async () => {
      const shared = new Float32Array([1, 0, 0]);
      const rows: Array<[string, string, 'task' | 'project', string]> = [
        ['doc-b', 'b', 'task', 'Beta'],
        ['doc-a', 'a', 'task', 'alpha'],
        ['doc-p', 'p', 'project', 'Zeta'],
      ];
      for (const [documentId, entityId, entityType, title] of rows) {
        await repo.upsertDocument(makeDocument({ id: documentId, entityId, entityType, title }));
        await repo.upsertVector(makeVector({
          id: `vec-${entityId}`, documentId, entityId, entityType, embedding: shared,
        }));
      }
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);

      const response = await repo.queryVectors({
        queryEmbedding: shared, limit: 10, now: T2,
      });
      expect(response.results.map((result) => result.entityId)).toEqual(['p', 'a', 'b']);
    });

    it('filters by entity kind and sensitivity', async () => {
      await repo.upsertDocument(makeDocument({ id: 'doc-t', entityId: 't1' }));
      await repo.upsertVector(makeVector({ id: 'vec-t', documentId: 'doc-t', entityId: 't1' }));
      await repo.upsertDocument(makeDocument({
        id: 'doc-a', entityType: 'alert', entityId: 'a1', sensitivity: 'local-only',
      }));
      await repo.upsertVector(makeVector({
        id: 'vec-a', documentId: 'doc-a', entityType: 'alert', entityId: 'a1',
        sensitivity: 'local-only',
      }));
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);

      const alerts = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]), limit: 10, entityTypes: ['alert'], now: T2,
      });
      expect(alerts.results.map((result) => result.entityType)).toEqual(['alert']);

      const standardOnly = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]), limit: 10, sensitivities: ['standard'], now: T2,
      });
      expect(standardOnly.results.map((result) => result.entityId)).toEqual(['t1']);
    });

    it('excludes deleted documents and expired retention from results', async () => {
      await seedIndexedTask({ document: { retainUntil: T1 } });
      await repo.upsertDocument(makeDocument({ id: 'doc-2', entityId: 'task-2' }));
      await repo.upsertVector(makeVector({ id: 'vec-2', documentId: 'doc-2', entityId: 'task-2' }));
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1, { maxStaleDocuments: 1 });

      const response = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]), limit: 10, now: T2,
      });
      expect(response.results.map((result) => result.entityId)).toEqual(['task-2']);
    });

    it('applies minScore and reports truncation against the candidate ceiling', async () => {
      const smallRepo = new SqliteSemanticIndexRepository(db, 1);
      await repo.upsertDocument(makeDocument({ id: 'doc-a', entityId: 'a' }));
      await repo.upsertVector(makeVector({
        id: 'vec-a', documentId: 'doc-a', entityId: 'a', embedding: new Float32Array([0, 1, 0]),
      }));
      await repo.upsertDocument(makeDocument({ id: 'doc-b', entityId: 'b' }));
      await repo.upsertVector(makeVector({
        id: 'vec-b', documentId: 'doc-b', entityId: 'b', embedding: new Float32Array([1, 0, 0]),
      }));
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);

      const truncatedResponse = await smallRepo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]), limit: 10, now: T2,
      });
      expect(truncatedResponse.scan).toMatchObject({
        candidatesScanned: 1, candidateCeiling: 1, truncated: true, guaranteesFullRecall: false,
      });

      const filtered = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]), limit: 10, minScore: 0.5, now: T2,
      });
      expect(filtered.results.map((result) => result.entityId)).toEqual(['b']);
    });

    it('filters on projected metadata before the candidate ceiling', async () => {
      await repo.upsertDocument(makeDocument({
        id: 'doc-alpha',
        entityId: 'alpha',
        metadata: { status: 'todo', connectorType: 'github-issues', sourceListName: 'Alpha' },
      }));
      await repo.upsertVector(makeVector({
        id: 'vec-alpha', documentId: 'doc-alpha', entityId: 'alpha',
      }));
      await repo.upsertDocument(makeDocument({
        id: 'doc-beta',
        entityId: 'beta',
        metadata: { status: 'done', connectorType: 'local', sourceListName: 'Beta' },
      }));
      await repo.upsertVector(makeVector({
        id: 'vec-beta', documentId: 'doc-beta', entityId: 'beta',
      }));
      // An alert carries `category` instead of `status`, which is exactly the
      // per-kind key difference the grouped predicate exists to bridge.
      await repo.upsertDocument(makeDocument({
        id: 'doc-alert', entityType: 'alert', entityId: 'alert-1',
        metadata: { category: 'sync', connectorType: 'monitoring' },
      }));
      await repo.upsertVector(makeVector({
        id: 'vec-alert', documentId: 'doc-alert', entityType: 'alert', entityId: 'alert-1',
      }));
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);

      const bySource = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 10,
        now: T2,
        metadataFilters: [
          { keys: ['sourceListName', 'connectorType'], match: 'any', values: ['Alpha'] },
        ],
      });
      expect(bySource.results.map((result) => result.entityId)).toEqual(['alpha']);
      // The excluded rows never entered the scan, so they cannot displace an
      // allowed row when the ceiling is reached.
      expect(bySource.scan.candidatesScanned).toBe(1);

      const notDone = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 10,
        now: T2,
        metadataFilters: [
          { keys: ['status', 'category'], match: 'none', values: ['DONE'], caseInsensitive: true },
        ],
      });
      // A document without the key still passes an exclusion filter.
      expect(notDone.results.map((result) => result.entityId).sort())
        .toEqual(['alert-1', 'alpha']);
    });

    it('matches numeric, boolean, and string metadata as portable text', async () => {
      // `effort` is numeric, `isChecklistItem` boolean, `status` a string, and
      // `parentId` JSON null — the four shapes the projection can emit.
      await repo.upsertDocument(makeDocument({
        id: 'doc-alpha',
        entityId: 'alpha',
        metadata: { status: 'todo', effort: 3, isChecklistItem: true, parentId: null },
      }));
      await repo.upsertVector(makeVector({ id: 'vec-alpha', documentId: 'doc-alpha', entityId: 'alpha' }));
      await repo.upsertDocument(makeDocument({
        id: 'doc-beta',
        entityId: 'beta',
        metadata: { status: 'done', effort: 5, isChecklistItem: false },
      }));
      await repo.upsertVector(makeVector({ id: 'vec-beta', documentId: 'doc-beta', entityId: 'beta' }));
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);

      const query = async (filter: SemanticMetadataFilter) => {
        const response = await repo.queryVectors({
          queryEmbedding: new Float32Array([1, 0, 0]),
          limit: 10,
          now: T2,
          metadataFilters: [filter],
        });
        return response.results.map((result) => result.entityId).sort();
      };

      // Numbers compare as their text form, exactly as PostgreSQL's `->>` does.
      expect(await query({ keys: ['effort'], match: 'any', values: ['3'] })).toEqual(['alpha']);
      // Booleans are 'true'/'false', never SQLite's native 1/0.
      expect(await query({ keys: ['isChecklistItem'], match: 'any', values: ['true'] }))
        .toEqual(['alpha']);
      expect(await query({ keys: ['isChecklistItem'], match: 'any', values: ['false'] }))
        .toEqual(['beta']);
      expect(await query({ keys: ['isChecklistItem'], match: 'any', values: ['1'] })).toEqual([]);
      expect(await query({ keys: ['status'], match: 'any', values: ['todo'] })).toEqual(['alpha']);

      // `none` inverts each of them, and a JSON null passes an exclusion just
      // like an absent key does.
      expect(await query({ keys: ['effort'], match: 'none', values: ['3'] })).toEqual(['beta']);
      expect(await query({ keys: ['isChecklistItem'], match: 'none', values: ['true'] }))
        .toEqual(['beta']);
      expect(await query({ keys: ['parentId'], match: 'none', values: ['task-9'] }))
        .toEqual(['alpha', 'beta']);
      expect(await query({ keys: ['parentId'], match: 'any', values: ['task-9'] })).toEqual([]);

      // Case-insensitive matching folds the same portable text.
      expect(await query({
        keys: ['isChecklistItem'], match: 'any', values: ['TRUE'], caseInsensitive: true,
      })).toEqual(['alpha']);
    });

    it('excludes named entities and rejects unsupported metadata keys', async () => {
      await seedIndexedTask();
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);

      const excluded = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 10,
        now: T2,
        excludeEntityIds: ['task-1'],
      });
      expect(excluded.results).toEqual([]);

      await expect(repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 10,
        metadataFilters: [{ keys: ["status') OR 1=1 --"], match: 'any', values: ['x'] }],
      })).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('returns projected metadata and the vector freshness stamp', async () => {
      await repo.upsertDocument(makeDocument({ metadata: { status: 'todo', priority: 'high' } }));
      await repo.upsertVector(makeVector({ embeddedAt: T1 }));
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);

      const response = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]), limit: 10, now: T2,
      });
      expect(response.results[0]).toMatchObject({
        metadata: { status: 'todo', priority: 'high' },
        embeddedAt: T1,
      });
    });
  });

  // ─── Intent queue ───────────────────────────────────────────────────

  describe('durable intent queue', () => {
    it('enqueues a queued intent with attempt and lease bookkeeping', async () => {
      const result = await repo.enqueueIntent(makeIntent());
      expect(result.status).toBe('enqueued');
      expect(result.intent).toMatchObject({
        status: 'queued',
        attempt: 0,
        maxAttempts: 5,
        availableAt: T0,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryAfter: null,
        outcome: null,
      });
    });

    it('coalesces newer work into the queued row and ignores older work', async () => {
      await repo.enqueueIntent(makeIntent());
      const newer = await repo.enqueueIntent(makeIntent({
        id: 'intent-2', sourceRevision: 'rev-2', requestedAt: T1, now: T1,
      }));
      expect(newer.status).toBe('coalesced');
      expect(newer.intent.id).toBe('intent-1');
      expect(newer.intent.sourceRevision).toBe('rev-2');

      const older = await repo.enqueueIntent(makeIntent({
        id: 'intent-3', sourceRevision: 'rev-0', requestedAt: T0, now: T2,
      }));
      expect(older.status).toBe('ignored');
      expect(older.intent.sourceRevision).toBe('rev-2');

      const metrics = await repo.getMetrics('idx-1', T2);
      expect(metrics.intents.queued).toBe(1);
    });

    it('never overwrites an in-flight attempt — newer work enqueues alongside it', async () => {
      await repo.enqueueIntent(makeIntent());
      const [claimed] = await repo.claimIntents({
        indexId: 'idx-1', owner: 'worker-a', limit: 10, leaseMs: 60_000, now: T0,
      });
      expect(claimed.status).toBe('running');

      const superseding = await repo.enqueueIntent(makeIntent({
        id: 'intent-2', sourceRevision: 'rev-2', requestedAt: T1, now: T1,
      }));
      expect(superseding.status).toBe('superseded');
      expect(superseding.intent.id).toBe('intent-2');
      // The running attempt still carries the projection it claimed.
      expect((await repo.getIntent('intent-1'))?.sourceRevision).toBe('rev-1');
    });

    it('claims atomically in requested order and leases to one owner', async () => {
      await repo.enqueueIntent(makeIntent({ id: 'i1', idempotencyKey: 'k1', requestedAt: T0 }));
      await repo.enqueueIntent(makeIntent({
        id: 'i2', idempotencyKey: 'k2', entityId: 'task-2', requestedAt: T1,
      }));

      const first = await repo.claimIntents({
        indexId: 'idx-1', owner: 'worker-a', limit: 1, leaseMs: 60_000, now: T1,
      });
      expect(first.map((intent) => intent.id)).toEqual(['i1']);
      expect(first[0]).toMatchObject({ attempt: 1, leaseOwner: 'worker-a' });

      const second = await repo.claimIntents({
        indexId: 'idx-1', owner: 'worker-b', limit: 10, leaseMs: 60_000, now: T1,
      });
      expect(second.map((intent) => intent.id)).toEqual(['i2']);

      // Nothing is left claimable.
      expect(await repo.claimIntents({
        indexId: 'idx-1', owner: 'worker-c', limit: 10, leaseMs: 60_000, now: T1,
      })).toEqual([]);
    });

    it('honours availableAt so retried work is not claimed early', async () => {
      await repo.enqueueIntent(makeIntent({ availableAt: T2 }));
      expect(await repo.claimIntents({
        indexId: 'idx-1', owner: 'worker-a', limit: 10, leaseMs: 60_000, now: T1,
      })).toEqual([]);
      expect(await repo.claimIntents({
        indexId: 'idx-1', owner: 'worker-a', limit: 10, leaseMs: 60_000, now: T2,
      })).toHaveLength(1);
    });

    it('renews a lease only for the holding owner', async () => {
      await repo.enqueueIntent(makeIntent());
      await repo.claimIntents({
        indexId: 'idx-1', owner: 'worker-a', limit: 10, leaseMs: 60_000, now: T0,
      });

      expect(await repo.renewIntentLease({
        id: 'intent-1', owner: 'worker-b', leaseMs: 60_000, now: T0,
      })).toBe(false);
      expect(await repo.renewIntentLease({
        id: 'intent-1', owner: 'worker-a', leaseMs: 120_000, now: T0,
      })).toBe(true);
      expect((await repo.getIntent('intent-1'))?.leaseExpiresAt)
        .toBe('2026-08-29T00:02:00.000Z');
    });

    it('completes terminally only for the lease holder', async () => {
      await repo.enqueueIntent(makeIntent());
      await repo.claimIntents({
        indexId: 'idx-1', owner: 'worker-a', limit: 10, leaseMs: 60_000, now: T0,
      });

      expect(await repo.completeIntent({ id: 'intent-1', owner: 'worker-b', now: T1 })).toBe(false);
      expect(await repo.completeIntent({
        id: 'intent-1', owner: 'worker-a', now: T1, outcome: 'embedded',
      })).toBe(true);

      expect(await repo.getIntent('intent-1')).toMatchObject({
        status: 'succeeded', outcome: 'embedded', completedAt: T1, leaseOwner: null,
      });
      // A terminal intent cannot be completed twice.
      expect(await repo.completeIntent({ id: 'intent-1', owner: 'worker-a', now: T2 })).toBe(false);
    });

    it('retries with backoff, honours retryAfter, and fails permanently at max attempts', async () => {
      await repo.enqueueIntent(makeIntent({ maxAttempts: 2 }));

      await repo.claimIntents({ indexId: 'idx-1', owner: 'w', limit: 1, leaseMs: 60_000, now: T0 });
      expect(await repo.failIntent({
        id: 'intent-1', owner: 'w', error: 'rate limited', now: T0, retryAfter: T1,
      })).toBe('queued');
      expect(await repo.getIntent('intent-1')).toMatchObject({
        status: 'queued', attempt: 1, availableAt: T1, retryAfter: T1, lastError: 'rate limited',
      });

      await repo.claimIntents({ indexId: 'idx-1', owner: 'w', limit: 1, leaseMs: 60_000, now: T1 });
      expect(await repo.failIntent({
        id: 'intent-1', owner: 'w', error: 'boom', now: T1,
      })).toBe('failed');
      expect(await repo.getIntent('intent-1')).toMatchObject({
        status: 'failed', attempt: 2, outcome: 'permanent-failure', completedAt: T1,
      });
    });

    it('marks a policy refusal as denied without consuming retries', async () => {
      await repo.enqueueIntent(makeIntent());
      await repo.claimIntents({ indexId: 'idx-1', owner: 'w', limit: 1, leaseMs: 60_000, now: T0 });
      expect(await repo.failIntent({
        id: 'intent-1', owner: 'w', error: 'sensitivity policy', now: T1, denied: true,
      })).toBe('denied');
      expect(await repo.getIntent('intent-1')).toMatchObject({
        status: 'denied', outcome: 'denied', attempt: 1,
      });
    });

    it('recovers an expired lease back to queued, and expires it once attempts run out', async () => {
      await repo.enqueueIntent(makeIntent({ maxAttempts: 1 }));
      await repo.enqueueIntent(makeIntent({
        id: 'intent-2', idempotencyKey: 'k2', entityId: 'task-2', maxAttempts: 3,
      }));

      await repo.claimIntents({ indexId: 'idx-1', owner: 'w', limit: 10, leaseMs: 1_000, now: T0 });
      const recovered = await repo.recoverExpiredIntentLeases(T1);
      expect(recovered).toEqual({ requeued: 1, expired: 1 });

      expect(await repo.getIntent('intent-1')).toMatchObject({
        status: 'expired', outcome: 'attempts-exhausted', leaseOwner: null,
      });
      expect(await repo.getIntent('intent-2')).toMatchObject({
        status: 'queued', attempt: 1, leaseOwner: null, leaseExpiresAt: null,
      });
    });

    it('expires a recovered attempt that newer queued work already supersedes', async () => {
      await repo.enqueueIntent(makeIntent());
      await repo.claimIntents({ indexId: 'idx-1', owner: 'w', limit: 1, leaseMs: 1_000, now: T0 });
      await repo.enqueueIntent(makeIntent({ id: 'intent-2', requestedAt: T1, now: T1 }));

      expect(await repo.recoverExpiredIntentLeases(T1)).toEqual({ requeued: 0, expired: 1 });
      expect(await repo.getIntent('intent-1')).toMatchObject({
        status: 'expired', outcome: 'superseded',
      });
      expect(await repo.getIntent('intent-2')).toMatchObject({ status: 'queued' });
    });

    it('prunes only terminal intents older than the cutoff', async () => {
      await repo.enqueueIntent(makeIntent());
      await repo.claimIntents({ indexId: 'idx-1', owner: 'w', limit: 1, leaseMs: 60_000, now: T0 });
      await repo.completeIntent({ id: 'intent-1', owner: 'w', now: T0 });
      await repo.enqueueIntent(makeIntent({ id: 'intent-2', idempotencyKey: 'k2' }));

      expect(await repo.pruneIntents(T1)).toBe(1);
      expect(await repo.getIntent('intent-1')).toBeNull();
      expect(await repo.getIntent('intent-2')).not.toBeNull();
    });

    it('reports queue depth, age, retries, and permanent failures', async () => {
      await repo.enqueueIntent(makeIntent({ id: 'q1', idempotencyKey: 'k1' }));
      await repo.enqueueIntent(makeIntent({ id: 'q2', idempotencyKey: 'k2', entityId: 'task-2' }));
      await repo.claimIntents({ indexId: 'idx-1', owner: 'w', limit: 1, leaseMs: 60_000, now: T0 });
      await repo.failIntent({ id: 'q1', owner: 'w', error: 'retry me', now: T0 });

      await repo.enqueueIntent(makeIntent({ id: 'q3', idempotencyKey: 'k3', entityId: 'task-3' }));
      await repo.claimIntents({ indexId: 'idx-1', owner: 'w', limit: 1, leaseMs: 60_000, now: T0 });
      await repo.failIntent({ id: 'q2', owner: 'w', error: 'nope', now: T0, terminal: true });

      const metrics = await repo.getMetrics('idx-1', T1);
      expect(metrics.intents).toMatchObject({
        queued: 2,
        running: 0,
        retrying: 1,
        failed: 1,
        denied: 0,
        expired: 0,
        permanentFailures: 1,
      });
      expect(metrics.intents.oldestQueuedAgeMs).toBe(60 * 60 * 1000);
    });
  });

  // ─── Runs ───────────────────────────────────────────────────────────

  describe('resumable runs', () => {
    async function createBackfill(overrides: { id?: string; key?: string; kind?: 'backfill' | 'reconcile' | 'cleanup' } = {}) {
      return repo.createRun({
        id: overrides.id ?? 'run-1',
        indexId: 'idx-1',
        kind: overrides.kind ?? 'backfill',
        idempotencyKey: overrides.key ?? 'backfill:idx-1',
        now: T0,
      });
    }

    it('creates runs idempotently by key', async () => {
      const created = await createBackfill();
      expect(created.status).toBe('created');
      expect(created.run).toMatchObject({
        kind: 'backfill', status: 'queued', attempt: 0, maxAttempts: 3, checkpoint: null,
      });

      const again = await repo.createRun({
        id: 'run-2', indexId: 'idx-1', kind: 'backfill', idempotencyKey: 'backfill:idx-1', now: T1,
      });
      expect(again.status).toBe('existing');
      expect(again.run.id).toBe('run-1');
    });

    it('supports all three run kinds and one running run per kind', async () => {
      await createBackfill({ id: 'r-b', key: 'k-b', kind: 'backfill' });
      await createBackfill({ id: 'r-r', key: 'k-r', kind: 'reconcile' });
      await createBackfill({ id: 'r-c', key: 'k-c', kind: 'cleanup' });

      const claimed = await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T0, kinds: ['reconcile'] });
      expect(claimed?.id).toBe('r-r');

      // Another reconcile cannot start while one is running.
      await createBackfill({ id: 'r-r2', key: 'k-r2', kind: 'reconcile' });
      expect(await repo.claimRun({
        owner: 'w2', leaseMs: 60_000, now: T0, kinds: ['reconcile'],
      })).toBeNull();
    });

    it('claims, checkpoints, yields, and resumes without losing progress', async () => {
      await createBackfill();
      const claimed = await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T0 });
      // A claim is not an attempt: `attempt` counts failures, so a clean claim
      // leaves the retry budget untouched.
      expect(claimed).toMatchObject({ status: 'running', attempt: 0, leaseOwner: 'w', startedAt: T0 });

      expect(await repo.checkpointRun({
        id: 'run-1', owner: 'w', now: T0, checkpoint: 'task:500',
        processedDelta: 500, failedDelta: 2, skippedDelta: 1, leaseMs: 60_000,
      })).toBe(true);
      expect(await repo.checkpointRun({ id: 'run-1', owner: 'other', now: T0 })).toBe(false);

      expect(await repo.releaseRun({ id: 'run-1', owner: 'w', now: T0 })).toBe(true);
      const resumed = await repo.claimRun({ owner: 'w2', leaseMs: 60_000, now: T0 });
      expect(resumed).toMatchObject({
        status: 'running',
        attempt: 0,
        checkpoint: 'task:500',
        processedCount: 500,
        failedCount: 2,
        skippedCount: 1,
        startedAt: T0,
      });
    });

    it('never spends retry budget on a run that keeps yielding cleanly', async () => {
      await repo.createRun({
        id: 'run-1', indexId: 'idx-1', kind: 'backfill', idempotencyKey: 'k', now: T0, maxAttempts: 3,
      });

      // Far more yields than the attempt budget: a long backfill checkpoints and
      // hands the lease back on every slice, and must still be claimable.
      for (let slice = 1; slice <= 6; slice++) {
        const claimed = await repo.claimRun({ owner: `w${slice}`, leaseMs: 60_000, now: T0 });
        expect(claimed).not.toBeNull();
        await repo.checkpointRun({
          id: 'run-1', owner: `w${slice}`, now: T0, checkpoint: `task:${slice}`, processedDelta: 10,
        });
        await repo.releaseRun({ id: 'run-1', owner: `w${slice}`, now: T0 });
      }

      expect(await repo.getRun('run-1')).toMatchObject({
        status: 'queued', attempt: 0, processedCount: 60, checkpoint: 'task:6',
      });
      // The budget is intact, so a genuine failure still gets its retries.
      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T0 });
      expect(await repo.failRun({ id: 'run-1', owner: 'w', error: 'boom', now: T0 })).toBe('queued');
    });

    it('completes only for the lease holder', async () => {
      await createBackfill();
      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T0 });
      expect(await repo.completeRun({ id: 'run-1', owner: 'other', now: T1 })).toBe(false);
      expect(await repo.completeRun({
        id: 'run-1', owner: 'w', now: T1, checkpoint: 'task:end',
      })).toBe(true);
      expect(await repo.getRun('run-1')).toMatchObject({
        status: 'succeeded', checkpoint: 'task:end', completedAt: T1, leaseOwner: null,
      });
    });

    it('retries a failed run until attempts are exhausted, keeping the checkpoint', async () => {
      await repo.createRun({
        id: 'run-1', indexId: 'idx-1', kind: 'backfill', idempotencyKey: 'k', now: T0, maxAttempts: 2,
      });
      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T0 });
      await repo.checkpointRun({ id: 'run-1', owner: 'w', now: T0, checkpoint: 'task:100' });

      expect(await repo.failRun({
        id: 'run-1', owner: 'w', error: 'provider down', now: T0, availableAt: T1,
      })).toBe('queued');
      expect(await repo.getRun('run-1')).toMatchObject({
        status: 'queued', checkpoint: 'task:100', availableAt: T1, attempt: 1,
      });

      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T1 });
      expect(await repo.failRun({ id: 'run-1', owner: 'w', error: 'again', now: T1 })).toBe('failed');
      expect(await repo.getRun('run-1')).toMatchObject({
        status: 'failed', checkpoint: 'task:100', errorMessage: 'again', attempt: 2,
      });
    });

    it('backs off using the failure count, not the claim count', async () => {
      await repo.createRun({
        id: 'run-1', indexId: 'idx-1', kind: 'backfill', idempotencyKey: 'k', now: T0, maxAttempts: 5,
      });
      // A yield before the first failure must not inflate the backoff.
      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T0 });
      await repo.releaseRun({ id: 'run-1', owner: 'w', now: T0 });

      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T0 });
      await repo.failRun({ id: 'run-1', owner: 'w', error: 'boom', now: T0 });
      const first = await repo.getRun('run-1');
      expect(first).toMatchObject({ attempt: 1, availableAt: computeSemanticRetryAt(T0, 1) });

      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: first!.availableAt });
      await repo.failRun({ id: 'run-1', owner: 'w', error: 'boom', now: T1 });
      expect(await repo.getRun('run-1')).toMatchObject({
        attempt: 2, availableAt: computeSemanticRetryAt(T1, 2),
      });
    });

    it('recovers an expired run lease and preserves its checkpoint', async () => {
      await createBackfill();
      await repo.claimRun({ owner: 'w', leaseMs: 1_000, now: T0 });
      await repo.checkpointRun({ id: 'run-1', owner: 'w', now: T0, checkpoint: 'task:250' });

      expect(await repo.recoverExpiredRunLeases(T1)).toEqual({ requeued: 1, expired: 0 });
      expect(await repo.getRun('run-1')).toMatchObject({
        status: 'queued', checkpoint: 'task:250', leaseOwner: null, attempt: 1,
      });
    });

    it('spends the whole recovery budget on abandoned leases and no more', async () => {
      await repo.createRun({
        id: 'run-1', indexId: 'idx-1', kind: 'backfill', idempotencyKey: 'k', now: T0, maxAttempts: 3,
      });

      // Three abandoned leases: two recoveries, then the budget is spent. Each
      // claim uses the backed-off `availableAt` the previous recovery set, and
      // each recovery runs after that claim's lease has elapsed.
      const abandon = async (owner: string) => {
        const at = (await repo.getRun('run-1'))!.availableAt;
        expect(await repo.claimRun({ owner, leaseMs: 1_000, now: at })).not.toBeNull();
        return repo.recoverExpiredRunLeases(addMs(at, 60_000));
      };

      for (let attempt = 1; attempt <= 2; attempt++) {
        expect(await abandon(`w${attempt}`)).toEqual({ requeued: 1, expired: 0 });
        expect(await repo.getRun('run-1')).toMatchObject({ status: 'queued', attempt });
      }

      expect(await abandon('w3')).toEqual({ requeued: 0, expired: 1 });
      expect(await repo.getRun('run-1')).toMatchObject({ status: 'expired', attempt: 3 });
    });

    it('expires a run whose lease elapsed with no attempts left', async () => {
      await repo.createRun({
        id: 'run-1', indexId: 'idx-1', kind: 'cleanup', idempotencyKey: 'k', now: T0, maxAttempts: 1,
      });
      await repo.claimRun({ owner: 'w', leaseMs: 1_000, now: T0 });
      expect(await repo.recoverExpiredRunLeases(T1)).toEqual({ requeued: 0, expired: 1 });
      expect(await repo.getRun('run-1')).toMatchObject({ status: 'expired', completedAt: T1 });
    });

    it('re-schedules a fixed key after a terminal failure, keeping the failed run as history', async () => {
      await repo.createRun({
        id: 'run-1', indexId: 'idx-1', kind: 'backfill',
        idempotencyKey: 'backfill:initial', now: T0, maxAttempts: 1,
      });
      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T0 });
      await repo.checkpointRun({ id: 'run-1', owner: 'w', now: T0, checkpoint: 'task:42' });
      expect(await repo.failRun({ id: 'run-1', owner: 'w', error: 'provider gone', now: T0 }))
        .toBe('failed');

      const rescheduled = await repo.createRun({
        id: 'run-2', indexId: 'idx-1', kind: 'backfill',
        idempotencyKey: 'backfill:initial', now: T1,
      });
      expect(rescheduled.status).toBe('created');
      // The replacement resumes from the failed run's checkpoint with a fresh
      // budget, and is immediately claimable again.
      expect(rescheduled.run).toMatchObject({
        id: 'run-2', status: 'queued', attempt: 0, checkpoint: 'task:42',
      });
      expect((await repo.claimRun({ owner: 'w2', leaseMs: 60_000, now: T1 }))?.id).toBe('run-2');

      // The terminal attempt is preserved, moved aside so the key is free.
      const history = await repo.getRun('run-1');
      expect(history).toMatchObject({ status: 'failed', errorMessage: 'provider gone' });
      expect(history?.idempotencyKey).toBe(
        supersededRunIdempotencyKey('backfill:initial', 'run-1'),
      );
    });

    it('re-schedules a fixed key after an expired run but never after a successful one', async () => {
      await repo.createRun({
        id: 'run-1', indexId: 'idx-1', kind: 'cleanup', idempotencyKey: 'cleanup:w', now: T0, maxAttempts: 1,
      });
      await repo.claimRun({ owner: 'w', leaseMs: 1_000, now: T0 });
      await repo.recoverExpiredRunLeases(T1);
      expect((await repo.getRun('run-1'))?.status).toBe('expired');

      const afterExpiry = await repo.createRun({
        id: 'run-2', indexId: 'idx-1', kind: 'cleanup', idempotencyKey: 'cleanup:w', now: T1,
      });
      expect(afterExpiry.status).toBe('created');

      // A completed run keeps its key: the once-per-identity backfill must not
      // be requeued on every maintenance tick.
      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T1 });
      await repo.completeRun({ id: 'run-2', owner: 'w', now: T2 });
      const afterSuccess = await repo.createRun({
        id: 'run-3', indexId: 'idx-1', kind: 'cleanup', idempotencyKey: 'cleanup:w', now: T2,
      });
      expect(afterSuccess).toMatchObject({ status: 'existing', run: { id: 'run-2' } });
    });
  });

  // ─── Observability ──────────────────────────────────────────────────

  describe('readiness and metrics', () => {
    it('reports readiness with stale, incompatible, and expired counts by entity kind', async () => {
      await seedIndexedTask();
      // A stale alert: document present, no vector for its revision.
      await repo.upsertDocument(makeDocument({
        id: 'doc-alert', entityType: 'alert', entityId: 'alert-1',
      }));
      // An expired project document.
      await repo.upsertDocument(makeDocument({
        id: 'doc-project', entityType: 'project', entityId: 'project-1', retainUntil: T1,
      }));
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1, { maxStaleDocuments: 2 });

      const readiness = await repo.getReadiness(T2);
      expect(readiness).toMatchObject({
        available: true,
        activeIdentityId: 'idx-1',
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 3,
        projectionVersion: 1,
        documentCount: 3,
        vectorCount: 1,
        readyIdentityIds: [],
      });

      const byKind = Object.fromEntries(
        readiness.byEntityType.map((entry) => [entry.entityType, entry]),
      );
      expect(byKind.task).toMatchObject({ documents: 1, vectors: 1, stale: 0, expired: 0 });
      expect(byKind.alert).toMatchObject({ documents: 1, vectors: 0, stale: 1 });
      expect(byKind.project).toMatchObject({ documents: 1, vectors: 0, stale: 1, expired: 1 });
      expect(byKind.tag).toMatchObject({ documents: 0, vectors: 0 });
    });

    it('counts vectors that drifted out of the identity vector space as incompatible', async () => {
      await seedIndexedTask();
      // Simulate a legacy/miswritten row that bypassed the write path.
      db.prepare(`UPDATE semantic_vectors SET dimensions = 1536 WHERE id = 'vec-1'`).run();

      const metrics = await repo.getMetrics('idx-1', T2);
      const task = metrics.byEntityType.find((entry) => entry.entityType === 'task');
      expect(task).toMatchObject({ vectors: 1, incompatible: 1 });

      await repo.markIdentityReady('idx-1', T1);
      expect(await repo.activateIdentity('idx-1', T1)).toMatchObject({
        status: 'rejected', reason: 'gate-incompatible-vectors',
      });
    });

    it('reports no active identity but still lists ready candidates', async () => {
      await seedIndexedTask();
      await repo.markIdentityReady('idx-1', T1);

      const readiness = await repo.getReadiness(T2);
      expect(readiness).toMatchObject({
        available: false, activeIdentityId: null, documentCount: 0, vectorCount: 0,
        readyIdentityIds: ['idx-1'],
      });
      expect(readiness.byEntityType).toHaveLength(6);
    });

    it('summarises run states alongside the queue', async () => {
      await repo.createRun({
        id: 'run-1', indexId: 'idx-1', kind: 'backfill', idempotencyKey: 'k1', now: T0,
      });
      await repo.createRun({
        id: 'run-2', indexId: 'idx-1', kind: 'reconcile', idempotencyKey: 'k2', now: T0,
      });
      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T0, kinds: ['backfill'] });

      const metrics = await repo.getMetrics('idx-1', T1);
      expect(metrics.runs).toMatchObject({ queued: 1, running: 1, succeeded: 0, failed: 0 });
      expect(metrics.identityStatus).toBe('building');
    });

    it('reports the newest run per kind with its checkpoint and progress', async () => {
      await repo.createRun({
        id: 'run-old', indexId: 'idx-1', kind: 'backfill', idempotencyKey: 'k-old', now: T0,
      });
      await repo.createRun({
        id: 'run-new', indexId: 'idx-1', kind: 'backfill', idempotencyKey: 'k-new', now: T1,
      });
      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T1, kinds: ['backfill'] });
      await repo.checkpointRun({
        id: 'run-old', owner: 'w', now: T1, checkpoint: 'task:cursor-9', processedDelta: 4,
      });

      const metrics = await repo.getMetrics('idx-1', T2);
      expect(metrics.latestRuns).toEqual([
        expect.objectContaining({
          id: 'run-new', kind: 'backfill', status: 'queued', checkpoint: null,
        }),
      ]);
      // Progress projections never carry a lease owner or an error string.
      expect(Object.keys(metrics.latestRuns[0])).not.toContain('leaseOwner');
      expect(Object.keys(metrics.latestRuns[0])).not.toContain('errorMessage');
    });

    it('describes staging identities and the bounded-scan capability', async () => {
      await seedIndexedTask();
      await repo.markIdentityReady('idx-1', T1);
      await repo.activateIdentity('idx-1', T1);
      await repo.createIdentity({
        id: 'idx-next',
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 3072,
        projectionVersion: 1,
        now: T1,
      });

      const readiness = await repo.getReadiness(T2);
      expect(readiness.stagingIdentities).toEqual([
        expect.objectContaining({
          id: 'idx-next',
          provider: 'openai',
          model: 'text-embedding-3-large',
          dimensions: 3072,
          status: 'building',
        }),
      ]);
      expect(readiness.scan).toEqual({
        kind: 'bounded-in-process',
        candidateCeiling: 100,
        guaranteesFullRecall: false,
        guaranteedScale: 100,
      });
    });
  });
});
