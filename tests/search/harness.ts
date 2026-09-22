import type Database from 'better-sqlite3';
import { SqliteSemanticIndexRepository } from '@/lib/semantic-index/sqlite-repository';
import type {
  SemanticDocumentMetadataValue,
  SemanticEntityType,
  SemanticIndexRepository,
} from '@/lib/semantic-index/contracts';
import type {
  SemanticEmbeddingOutcome,
  SemanticEmbeddingProvider,
  SemanticEmbeddingRequest,
  SemanticRouteResolution,
} from '@/lib/semantic-index/embedding-provider';
import { createSemanticTestDatabase } from '../semantic-index/harness';

export const PROVIDER = 'openai';
export const MODEL = 'text-embedding-3-small';
export const DIMENSIONS = 3;

export const T0 = '2026-08-29T00:00:00.000Z';
export const T1 = '2026-08-29T01:00:00.000Z';
export const T2 = '2026-08-29T02:00:00.000Z';

/**
 * An embedding provider that only ever answers with scripted vectors.
 *
 * Retrieval tests must be able to prove that *no* corpus embedding happens, so
 * every call is recorded and an unscripted call is an explicit failure rather
 * than a silently generated vector.
 */
export class ScriptedEmbeddingProvider implements SemanticEmbeddingProvider {
  readonly calls: SemanticEmbeddingRequest[] = [];
  readonly routeCalls: string[] = [];
  private readonly queue: SemanticEmbeddingOutcome[] = [];
  route: SemanticRouteResolution = {
    status: 'ok',
    route: { provider: PROVIDER, model: MODEL },
  };

  enqueue(outcome: SemanticEmbeddingOutcome): this {
    this.queue.push(outcome);
    return this;
  }

  enqueueVector(values: number[], overrides: Partial<{ provider: string; model: string }> = {}) {
    return this.enqueue({
      status: 'ok',
      embedding: Float32Array.from(values),
      provider: overrides.provider ?? PROVIDER,
      model: overrides.model ?? MODEL,
      dimensions: values.length,
    });
  }

  async resolveRoute(sensitivity: string): Promise<SemanticRouteResolution> {
    this.routeCalls.push(sensitivity);
    return this.route;
  }

  async embed(request: SemanticEmbeddingRequest): Promise<SemanticEmbeddingOutcome> {
    this.calls.push(request);
    const scripted = this.queue.shift();
    if (!scripted) {
      throw new Error(`Unscripted embedding request: ${request.text}`);
    }
    if (scripted.status === 'ok' && request.expect) {
      if (
        scripted.provider !== request.expect.provider
        || scripted.model !== request.expect.model
      ) {
        return { status: 'failed', reason: 'route-mismatch', retryAfter: null };
      }
      if (scripted.dimensions !== request.expect.dimensions) {
        return { status: 'failed', reason: 'dimension-mismatch', retryAfter: null };
      }
    }
    return scripted;
  }
}

export interface SearchIndexHarness {
  db: Database.Database;
  repository: SemanticIndexRepository;
  embeddings: ScriptedEmbeddingProvider;
  createIdentity(input?: {
    id?: string;
    provider?: string;
    model?: string;
    dimensions?: number;
    now?: string;
  }): Promise<string>;
  activate(indexId: string, now?: string): Promise<void>;
  seedEntity(input: {
    indexId?: string;
    entityType: SemanticEntityType;
    entityId: string;
    title: string;
    body?: string;
    metadata?: Record<string, SemanticDocumentMetadataValue>;
    embedding: number[];
    sourceUpdatedAt?: string;
    embeddedAt?: string;
    provider?: string;
    model?: string;
    /** Advances the document past the vector, leaving the vector stale. */
    stale?: boolean;
  }): Promise<void>;
  close(): void;
}

/**
 * Builds a real SQLite-backed semantic index so retrieval tests exercise the
 * production repository (ordering, candidate ceiling, portable metadata
 * filters) rather than a stub that could silently disagree with it.
 */
export function createSearchIndexHarness(scanLimit = 100): SearchIndexHarness {
  const db = createSemanticTestDatabase();
  const repository = new SqliteSemanticIndexRepository(db, scanLimit);
  const embeddings = new ScriptedEmbeddingProvider();
  let sequence = 0;
  let defaultIndexId = '';

  return {
    db,
    repository,
    embeddings,
    async createIdentity(input = {}) {
      const identity = await repository.createIdentity({
        id: input.id ?? `idx-${++sequence}`,
        provider: input.provider ?? PROVIDER,
        model: input.model ?? MODEL,
        dimensions: input.dimensions ?? DIMENSIONS,
        projectionVersion: 1,
        now: input.now ?? T0,
      });
      if (!defaultIndexId) defaultIndexId = identity.id;
      return identity.id;
    },
    async activate(indexId, now = T0) {
      await repository.markIdentityReady(indexId, now);
      // Tests deliberately activate partially-built identities to exercise the
      // degraded/not-ready states, so the readiness gate is opened explicitly.
      await repository.activateIdentity(indexId, now, {
        minVectorCount: 0,
        maxStaleDocuments: Number.MAX_SAFE_INTEGER,
        maxIncompatibleVectors: Number.MAX_SAFE_INTEGER,
      });
    },
    async seedEntity(input) {
      const indexId = input.indexId ?? defaultIndexId;
      const sourceUpdatedAt = input.sourceUpdatedAt ?? T1;
      const documentId = `doc-${indexId}-${input.entityType}-${input.entityId}`;
      const baseDocument = {
        id: documentId,
        indexId,
        entityType: input.entityType,
        entityId: input.entityId,
        title: input.title,
        body: input.body ?? '',
        keywords: [] as string[],
        metadata: input.metadata ?? {},
        projectionVersion: 1,
        sensitivity: 'standard' as const,
        retainUntil: null,
      };
      const write = await repository.upsertDocument({
        ...baseDocument,
        sourceRevision: `rev-${input.entityId}`,
        contentFingerprint: `fp-${input.entityId}`,
        sourceUpdatedAt,
        now: sourceUpdatedAt,
      });
      const stored = write.document!;
      await repository.upsertVector({
        id: `vec-${indexId}-${input.entityType}-${input.entityId}`,
        indexId,
        documentId: stored.id,
        documentVersion: stored.version,
        entityType: input.entityType,
        entityId: input.entityId,
        sourceRevision: stored.sourceRevision,
        contentFingerprint: stored.contentFingerprint,
        projectionVersion: 1,
        provider: input.provider ?? PROVIDER,
        model: input.model ?? MODEL,
        dimensions: input.embedding.length,
        sensitivity: 'standard',
        embedding: Float32Array.from(input.embedding),
        sourceUpdatedAt,
        embeddedAt: input.embeddedAt ?? sourceUpdatedAt,
        indexRunId: null,
        intentId: null,
        expiresAt: null,
        now: sourceUpdatedAt,
      });
      if (input.stale) {
        // The realistic drift: the document moved on to a newer revision and
        // the worker has not re-embedded it yet, so the vector now names an
        // older document version.
        await repository.upsertDocument({
          ...baseDocument,
          sourceRevision: `rev-${input.entityId}-next`,
          contentFingerprint: `fp-${input.entityId}-next`,
          sourceUpdatedAt: T2,
          now: T2,
        });
      }
    },
    close: () => db.close(),
  };
}
