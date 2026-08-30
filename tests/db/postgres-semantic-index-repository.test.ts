import { describe, expect, it, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import {
  POSTGRES_ANN_INDEX_PROVISION_TIMEOUT_MS,
  PostgresSemanticIndexRepository,
} from '@/db/postgres/semantic-index/repository';
import {
  computeSemanticRetryAt,
  supersededRunIdempotencyKey,
} from '@/lib/semantic-index/validation';
import type {
  SemanticDocumentWrite,
  SemanticIntentEnqueue,
  SemanticVectorWrite,
} from '@/lib/semantic-index/contracts';

const T0 = '2026-08-29T00:00:00.000Z';
const T1 = '2026-08-29T01:00:00.000Z';

interface Handler {
  match: RegExp;
  rows?: unknown[];
  rowCount?: number;
  times?: number;
}

interface MockPool {
  pool: Pool;
  statements: string[];
  params: unknown[][];
  /** Every statement, whitespace-collapsed, for readable assertions. */
  sql(): string[];
  find(pattern: RegExp): string | undefined;
}

/**
 * Minimal `pg.Pool` double. Handlers are matched in registration order; the
 * first one whose regex matches (and whose `times` budget is unspent) answers.
 * Anything unmatched returns an empty result, which keeps each test focused on
 * the statements it actually cares about.
 */
function createMockPool(handlers: Handler[] = []): MockPool {
  const statements: string[] = [];
  const params: unknown[][] = [];
  const budget = new Map<Handler, number>(handlers.map((handler) => [handler, handler.times ?? Infinity]));

  const query = async (text: string, values: unknown[] = []) => {
    statements.push(text);
    params.push(values);
    for (const handler of handlers) {
      const remaining = budget.get(handler) ?? 0;
      if (remaining <= 0) continue;
      if (!handler.match.test(text)) continue;
      budget.set(handler, remaining - 1);
      return {
        rows: handler.rows ?? [],
        rowCount: handler.rowCount ?? handler.rows?.length ?? 0,
      };
    }
    return { rows: [], rowCount: 0 };
  };

  const client = { query, release: () => undefined };
  const pool = { query, connect: async () => client } as unknown as Pool;

  return {
    pool,
    statements,
    params,
    sql: () => statements.map((statement) => statement.replace(/\s+/g, ' ').trim()),
    find(pattern: RegExp) {
      return this.sql().find((statement) => pattern.test(statement));
    },
  };
}

const IDENTITY = {
  id: 'idx-1',
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 3,
  projectionVersion: 1,
  status: 'building',
  documentCount: 0,
  vectorCount: 0,
  createdAt: T0,
  updatedAt: T0,
  readyAt: null,
  activatedAt: null,
  retiredAt: null,
  failureReason: null,
};

const identityHandler = (overrides: Record<string, unknown> = {}): Handler => ({
  match: /FROM semantic_index_identities\s+WHERE id = \$1/,
  rows: [{ ...IDENTITY, ...overrides }],
});

function makeDocument(overrides: Partial<SemanticDocumentWrite> = {}): SemanticDocumentWrite {
  return {
    id: 'doc-1',
    indexId: 'idx-1',
    entityType: 'task',
    entityId: 'task-1',
    title: 'Title',
    body: 'Body',
    keywords: ['a'],
    metadata: { status: 'todo' },
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
    indexRunId: null,
    intentId: null,
    expiresAt: null,
    now: T0,
    ...overrides,
  };
}

function makeIntent(overrides: Partial<SemanticIntentEnqueue> = {}): SemanticIntentEnqueue {
  return {
    id: 'intent-1',
    idempotencyKey: 'k1',
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

describe('PostgresSemanticIndexRepository', () => {
  let mock: MockPool;

  beforeEach(() => {
    mock = createMockPool();
  });

  describe('indexed identity lifecycle', () => {
    it('creates a dimension-specific HNSW index before marking an identity ready', async () => {
      mock = createMockPool([
        {
          match: /FROM semantic_index_identities\s+WHERE id = \$1/,
          rows: [{ ...IDENTITY, id: "idx-'quoted", dimensions: 1536 }],
        },
        { match: /UPDATE semantic_index_identities/, rowCount: 1 },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool, 5_000, {
        available: true,
        mode: 'required',
        extensionVersion: '0.8.6',
        maxDimensions: 4_000,
      });

      await expect(repo.markIdentityReady("idx-'quoted", T0)).resolves.toBe(true);

      const ddl = mock.find(/USING hnsw/);
      expect(ddl).toContain('embedding::halfvec(1536)');
      expect(ddl).toContain("index_id = 'idx-''quoted'");
      expect(ddl).toContain('dimensions = 1536');
      const statements = mock.sql();
      const timeoutIndex = statements.findIndex((sql) => /set_config\('statement_timeout'/.test(sql));
      const createIndex = statements.findIndex((sql) => /CREATE INDEX CONCURRENTLY/.test(sql));
      const unlockIndex = statements.findIndex((sql) => /pg_advisory_unlock/.test(sql));
      const resetIndex = statements.findIndex((sql) => /RESET statement_timeout/.test(sql));
      expect(mock.params[timeoutIndex]).toEqual([
        `${POSTGRES_ANN_INDEX_PROVISION_TIMEOUT_MS}ms`,
      ]);
      expect(timeoutIndex).toBeLessThan(createIndex);
      expect(statements.findIndex((sql) => /pg_advisory_lock/.test(sql)))
        .toBeLessThan(createIndex);
      expect(createIndex)
        .toBeLessThan(statements.findIndex((sql) => /UPDATE semantic_index_identities/.test(sql)));
      expect(unlockIndex).toBeLessThan(resetIndex);
      expect(statements).not.toContain('BEGIN');
    });

    it('rejects dimensions above the indexed limit in required mode', async () => {
      mock = createMockPool([identityHandler({ dimensions: 4_001 })]);
      const repo = new PostgresSemanticIndexRepository(mock.pool, 5_000, {
        available: true,
        mode: 'required',
        extensionVersion: '0.8.6',
        maxDimensions: 4_000,
      });

      await expect(repo.markIdentityReady('idx-1', T0))
        .rejects.toMatchObject({ code: 'invalid-argument' });
      expect(mock.find(/UPDATE semantic_index_identities/)).toBeUndefined();
    });
  });

  describe('intent queue claims', () => {
    it('claims atomically inside a transaction using FOR UPDATE SKIP LOCKED', async () => {
      mock = createMockPool([
        {
          match: /UPDATE semantic_intents\s+SET status = 'running'/,
          rows: [{
            id: 'i1',
            idempotencyKey: 'k1',
            indexId: 'idx-1',
            kind: 'upsert',
            entityType: 'task',
            entityId: 'task-1',
            sourceRevision: 'rev-1',
            contentFingerprint: 'fp-1',
            projectionVersion: 1,
            requestedAt: T0,
            status: 'running',
            attempt: 1,
            maxAttempts: 5,
            availableAt: T0,
            leaseOwner: 'worker-a',
            leaseExpiresAt: '2026-08-29T00:01:00.000Z',
            retryAfter: null,
            lastError: null,
            outcome: null,
            createdAt: T0,
            updatedAt: T0,
            completedAt: null,
          }],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      const claimed = await repo.claimIntents({
        indexId: 'idx-1', owner: 'worker-a', limit: 5, leaseMs: 60_000, now: T0,
      });

      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({ status: 'running', attempt: 1, leaseOwner: 'worker-a' });

      const claim = mock.find(/WITH candidates AS/);
      expect(claim).toBeDefined();
      expect(claim).toContain('FOR UPDATE SKIP LOCKED');
      expect(claim).toContain("status = 'queued' AND available_at <= $2");
      expect(claim).toContain('ORDER BY requested_at ASC, created_at ASC, id ASC');
      // The CTE aliases id so RETURNING is unambiguous under UPDATE ... FROM.
      expect(claim).toContain('SELECT id AS candidate_id');
      expect(mock.sql()).toContain('BEGIN');
      expect(mock.sql()).toContain('COMMIT');
    });

    it('recovers expired leases before claiming', async () => {
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await repo.claimIntents({
        indexId: 'idx-1', owner: 'worker-a', limit: 5, leaseMs: 60_000, now: T0,
      });
      const recovery = mock.find(/FROM semantic_intents WHERE status = 'running' AND lease_expires_at/);
      expect(recovery).toContain('FOR UPDATE SKIP LOCKED');
    });

    it('claims runs with SKIP LOCKED and refuses a second running run per kind', async () => {
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T0, indexId: 'idx-1', kinds: ['backfill'] });

      const claim = mock.find(/WITH candidate AS/);
      expect(claim).toContain('FOR UPDATE SKIP LOCKED');
      expect(claim).toContain('NOT EXISTS');
      expect(claim).toContain("active.status = 'running'");
      expect(claim).toContain('r.kind = ANY($3::text[])');
      expect(claim).toContain('SELECT r.id AS candidate_id');
    });
  });

  describe('run scheduling', () => {
    const existingRun = (overrides: Record<string, unknown>) => ({
      match: /FROM semantic_runs WHERE idempotency_key = \$1 FOR UPDATE/,
      rows: [{
        id: 'run-1', indexId: 'idx-1', kind: 'backfill', idempotencyKey: 'backfill:initial',
        status: 'succeeded', checkpoint: null, processedCount: 0, failedCount: 0,
        skippedCount: 0, attempt: 0, maxAttempts: 3, availableAt: T0, leaseOwner: null,
        leaseExpiresAt: null, errorMessage: null, createdAt: T0, updatedAt: T0,
        startedAt: null, completedAt: null,
        ...overrides,
      }],
    });

    const schedule = (repo: PostgresSemanticIndexRepository) => repo.createRun({
      id: 'run-2', indexId: 'idx-1', kind: 'backfill',
      idempotencyKey: 'backfill:initial', now: T1,
    });

    it('keeps the key when live or successfully completed work already owns it', async () => {
      for (const status of ['queued', 'running', 'succeeded', 'cancelled']) {
        mock = createMockPool([identityHandler(), existingRun({ status })]);
        const repo = new PostgresSemanticIndexRepository(mock.pool);

        expect(await schedule(repo), status).toMatchObject({
          status: 'existing', run: { id: 'run-1' },
        });
        expect(mock.find(/INSERT INTO semantic_runs/), status).toBeUndefined();
        expect(mock.find(/SET idempotency_key = \$1/), status).toBeUndefined();
      }
    });

    it('replaces a failed or expired run, moving it aside and resuming its checkpoint', async () => {
      for (const status of ['failed', 'expired']) {
        mock = createMockPool([
          identityHandler(),
          existingRun({ status, checkpoint: '{"kind":"task","after":"t-42"}', attempt: 3 }),
          {
            match: /INSERT INTO semantic_runs/,
            rows: [{ id: 'run-2', status: 'queued', attempt: 0 }],
          },
        ]);
        const repo = new PostgresSemanticIndexRepository(mock.pool);

        expect(await schedule(repo), status).toMatchObject({
          status: 'created', run: { id: 'run-2' },
        });
        // The terminal attempt is preserved under a superseded key rather than
        // deleted, so the failure stays auditable.
        const moved = mock.find(/SET idempotency_key = \$1/);
        expect(moved, status).toBeDefined();
        expect(mock.params.some((values) => values[0]
          === supersededRunIdempotencyKey('backfill:initial', 'run-1')), status).toBe(true);
        // The replacement resumes from where the failed run stopped.
        const insert = mock.sql().findIndex((sql) => sql.startsWith('INSERT INTO semantic_runs'));
        expect(mock.params[insert][4], status).toBe('{"kind":"task","after":"t-42"}');
      }
    });
  });

  describe('idempotent coalescing', () => {
    it('updates a queued row in place and never moves availableAt later', async () => {
      mock = createMockPool([
        identityHandler(),
        {
          match: /FROM semantic_intents\s+WHERE idempotency_key = \$1 AND status = 'queued'/,
          rows: [{ id: 'existing', requestedAt: T0, status: 'queued' }],
        },
        {
          match: /UPDATE semantic_intents\s+SET kind = \$1/,
          rows: [{ id: 'existing', status: 'queued', sourceRevision: 'rev-2' }],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      const result = await repo.enqueueIntent(makeIntent({
        id: 'intent-2', sourceRevision: 'rev-2', requestedAt: T1, now: T1,
      }));

      expect(result.status).toBe('coalesced');
      expect(mock.find(/UPDATE semantic_intents SET kind/)).toContain('LEAST(available_at, $8::text)');
      // No INSERT — the queued row is reused.
      expect(mock.find(/INSERT INTO semantic_intents/)).toBeUndefined();
    });

    it('ignores older work rather than regressing the queued row', async () => {
      mock = createMockPool([
        identityHandler(),
        {
          match: /FROM semantic_intents\s+WHERE idempotency_key = \$1 AND status = 'queued'/,
          rows: [{ id: 'existing', requestedAt: T1, sourceRevision: 'rev-2', status: 'queued' }],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      const result = await repo.enqueueIntent(makeIntent({ requestedAt: T0 }));
      expect(result.status).toBe('ignored');
      expect(result.intent.sourceRevision).toBe('rev-2');
      expect(mock.find(/UPDATE semantic_intents SET kind/)).toBeUndefined();
      expect(mock.find(/INSERT INTO semantic_intents/)).toBeUndefined();
    });

    it('adds a new queued row instead of mutating an in-flight attempt', async () => {
      mock = createMockPool([
        identityHandler(),
        {
          match: /WHERE idempotency_key = \$1 AND status = 'running' LIMIT 1/,
          rows: [{ id: 'running-1' }],
        },
        { match: /INSERT INTO semantic_intents/, rows: [{ id: 'intent-2', status: 'queued' }] },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      const result = await repo.enqueueIntent(makeIntent({ id: 'intent-2' }));
      expect(result.status).toBe('superseded');
      expect(mock.find(/INSERT INTO semantic_intents/)).toBeDefined();
    });
  });

  describe('write validation', () => {
    it('rejects a provider/model/dimension mismatch before touching semantic_vectors', async () => {
      mock = createMockPool([identityHandler()]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      await expect(repo.upsertVector(makeVector({ provider: 'azure' })))
        .rejects.toMatchObject({ code: 'provider-mismatch' });
      await expect(repo.upsertVector(makeVector({ model: 'other' })))
        .rejects.toMatchObject({ code: 'model-mismatch' });
      await expect(repo.upsertVector(makeVector({ dimensions: 1536 })))
        .rejects.toMatchObject({ code: 'dimension-mismatch' });
      await expect(repo.upsertVector(makeVector({ projectionVersion: 9 })))
        .rejects.toMatchObject({ code: 'projection-version-mismatch' });
      await expect(repo.upsertVector(makeVector({ embedding: new Float32Array([1, 0]) })))
        .rejects.toMatchObject({ code: 'dimension-mismatch' });
      await expect(repo.upsertVector(makeVector({
        embedding: new Float32Array([Number.NaN, 0, 0]),
      }))).rejects.toMatchObject({ code: 'invalid-embedding' });

      expect(mock.find(/INSERT INTO semantic_vectors/)).toBeUndefined();
      expect(mock.sql().filter((statement) => statement === 'ROLLBACK')).toHaveLength(6);
    });

    it('rejects writes against a retired identity', async () => {
      mock = createMockPool([identityHandler({ status: 'retired' })]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await expect(repo.upsertDocument(makeDocument()))
        .rejects.toMatchObject({ code: 'identity-not-writable' });
    });

    it('rejects a document whose projection version disagrees with the identity', async () => {
      mock = createMockPool([identityHandler()]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await expect(repo.upsertDocument(makeDocument({ projectionVersion: 2 })))
        .rejects.toMatchObject({ code: 'projection-version-mismatch' });
    });
  });

  describe('bounded document listing', () => {
    const SUMMARY_ROW = {
      id: 'doc-1',
      indexId: 'idx-1',
      entityType: 'task',
      entityId: 'task-1',
      version: 2,
      sourceRevision: 'rev-1',
      contentFingerprint: 'fp-1',
      projectionVersion: 1,
      sensitivity: 'standard',
      retainUntil: null,
      sourceUpdatedAt: T0,
      updatedAt: T0,
      deletedAt: null,
      vectorId: 'vec-1',
      vectorDocumentId: 'doc-1',
      vectorDocumentVersion: 2,
      vectorSourceRevision: 'rev-1',
      vectorContentFingerprint: 'fp-1',
      vectorProjectionVersion: 1,
      vectorProvider: 'openai',
      vectorModel: 'text-embedding-3-small',
      vectorDimensions: 3,
      vectorSensitivity: 'standard',
      vectorExpiresAt: null,
      vectorEmbeddedAt: T0,
    };

    it('left-joins the vector, orders by entity id, and bounds the page', async () => {
      mock = createMockPool([
        { match: /FROM semantic_documents d\s+LEFT JOIN semantic_vectors v/, rows: [SUMMARY_ROW] },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      const results = await repo.listDocuments({
        indexId: 'idx-1', entityType: 'task', afterEntityId: 'task-0', limit: 25,
      });

      const statement = mock.find(/FROM semantic_documents d LEFT JOIN semantic_vectors v/)!;
      expect(statement).toContain('ORDER BY d.entity_id ASC');
      expect(statement).toContain('LIMIT $5');
      expect(statement).toContain('d.entity_id > $3');
      expect(mock.params[0]).toEqual(['idx-1', 'task', 'task-0', false, 25]);
      // The embedding column is never selected: reconciliation must not stream
      // vector payloads through a bounded scan.
      expect(statement).not.toMatch(/v\.embedding/);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ entityId: 'task-1', version: 2 });
      expect(results[0].vector).toMatchObject({
        id: 'vec-1', documentVersion: 2, provider: 'openai', dimensions: 3,
      });
    });

    it('starts from the beginning and excludes tombstones by default', async () => {
      mock = createMockPool();
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await repo.listDocuments({ indexId: 'idx-1', entityType: 'alert', limit: 10 });
      expect(mock.params[0]).toEqual(['idx-1', 'alert', '', false, 10]);
      expect(mock.find(/FROM semantic_documents d/)).toContain('d.deleted_at IS NULL');
    });

    it('includes tombstones when asked', async () => {
      mock = createMockPool();
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await repo.listDocuments({
        indexId: 'idx-1', entityType: 'task', limit: 10, includeDeleted: true,
      });
      expect(mock.params[0][3]).toBe(true);
    });

    it('reports a missing vector as null', async () => {
      mock = createMockPool([
        {
          match: /FROM semantic_documents d\s+LEFT JOIN semantic_vectors v/,
          rows: [{
            ...SUMMARY_ROW,
            vectorId: null,
            vectorDocumentId: null,
            vectorDocumentVersion: null,
            vectorSourceRevision: null,
            vectorContentFingerprint: null,
            vectorProjectionVersion: null,
            vectorProvider: null,
            vectorModel: null,
            vectorDimensions: null,
            vectorSensitivity: null,
            vectorExpiresAt: null,
            vectorEmbeddedAt: null,
          }],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      const [summary] = await repo.listDocuments({
        indexId: 'idx-1', entityType: 'task', limit: 10,
      });
      expect(summary.vector).toBeNull();
    });

    it('rejects a non-positive limit before issuing a query', async () => {
      mock = createMockPool();
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await expect(repo.listDocuments({ indexId: 'idx-1', entityType: 'task', limit: 0 }))
        .rejects.toMatchObject({ code: 'invalid-argument' });
      expect(mock.statements).toHaveLength(0);
    });
  });

  describe('conditional writes', () => {
    it('refuses a vector whose document version was superseded', async () => {
      mock = createMockPool([
        identityHandler(),
        {
          match: /FROM semantic_documents\s+WHERE id = \$1 AND index_id = \$2/,
          rows: [{
            id: 'doc-1', entityType: 'task', entityId: 'task-1',
            version: 2, sourceRevision: 'rev-2', deletedAt: null,
          }],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      expect(await repo.upsertVector(makeVector({ documentVersion: 1, sourceRevision: 'rev-1' })))
        .toEqual({ status: 'stale', reason: 'document-superseded' });
      expect(mock.find(/INSERT INTO semantic_vectors/)).toBeUndefined();
    });

    it('refuses a vector for a tombstoned or missing document', async () => {
      mock = createMockPool([
        identityHandler(),
        {
          match: /FROM semantic_documents\s+WHERE id = \$1 AND index_id = \$2/,
          rows: [{
            id: 'doc-1', entityType: 'task', entityId: 'task-1',
            version: 1, sourceRevision: 'rev-1', deletedAt: T1,
          }],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      expect(await repo.upsertVector(makeVector()))
        .toEqual({ status: 'stale', reason: 'document-missing' });
    });

    it('refuses an older source update over a newer stored document', async () => {
      mock = createMockPool([
        identityHandler(),
        {
          match: /FROM semantic_documents\s+WHERE index_id = \$1 AND entity_type = \$2/,
          rows: [{
            id: 'doc-1', indexId: 'idx-1', entityType: 'task', entityId: 'task-1', version: 3,
            title: 'Newer', body: 'Newer', keywords: [], metadata: {},
            sourceRevision: 'rev-9', contentFingerprint: 'fp-9', projectionVersion: 1,
            sensitivity: 'standard', retainUntil: null, sourceUpdatedAt: T1,
            createdAt: T0, updatedAt: T1, deletedAt: null,
          }],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      const result = await repo.upsertDocument(makeDocument({ sourceUpdatedAt: T0 }));
      expect(result).toMatchObject({ status: 'stale', reason: 'older-source-update' });
      expect(result.document?.sourceRevision).toBe('rev-9');
      expect(mock.find(/UPDATE semantic_documents SET version = version \+ 1/)).toBeUndefined();
    });

    it('reports an identical document rewrite as unchanged', async () => {
      const stored = {
        id: 'doc-1', indexId: 'idx-1', entityType: 'task', entityId: 'task-1', version: 1,
        title: 'Title', body: 'Body', keywords: ['a'], metadata: { status: 'todo' },
        sourceRevision: 'rev-1', contentFingerprint: 'fp-1', projectionVersion: 1,
        sensitivity: 'standard', retainUntil: null, sourceUpdatedAt: T0,
        createdAt: T0, updatedAt: T0, deletedAt: null,
      };
      mock = createMockPool([
        identityHandler(),
        { match: /FROM semantic_documents\s+WHERE index_id = \$1 AND entity_type = \$2/, rows: [stored] },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      expect((await repo.upsertDocument(makeDocument())).status).toBe('unchanged');
      expect(mock.find(/UPDATE semantic_documents SET version/)).toBeUndefined();
    });

    it('treats jsonb metadata returned in a different key order as unchanged', async () => {
      // `jsonb` does not preserve key order, so the row comes back ordered by
      // PostgreSQL's own rules rather than the projection's. Comparing bytes
      // would report every no-op rewrite as a change: the version would climb
      // on every reconciliation pass and mark the entity's vector stale.
      const stored = {
        id: 'doc-1', indexId: 'idx-1', entityType: 'task', entityId: 'task-1', version: 1,
        title: 'Title', body: 'Body', keywords: ['a', 'b'],
        metadata: { status: 'todo', connectorType: 'github-issues', effort: 3 },
        sourceRevision: 'rev-1', contentFingerprint: 'fp-1', projectionVersion: 1,
        sensitivity: 'standard', retainUntil: null, sourceUpdatedAt: T0,
        createdAt: T0, updatedAt: T0, deletedAt: null,
      };
      mock = createMockPool([
        identityHandler(),
        { match: /FROM semantic_documents\s+WHERE index_id = \$1 AND entity_type = \$2/, rows: [stored] },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      const result = await repo.upsertDocument(makeDocument({
        keywords: ['a', 'b'],
        metadata: { connectorType: 'github-issues', effort: 3, status: 'todo' },
      }));
      expect(result.status).toBe('unchanged');
      expect(result.document?.version).toBe(1);
      expect(mock.find(/UPDATE semantic_documents SET version/)).toBeUndefined();
    });

    it('still rewrites when the metadata genuinely differs or a keyword moves', async () => {
      const stored = {
        id: 'doc-1', indexId: 'idx-1', entityType: 'task', entityId: 'task-1', version: 1,
        title: 'Title', body: 'Body', keywords: ['a', 'b'], metadata: { status: 'todo' },
        sourceRevision: 'rev-1', contentFingerprint: 'fp-1', projectionVersion: 1,
        sensitivity: 'standard', retainUntil: null, sourceUpdatedAt: T0,
        createdAt: T0, updatedAt: T0, deletedAt: null,
      };
      const withStored = (overrides: Partial<SemanticDocumentWrite>) => {
        mock = createMockPool([
          identityHandler(),
          { match: /FROM semantic_documents\s+WHERE index_id = \$1 AND entity_type = \$2/, rows: [stored] },
          { match: /UPDATE semantic_documents\s+SET version = version \+ 1/, rows: [{ ...stored, version: 2 }] },
        ]);
        return new PostgresSemanticIndexRepository(mock.pool)
          .upsertDocument(makeDocument({ keywords: ['a', 'b'], ...overrides }));
      };

      expect((await withStored({ metadata: { status: 'done' } })).status).toBe('updated');
      // Keyword order is meaningful, so a reordered array is a real change.
      expect((await withStored({ keywords: ['b', 'a'], metadata: { status: 'todo' } })).status)
        .toBe('updated');
    });
  });

  describe('identity lifecycle', () => {
    it('rejects cutover from a non-ready identity without issuing an activation update', async () => {
      mock = createMockPool([identityHandler({ status: 'building' })]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      expect(await repo.activateIdentity('idx-1', T1)).toMatchObject({
        status: 'rejected', reason: 'identity-not-ready',
      });
      expect(mock.find(/SET status = 'active'/)).toBeUndefined();
      // A rejection is a normal outcome, not an error: the transaction commits
      // having changed nothing.
      expect(mock.sql()).toContain('COMMIT');
    });

    it('rejects cutover when the readiness gate fails on stale documents', async () => {
      mock = createMockPool([
        identityHandler({ status: 'ready', vectorCount: 10 }),
        { match: /LEFT JOIN semantic_vectors/, rows: [{ count: '4' }] },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      expect(await repo.activateIdentity('idx-1', T1)).toMatchObject({
        status: 'rejected', reason: 'gate-stale-documents',
      });
      expect(mock.find(/SET status = 'active'/)).toBeUndefined();
    });

    it('demotes the former active to ready and promotes the target inside one transaction', async () => {
      mock = createMockPool([
        identityHandler({ status: 'ready', vectorCount: 10 }),
        { match: /LEFT JOIN semantic_vectors/, rows: [{ count: '0' }] },
        { match: /INNER JOIN semantic_index_identities i ON i\.id = v\.index_id/, rows: [{ count: '0' }] },
        { match: /WHERE status = 'active' LIMIT 1 FOR UPDATE/, rows: [{ id: 'idx-old' }] },
        { match: /SET status = 'ready', updated_at = \$1/, rowCount: 1 },
        { match: /SET status = 'active', activated_at = \$1/, rowCount: 1 },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      expect(await repo.activateIdentity('idx-1', T1)).toEqual({
        status: 'activated', activatedId: 'idx-1', previousActiveId: 'idx-old',
      });

      const sql = mock.sql();
      expect(sql).toContain('BEGIN');
      expect(sql).toContain('COMMIT');
      expect(sql.indexOf('BEGIN')).toBeLessThan(
        sql.findIndex((statement) => statement.includes("SET status = 'active'")),
      );
      expect(mock.find(/SET status = 'ready', updated_at = \$1/))
        .toContain("WHERE id = $2 AND status = 'active'");
    });

    it('refuses to retire or fail the active identity via the SQL guard', async () => {
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await repo.retireIdentity('idx-1', T1);
      await repo.markIdentityFailed('idx-1', 'boom', T1);

      expect(mock.find(/SET status = 'retired'/))
        .toContain("status IN ('building', 'ready', 'failed')");
      expect(mock.find(/SET status = 'failed'/))
        .toContain("status IN ('building', 'ready')");
    });

    it('rolls back only to a ready identity holding compatible vectors', async () => {
      mock = createMockPool([
        { match: /WHERE status = 'active' LIMIT 1 FOR UPDATE/, rows: [{ id: 'idx-new' }] },
        { match: /FROM semantic_index_identities\s+WHERE id = \$1 FOR UPDATE/, rows: [{ ...IDENTITY, status: 'ready', vectorCount: 0 }] },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      expect(await repo.rollbackToIdentity('idx-1', T1)).toMatchObject({
        status: 'rejected', reason: 'incompatible-identity', previousActiveId: 'idx-new',
      });
      expect(mock.find(/SET status = 'active'/)).toBeUndefined();
    });

    it('cleans up only identities eligible before the cutoff', async () => {
      mock = createMockPool([
        {
          match: /FROM semantic_index_identities\s+WHERE status IN \('retired', 'failed'\)/,
          rows: [
            { id: 'old', eligibleAt: T0 },
            { id: 'recent', eligibleAt: '2026-08-30T00:00:00.000Z' },
          ],
        },
        { match: /SELECT status FROM semantic_index_identities WHERE id = \$1/, rows: [{ status: 'retired' }] },
        { match: /DELETE FROM semantic_vectors WHERE index_id/, rowCount: 3 },
        { match: /DELETE FROM semantic_documents WHERE index_id/, rowCount: 2 },
        { match: /DELETE FROM semantic_intents WHERE index_id/, rowCount: 1 },
        { match: /DELETE FROM semantic_runs WHERE index_id/, rowCount: 1 },
        { match: /DELETE FROM semantic_index_identities WHERE id = \$1/, rowCount: 1 },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      const result = await repo.cleanupIdentities({ before: T1, now: T1 });
      expect(result).toEqual({
        identitiesRemoved: 1,
        documentsRemoved: 2,
        vectorsRemoved: 3,
        intentsRemoved: 1,
        runsRemoved: 1,
        skippedIds: ['recent'],
      });
      expect(mock.find(/DELETE FROM semantic_index_identities WHERE id = \$1/))
        .toContain("status IN ('retired', 'failed')");
      expect(mock.params.some((values) => values.includes('recent'))).toBe(false);
    });
  });

  describe('query', () => {
    const vectorRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'vec-1',
      entityType: 'task',
      entityId: 'task-1',
      embedding: '[1,0,0]',
      norm: '1',
      dimensions: 3,
      projectionVersion: 1,
      sensitivity: 'standard',
      provider: 'openai',
      model: 'text-embedding-3-small',
      sourceRevision: 'rev-1',
      sourceUpdatedAt: T0,
      embeddedAt: T0,
      title: 'Title',
      body: 'Body',
      metadata: { status: 'todo' },
      ...overrides,
    });

    it('refuses to query a non-active, non-ready identity', async () => {
      mock = createMockPool([identityHandler({ status: 'building' })]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await expect(repo.queryVectors({
        indexId: 'idx-1', queryEmbedding: new Float32Array([1, 0, 0]), limit: 5,
      })).rejects.toMatchObject({ code: 'identity-not-queryable' });
    });

    it('validates the query embedding against the active identity dimensions', async () => {
      mock = createMockPool([
        { match: /WHERE status = 'active' LIMIT 1/, rows: [{ ...IDENTITY, status: 'active' }] },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await expect(repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0]), limit: 5,
      })).rejects.toMatchObject({ code: 'dimension-mismatch' });
    });

    it('returns an explicit empty response when nothing is active', async () => {
      const repo = new PostgresSemanticIndexRepository(mock.pool, 42);
      const response = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]), limit: 5,
      });
      expect(response).toEqual({
        identityId: null,
        results: [],
        scan: {
          kind: 'bounded-in-process',
          candidatesScanned: 0,
          candidateCeiling: 42,
          guaranteesFullRecall: false,
          guaranteedScale: 42,
          truncated: false,
        },
      });
    });

    it('skips incompatible rows, breaks ties deterministically, and reports truncation', async () => {
      mock = createMockPool([
        { match: /WHERE status = 'active' LIMIT 1/, rows: [{ ...IDENTITY, status: 'active' }] },
        {
          match: /FROM semantic_vectors v\s+INNER JOIN semantic_documents d/,
          rows: [
            vectorRow({ id: 'v-b', entityId: 'b', title: 'Beta' }),
            vectorRow({ id: 'v-a', entityId: 'a', title: 'alpha' }),
            vectorRow({ id: 'v-project', entityId: 'p', entityType: 'project', title: 'Zeta' }),
            // Incompatible: different vector space, must never be scored.
            vectorRow({ id: 'v-wrong-dim', entityId: 'x', dimensions: 1536 }),
            vectorRow({ id: 'v-wrong-projection', entityId: 'y', projectionVersion: 2 }),
            vectorRow({ id: 'v-corrupt', entityId: 'z', embedding: 'not json' }),
          ],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool, 5);

      const response = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]), limit: 10, now: T1,
      });

      expect(response.identityId).toBe('idx-1');
      expect(response.results.map((result) => result.entityId)).toEqual(['p', 'a', 'b']);
      expect(response.scan).toEqual({
        kind: 'bounded-in-process',
        candidatesScanned: 5,
        candidateCeiling: 5,
        guaranteesFullRecall: false,
        guaranteedScale: 5,
        truncated: true,
      });

      const scan = mock.find(/FROM semantic_vectors v INNER JOIN semantic_documents d/);
      expect(scan).toContain('d.deleted_at IS NULL');
      expect(scan).toContain('v.expires_at IS NULL OR v.expires_at > $2');
      expect(scan).toContain('d.retain_until IS NULL OR d.retain_until > $2');
    });

    it('uses HNSW candidates with filters and exact reranking when available', async () => {
      mock = createMockPool([
        { match: /WHERE status = 'active' LIMIT 1/, rows: [{ ...IDENTITY, status: 'active' }] },
        { match: /SELECT to_regclass/, rows: [{ present: true }] },
        {
          match: /WITH nearest AS MATERIALIZED/,
          rows: [
            vectorRow({ id: 'v-near', entityId: 'near', embedding: '[1,0,0]' }),
            vectorRow({ id: 'v-far', entityId: 'far', embedding: '[0,0,1]' }),
          ],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool, 5, {
        available: true,
        mode: 'required',
        extensionVersion: '0.8.6',
        maxDimensions: 4_000,
      });

      const response = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 5,
        entityTypes: ['task'],
        metadataFilters: [{
          keys: ['status'],
          match: 'any',
          values: ['todo'],
          caseInsensitive: true,
        }],
        now: T1,
      });

      expect(response.results.map((result) => result.entityId)).toEqual(['near', 'far']);
      expect(response.scan).toMatchObject({
        kind: 'postgres-hnsw',
        candidateCeiling: 200,
        extensionVersion: '0.8.6',
        guaranteedScale: 100_000,
      });
      const ann = mock.find(/WITH nearest AS MATERIALIZED/);
      expect(ann).toContain('a.embedding::halfvec(3)');
      expect(ann).toContain("a.index_id = 'idx-1'");
      expect(ann).toContain('LOWER(a.metadata ->>');
      expect(ann).toContain('v.document_version = d.version');
      expect(mock.find(/SET LOCAL enable_seqscan/)).toContain('off');
      expect(mock.find(/SET LOCAL enable_sort/)).toContain('off');
      expect(mock.find(/SET LOCAL hnsw.iterative_scan/)).toContain('strict_order');
    });

    it('binds entity-kind and sensitivity filters as arrays', async () => {
      mock = createMockPool([
        { match: /WHERE status = 'active' LIMIT 1/, rows: [{ ...IDENTITY, status: 'active' }] },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 5,
        entityTypes: ['task', 'alert'],
        sensitivities: ['standard'],
        now: T1,
      });

      const scan = mock.find(/FROM semantic_vectors v INNER JOIN semantic_documents d/);
      expect(scan).toContain('v.entity_type = ANY($3::text[])');
      expect(scan).toContain('v.sensitivity = ANY($4::text[])');
      const values = mock.params[mock.params.length - 1];
      expect(values[2]).toEqual(['task', 'alert']);
      expect(values[3]).toEqual(['standard']);
    });

    it('pushes portable metadata predicates and exclusions into SQL', async () => {
      mock = createMockPool([
        { match: /WHERE status = 'active' LIMIT 1/, rows: [{ ...IDENTITY, status: 'active' }] },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 5,
        excludeEntityIds: ['self'],
        metadataFilters: [
          { keys: ['sourceListName', 'connectorType'], match: 'any', values: ['Project Alpha'] },
          { keys: ['status', 'category'], match: 'none', values: ['DONE'], caseInsensitive: true },
        ],
        now: T1,
      });

      const scan = mock.find(/FROM semantic_vectors v INNER JOIN semantic_documents d/);
      expect(scan).toContain('NOT (v.entity_id = ANY($3::text[]))');
      expect(scan).toContain("d.metadata ->> $4 = ANY($5::text[]) OR d.metadata ->> $6 = ANY($7::text[])");
      // The exclusion branch must keep rows whose metadata simply lacks the key.
      expect(scan).toContain('LOWER(d.metadata ->> $8) IS NULL');
      expect(scan).toContain('NOT (LOWER(d.metadata ->> $8) = ANY($9::text[]))');
      const values = mock.params[mock.params.length - 1];
      expect(values.slice(2, 10)).toEqual([
        ['self'],
        'sourceListName', ['Project Alpha'],
        'connectorType', ['Project Alpha'],
        'status', ['done'],
        'category',
      ]);
      // Case-insensitive filters compare lower-cased values on both sides.
      expect(values[10]).toEqual(['done']);
    });

    it('rejects metadata keys that are not plain identifiers', async () => {
      mock = createMockPool([
        { match: /WHERE status = 'active' LIMIT 1/, rows: [{ ...IDENTITY, status: 'active' }] },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await expect(repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]),
        limit: 5,
        metadataFilters: [{ keys: ['status"; DROP TABLE'], match: 'any', values: ['x'] }],
      })).rejects.toMatchObject({ code: 'invalid-argument' });
    });

    it('returns projected metadata and the vector freshness stamp', async () => {
      mock = createMockPool([
        { match: /WHERE status = 'active' LIMIT 1/, rows: [{ ...IDENTITY, status: 'active' }] },
        {
          match: /FROM semantic_vectors v\s+INNER JOIN semantic_documents d/,
          rows: [vectorRow({ embeddedAt: T1, metadata: { status: 'todo', priority: 'high' } })],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      const response = await repo.queryVectors({
        queryEmbedding: new Float32Array([1, 0, 0]), limit: 5, now: T1,
      });

      expect(response.results[0]).toMatchObject({
        embeddedAt: T1,
        metadata: { status: 'todo', priority: 'high' },
      });
    });
  });

  describe('failure handling', () => {
    it('retries with backoff while attempts remain and fails permanently afterwards', async () => {
      const running = {
        id: 'i1', idempotencyKey: 'k1', attempt: 1, maxAttempts: 3, status: 'running',
      };
      mock = createMockPool([
        { match: /FROM semantic_intents\s+WHERE id = \$1 AND status = 'running'/, rows: [running] },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      expect(await repo.failIntent({
        id: 'i1', owner: 'w', error: 'boom', now: T0, retryAfter: T1,
      })).toBe('queued');
      expect(mock.find(/SET status = 'queued', available_at/)).toBeDefined();
      expect(mock.params.some((values) => values[0] === T1)).toBe(true);

      mock = createMockPool([
        {
          match: /FROM semantic_intents\s+WHERE id = \$1 AND status = 'running'/,
          rows: [{ ...running, attempt: 3 }],
        },
      ]);
      const exhausted = new PostgresSemanticIndexRepository(mock.pool);
      expect(await exhausted.failIntent({ id: 'i1', owner: 'w', error: 'boom', now: T0 }))
        .toBe('failed');
      expect(mock.params.some((values) => values.includes('permanent-failure'))).toBe(true);
    });

    it('expires a recovered attempt superseded by newer queued work', async () => {
      mock = createMockPool([
        {
          match: /FROM semantic_intents\s+WHERE id = \$1 AND status = 'running'/,
          rows: [{ id: 'i1', idempotencyKey: 'k1', attempt: 1, maxAttempts: 3, status: 'running' }],
        },
        {
          match: /WHERE idempotency_key = \$1 AND status = 'queued' AND id <> \$2/,
          rows: [{ id: 'i2' }],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      expect(await repo.failIntent({ id: 'i1', owner: 'w', error: 'boom', now: T0 })).toBe('expired');
      expect(mock.find(/SET status = 'expired', outcome = 'superseded'/)).toBeDefined();
    });

    it('claims a run without spending an attempt', async () => {
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await repo.claimRun({ owner: 'w', leaseMs: 60_000, now: T0, indexId: 'idx-1' });

      const claim = mock.find(/WITH candidate AS/)!;
      // A yielded-and-reclaimed slice must not consume the retry budget, so the
      // claim leaves `attempt` alone.
      expect(claim).toContain("SET status = 'running'");
      expect(claim).not.toContain('attempt = attempt + 1');
    });

    it('increments the run attempt atomically with the failure it records', async () => {
      const running = {
        id: 'r1', idempotencyKey: 'k1', attempt: 0, maxAttempts: 3, status: 'running',
      };
      mock = createMockPool([
        { match: /FROM semantic_runs\s+WHERE id = \$1 AND status = 'running'/, rows: [running] },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      expect(await repo.failRun({ id: 'r1', owner: 'w', error: 'boom', now: T0 })).toBe('queued');
      const requeue = mock.find(/SET status = 'queued', attempt = \$1/)!;
      expect(requeue).toBeDefined();
      const values = mock.params[mock.sql().indexOf(requeue)];
      // The incremented failure count is both persisted and used for backoff.
      expect(values[0]).toBe(1);
      expect(values[1]).toBe(computeSemanticRetryAt(T0, 1));

      mock = createMockPool([
        {
          match: /FROM semantic_runs\s+WHERE id = \$1 AND status = 'running'/,
          rows: [{ ...running, attempt: 2 }],
        },
      ]);
      const exhausted = new PostgresSemanticIndexRepository(mock.pool);
      expect(await exhausted.failRun({ id: 'r1', owner: 'w', error: 'boom', now: T0 }))
        .toBe('failed');
      expect(mock.find(/SET status = 'failed', attempt = \$1/)).toBeDefined();
      expect(mock.params.some((values) => values[0] === 3)).toBe(true);
    });

    it('spends one attempt per abandoned run lease and expires when the budget is gone', async () => {
      mock = createMockPool([
        {
          match: /FROM semantic_runs\s+WHERE status = 'running' AND lease_expires_at/,
          rows: [
            { id: 'r1', attempt: 0, maxAttempts: 3, status: 'running' },
            { id: 'r2', attempt: 2, maxAttempts: 3, status: 'running' },
          ],
        },
        { match: /SET status = 'queued', attempt = \$1/, rowCount: 1 },
        { match: /SET status = 'expired', attempt = \$1/, rowCount: 1 },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      expect(await repo.recoverExpiredRunLeases(T1)).toEqual({ requeued: 1, expired: 1 });
      expect(mock.params.some((values) => values[0] === 1
        && values[1] === computeSemanticRetryAt(T1, 1))).toBe(true);
      expect(mock.params.some((values) => values[0] === 3 && values[1] === T1)).toBe(true);
    });

    it('returns null when the caller does not hold the lease', async () => {
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      expect(await repo.failIntent({ id: 'i1', owner: 'w', error: 'boom', now: T0 })).toBeNull();
      expect(await repo.failRun({ id: 'r1', owner: 'w', error: 'boom', now: T0 })).toBeNull();
    });

    it('scopes lease renewal, completion, and release to the holding owner', async () => {
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      await repo.renewIntentLease({ id: 'i1', owner: 'w', leaseMs: 1_000, now: T0 });
      await repo.completeIntent({ id: 'i1', owner: 'w', now: T0 });
      await repo.renewRunLease({ id: 'r1', owner: 'w', leaseMs: 1_000, now: T0 });
      await repo.releaseRun({ id: 'r1', owner: 'w', now: T0 });
      await repo.checkpointRun({ id: 'r1', owner: 'w', now: T0, checkpoint: 'c' });

      for (const statement of mock.sql().filter((sql) => sql.startsWith('UPDATE'))) {
        expect(statement, statement).toContain('lease_owner = $');
      }
      expect(mock.find(/UPDATE semantic_intents SET lease_expires_at/))
        .toContain("status = 'running'");
      expect(mock.find(/UPDATE semantic_runs SET checkpoint = COALESCE/))
        .toContain("status = 'running'");
    });
  });

  describe('observability', () => {
    it('converts bigint count strings and reports queue plus run metrics', async () => {
      mock = createMockPool([
        identityHandler({ status: 'active', documentCount: 7, vectorCount: 5 }),
        {
          match: /SELECT status, COUNT\(\*\) AS count FROM semantic_intents/,
          rows: [
            { status: 'queued', count: '3' },
            { status: 'running', count: '1' },
            { status: 'failed', count: '2' },
            { status: 'denied', count: '1' },
            { status: 'expired', count: '4' },
          ],
        },
        {
          match: /AS retrying/,
          rows: [{ retrying: '2', totalRetries: '5' }],
        },
        {
          match: /MIN\(created_at\) FILTER/,
          rows: [{ queued: T0, running: T0 }],
        },
        {
          match: /SELECT status, COUNT\(\*\) AS count FROM semantic_runs/,
          rows: [{ status: 'queued', count: '1' }, { status: 'succeeded', count: '9' }],
        },
        {
          match: /FROM semantic_documents\s+WHERE index_id = \$1 AND deleted_at IS NULL\s+GROUP BY/,
          rows: [{ entityType: 'task', count: '7' }],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      const metrics = await repo.getMetrics('idx-1', T1);
      expect(metrics.identityStatus).toBe('active');
      expect(metrics.documentCount).toBe(7);
      expect(metrics.intents).toMatchObject({
        queued: 3,
        running: 1,
        retrying: 2,
        totalRetries: 5,
        failed: 2,
        denied: 1,
        expired: 4,
        permanentFailures: 7,
        oldestQueuedAgeMs: 60 * 60 * 1000,
      });
      expect(metrics.runs).toMatchObject({ queued: 1, succeeded: 9, running: 0 });
      expect(metrics.byEntityType).toHaveLength(6);
      expect(metrics.byEntityType.find((entry) => entry.entityType === 'task'))
        .toMatchObject({ documents: 7 });
    });

    it('reports readiness by entity kind for the active identity', async () => {
      mock = createMockPool([
        {
          match: /WHERE status = 'active' LIMIT 1/,
          rows: [{ ...IDENTITY, status: 'active', documentCount: 2, vectorCount: 2 }],
        },
        { match: /WHERE status = \$1\s+ORDER BY COALESCE/, rows: [{ ...IDENTITY, id: 'idx-old', status: 'ready' }] },
        {
          match: /FROM semantic_documents\s+WHERE index_id = \$1 AND deleted_at IS NULL\s+GROUP BY/,
          rows: [{ entityType: 'task', count: '2' }],
        },
        {
          match: /FROM semantic_vectors\s+WHERE index_id = \$1\s+GROUP BY/,
          rows: [{ entityType: 'task', count: '2' }],
        },
      ]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      const readiness = await repo.getReadiness(T1);
      expect(readiness).toMatchObject({
        available: true,
        activeIdentityId: 'idx-1',
        provider: 'openai',
        dimensions: 3,
        readyIdentityIds: ['idx-old'],
      });
      expect(readiness.byEntityType.find((entry) => entry.entityType === 'task'))
        .toMatchObject({ documents: 2, vectors: 2, stale: 0, incompatible: 0, expired: 0 });
    });

    it('reports unavailable readiness when nothing is active', async () => {
      const repo = new PostgresSemanticIndexRepository(mock.pool);
      const readiness = await repo.getReadiness(T1);
      expect(readiness).toMatchObject({
        available: false, activeIdentityId: null, documentCount: 0, readyIdentityIds: [],
      });
      expect(readiness.byEntityType).toHaveLength(6);
    });
  });

  describe('transaction discipline', () => {
    it('rolls back and rethrows when a statement inside a transaction fails', async () => {
      const statements: string[] = [];
      const failing = {
        query: async (text: string) => {
          statements.push(text.replace(/\s+/g, ' ').trim());
          if (text.includes('FROM semantic_index_identities')) throw new Error('connection reset');
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      };
      const pool = { connect: async () => failing, query: failing.query } as unknown as Pool;
      const repo = new PostgresSemanticIndexRepository(pool);

      await expect(repo.upsertDocument(makeDocument())).rejects.toThrow('connection reset');
      expect(statements).toContain('BEGIN');
      expect(statements).toContain('ROLLBACK');
      expect(statements).not.toContain('COMMIT');
    });

    it('wraps every multi-step write in a transaction', async () => {
      mock = createMockPool([identityHandler()]);
      const repo = new PostgresSemanticIndexRepository(mock.pool);

      await repo.deleteDocument({ indexId: 'idx-1', entityType: 'task', entityId: 't1', now: T0 });
      await repo.deleteVector('idx-1', 'task', 't1');
      await repo.expireDocuments({ now: T0 });
      await repo.purgeDeletedDocuments({ before: T0 });

      const begins = mock.sql().filter((statement) => statement === 'BEGIN');
      const commits = mock.sql().filter((statement) => statement === 'COMMIT');
      expect(begins).toHaveLength(4);
      expect(commits).toHaveLength(4);
    });
  });
});
