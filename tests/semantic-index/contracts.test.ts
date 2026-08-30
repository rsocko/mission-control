import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_ENTITY_TYPES,
  SEMANTIC_INDEX_STATUSES,
  SEMANTIC_RUN_KINDS,
  SEMANTIC_SENSITIVITIES,
  SEMANTIC_TERMINAL_INTENT_STATUSES,
  SEMANTIC_WRITABLE_IDENTITY_STATUSES,
  isSemanticEntityType,
  isSemanticSensitivity,
  normalizeSemanticEntityType,
  semanticSensitivityRank,
} from '@/lib/semantic-index/contracts';
import {
  compareQueryResults,
  computeNorm,
  computeSemanticRetryAt,
  cosineSimilarity,
  identityDescriptor,
  isStaleSourceUpdate,
  normalizeMetadataFilters,
  parseEmbedding,
  resolveIntentFailureStatus,
  runProgress,
  serializeEmbedding,
} from '@/lib/semantic-index/validation';
import type {
  SemanticIndexIdentity,
  SemanticQueryResult,
  SemanticRun,
} from '@/lib/semantic-index/contracts';

describe('semantic index contracts', () => {
  it('covers every architecture-supported entity kind', () => {
    expect(SEMANTIC_ENTITY_TYPES).toEqual([
      'task',
      'project',
      'tag',
      'triage-item',
      'alert',
      'houston-summary',
    ]);
  });

  it('keeps the pre-existing "notification" name working as the canonical alert kind', () => {
    expect(normalizeSemanticEntityType('notification')).toBe('alert');
    expect(normalizeSemanticEntityType('alert')).toBe('alert');
    expect(normalizeSemanticEntityType(' task ')).toBe('task');
    expect(normalizeSemanticEntityType('Triage')).toBe('triage-item');
    expect(normalizeSemanticEntityType('unknown')).toBeNull();
    expect(isSemanticEntityType('notification')).toBe(false);
    expect(isSemanticEntityType('alert')).toBe(true);
  });

  it('orders sensitivity from most to least restrictive', () => {
    expect(SEMANTIC_SENSITIVITIES).toEqual(['local-only', 'restricted', 'standard']);
    expect(semanticSensitivityRank('local-only')).toBeLessThan(semanticSensitivityRank('restricted'));
    expect(semanticSensitivityRank('restricted')).toBeLessThan(semanticSensitivityRank('standard'));
    expect(isSemanticSensitivity('permanent')).toBe(false);
  });

  it('models identity states with exactly one servable state', () => {
    expect(SEMANTIC_INDEX_STATUSES).toEqual(['building', 'ready', 'active', 'retired', 'failed']);
    expect(SEMANTIC_WRITABLE_IDENTITY_STATUSES).toEqual(['building', 'ready', 'active']);
  });

  it('names the three run kinds and the four terminal intent states', () => {
    expect(SEMANTIC_RUN_KINDS).toEqual(['backfill', 'reconcile', 'cleanup']);
    expect(SEMANTIC_TERMINAL_INTENT_STATUSES).toEqual([
      'succeeded', 'failed', 'denied', 'expired',
    ]);
  });
});

describe('semantic index validation helpers', () => {
  it('round-trips an embedding and rejects corrupt payloads', () => {
    const embedding = new Float32Array([0.5, -0.25, 0]);
    expect(parseEmbedding(serializeEmbedding(embedding))).toEqual(embedding);
    expect(parseEmbedding('not json')).toBeNull();
    expect(parseEmbedding('[]')).toBeNull();
    expect(parseEmbedding('[1, null, 2]')).toBeNull();
    expect(parseEmbedding('[1, "2"]')).toBeNull();
    expect(parseEmbedding('{"a":1}')).toBeNull();
    // Already-deserialized values (PostgreSQL jsonb) work too.
    expect(parseEmbedding([1, 0, 0])).toEqual(new Float32Array([1, 0, 0]));
  });

  it('scores cosine similarity and refuses mismatched or degenerate vectors', () => {
    const query = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(query, 1, new Float32Array([1, 0, 0]), 1)).toBeCloseTo(1);
    expect(cosineSimilarity(query, 1, new Float32Array([0, 1, 0]), 1)).toBeCloseTo(0);
    expect(cosineSimilarity(query, 1, new Float32Array([1, 0]), 1)).toBe(0);
    expect(cosineSimilarity(query, 1, new Float32Array([0, 0, 0]), 0)).toBe(0);
    expect(computeNorm(new Float32Array([3, 4]))).toBeCloseTo(5);
  });

  it('treats only strictly older source updates as stale', () => {
    expect(isStaleSourceUpdate('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')).toBe(true);
    expect(isStaleSourceUpdate('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(false);
    expect(isStaleSourceUpdate('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(false);
    // An unparsable timestamp must not silently reject a legitimate write.
    expect(isStaleSourceUpdate('nonsense', '2026-01-01T00:00:00Z')).toBe(false);
  });

  it('backs off exponentially and caps the retry delay at fifteen minutes', () => {
    const now = '2026-01-01T00:00:00.000Z';
    expect(computeSemanticRetryAt(now, 1, 1_000)).toBe('2026-01-01T00:00:01.000Z');
    expect(computeSemanticRetryAt(now, 2, 1_000)).toBe('2026-01-01T00:00:02.000Z');
    expect(computeSemanticRetryAt(now, 3, 1_000)).toBe('2026-01-01T00:00:04.000Z');
    expect(computeSemanticRetryAt(now, 0, 1_000)).toBe('2026-01-01T00:00:01.000Z');
    expect(new Date(computeSemanticRetryAt(now, 30, 60_000)).getTime() - Date.parse(now))
      .toBe(15 * 60_000);
  });

  it('resolves intent failure statuses without consuming retries on a denial', () => {
    expect(resolveIntentFailureStatus({ attempt: 1, maxAttempts: 3 })).toBe('queued');
    expect(resolveIntentFailureStatus({ attempt: 3, maxAttempts: 3 })).toBe('failed');
    expect(resolveIntentFailureStatus({ attempt: 1, maxAttempts: 3, terminal: true })).toBe('failed');
    expect(resolveIntentFailureStatus({ attempt: 1, maxAttempts: 3, denied: true })).toBe('denied');
  });

  it('orders results by score, then kind, then normalized title, then id', () => {
    const result = (overrides: Partial<SemanticQueryResult>): SemanticQueryResult => ({
      id: 'id',
      entityType: 'task',
      entityId: 'entity',
      score: 0.5,
      title: 'Title',
      body: '',
      metadata: {},
      sourceRevision: 'rev',
      sourceUpdatedAt: '2026-01-01T00:00:00Z',
      embeddedAt: '2026-01-01T00:00:00Z',
      projectionVersion: 1,
      sensitivity: 'standard',
      provider: 'openai',
      model: 'm',
      ...overrides,
    });

    const ordered = [
      result({ id: 'e', score: 0.4 }),
      result({ id: 'd', title: 'beta' }),
      result({ id: 'c', title: 'Alpha' }),
      result({ id: 'b', entityType: 'project', title: 'Zeta' }),
      result({ id: 'a', entityType: 'project', title: 'Zeta' }),
      result({ id: 'f', score: 0.9 }),
    ].sort(compareQueryResults);

    expect(ordered.map((entry) => entry.id)).toEqual(['f', 'a', 'b', 'c', 'd', 'e']);
  });

  it('normalizes portable metadata filters and rejects unusable ones', () => {
    expect(normalizeMetadataFilters(undefined)).toEqual([]);
    expect(normalizeMetadataFilters([
      { keys: ['status', 'category'], match: 'none', values: ['DONE'], caseInsensitive: true },
    ])).toEqual([
      { keys: ['status', 'category'], match: 'none', values: ['done'], caseInsensitive: true },
    ]);

    const rejected: unknown[] = [
      [{ keys: [], match: 'any', values: ['x'] }],
      [{ keys: ['status'], match: 'any', values: [] }],
      [{ keys: ['status'], match: 'contains', values: ['x'] }],
      [{ keys: ['1status'], match: 'any', values: ['x'] }],
      [{ keys: ['status"'], match: 'any', values: ['x'] }],
      [{ keys: ['status'], match: 'any', values: [7] }],
      Array.from({ length: 9 }, () => ({ keys: ['status'], match: 'any', values: ['x'] })),
    ];
    for (const filters of rejected) {
      expect(() => normalizeMetadataFilters(filters as never))
        .toThrowError(expect.objectContaining({ code: 'invalid-argument' }));
    }
  });

  it('projects identities and runs to non-sensitive observability shapes', () => {
    const identity: SemanticIndexIdentity = {
      id: 'idx-1',
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 3,
      projectionVersion: 1,
      status: 'active',
      documentCount: 2,
      vectorCount: 2,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      readyAt: null,
      activatedAt: null,
      retiredAt: null,
      failureReason: 'provider exploded with secret detail',
    };
    expect(identityDescriptor(identity)).toEqual({
      id: 'idx-1',
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 3,
      projectionVersion: 1,
      status: 'active',
      documentCount: 2,
      vectorCount: 2,
    });

    const run: SemanticRun = {
      id: 'run-1',
      indexId: 'idx-1',
      kind: 'backfill',
      idempotencyKey: 'k',
      status: 'running',
      checkpoint: 'task:cursor',
      processedCount: 3,
      failedCount: 1,
      skippedCount: 0,
      attempt: 2,
      maxAttempts: 3,
      availableAt: '2026-01-01T00:00:00Z',
      leaseOwner: 'host-1:42',
      leaseExpiresAt: '2026-01-01T00:01:00Z',
      errorMessage: 'provider said something quotable',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:30Z',
      startedAt: '2026-01-01T00:00:10Z',
      completedAt: null,
    };
    const progress = runProgress(run);
    expect(progress).toMatchObject({ checkpoint: 'task:cursor', processedCount: 3, attempt: 2 });
    expect(JSON.stringify(progress)).not.toContain('host-1');
    expect(JSON.stringify(progress)).not.toContain('quotable');
  });
});
