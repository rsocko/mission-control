import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { runPostgresMigrations } from '../src/db/postgres/migrations';
import { PostgresSemanticIndexRepository } from '../src/db/postgres/semantic-index/repository';
import {
  initializePostgresVectorSupport,
  POSTGRES_HNSW_MIN_CANDIDATES,
} from '../src/db/postgres/vector-support';
import type {
  SemanticMetadataFilter,
  SemanticQueryRequest,
  SemanticVectorWrite,
} from '../src/lib/semantic-index/contracts';

const EXPECTED_VECTOR_VERSION = '0.8.6';
const CORPUS_SIZES = [10_000, 100_000] as const;
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_QUERY_RUNS = 20;
const WARMUP_QUERY_RUNS = 2;
const K = 10;
const BENCHMARK_NOW = '2030-01-01T00:00:00.000Z';
const FUTURE = '2031-01-01T00:00:00.000Z';
const EXPIRED = '2029-01-01T00:00:00.000Z';
const SYNTHETIC_VECTOR_FUNCTION = 'mc_benchmark_synthetic_vector';
const STAGING_TABLE = 'mc_benchmark_vector_seed';
let currentStage = 'configuration';
const execFileAsync = promisify(execFile);

const GATES = {
  minimumUnfilteredRecallAtK: 0.9,
  minimumFilteredRecallAtK: 0.8,
  vectorLookupP95Ms: 200,
  endToEndRepositoryP95Ms: 300,
  smokeVectorLookupP95Ms: 400,
  smokeEndToEndRepositoryP95Ms: 450,
  backfillMs: 900_000,
  indexBuildMs: 900_000,
  repositoryUpdateMs: 5_000,
  batchUpdateMs: 60_000,
  deleteAndExpiryMs: 60_000,
  backupMs: 900_000,
  restoreMs: 900_000,
} as const;

interface TimingSummary {
  p50Ms: number;
  p95Ms: number;
}

interface SearchFilter {
  scopeId: number;
  category: number;
}

interface PlanSummary {
  executionTimeMs: number;
  usesIdentityHnsw: boolean;
  usesSequentialScan: boolean;
}

interface BenchmarkConfiguration {
  connectionString: string;
  dimensions: number;
  queryRuns: number;
  postgresContainer: string | null;
}

interface BackupRestoreResult {
  method: 'pg-dump-custom-format';
  backupMs: number;
  restoreMs: number;
  databaseCreated: boolean;
  extensionInstalledFirst: boolean;
  rowCountsMatched: boolean;
  checksumsMatched: boolean;
  identityHnswRestored: boolean;
  repositoryQueryRestored: boolean;
  vectorMigrationsIdempotent: boolean;
}

interface BenchmarkResult {
  entities: number;
  dimensions: number;
  runs: number;
  warmupRuns: number;
  backfillMs: number;
  indexBuildMs: number;
  vectorLookup: TimingSummary;
  endToEndRepository: TimingSummary;
  latencyThresholds: {
    vectorLookupP95Ms: number;
    endToEndRepositoryP95Ms: number;
  };
  planExecution: TimingSummary;
  recallAtK: {
    unfiltered: number;
    filtered: number;
  };
  repository: {
    allQueriesUsedIndexedScanContract: boolean;
    filtersVerified: boolean;
    unauthorizedResults: number;
    authorizationExcluded: boolean;
  };
  authorizationCohorts: {
    restricted: number;
    nonTask: number;
  };
  plans: {
    identityIndexName: string;
    allUseIdentityHnsw: boolean;
    anySequentialScan: boolean;
  };
  storage: {
    productionTableBytes: number;
    identityIndexBytes: number;
  };
  postgresMemory: {
    source: 'postgres-container-cgroup' | 'backend-context-fallback';
    required: boolean;
    measurable: boolean;
    sameBackend: boolean | null;
    beforeBytes: number | null;
    afterBytes: number | null;
    deltaBytes: number | null;
  };
  lifecycle: {
    repositoryUpdateMs: number;
    repositoryUpdateStatus: string;
    batchUpdateMs: number;
    batchUpdated: number;
    deleteAndExpiryMs: number;
    explicitlyDeleted: number;
    expiredDeleted: number;
  };
  backupRestore: BackupRestoreResult | null;
  gatesPassed: boolean;
}

interface Snapshot {
  documentCount: number;
  vectorCount: number;
  annCount: number;
  documentChecksum: string;
  vectorChecksum: string;
  annChecksum: string;
}

export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function timingSummary(values: number[]): TimingSummary {
  return {
    p50Ms: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
  };
}

function parseInteger(name: string, rawValue: string | undefined, fallback: number): number {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid_${name.toLowerCase()}`);
  }
  return value;
}

function configuration(): BenchmarkConfiguration {
  const connectionString =
    process.env.MC_BENCHMARK_POSTGRES_URL ?? process.env.MC_TEST_POSTGRES_URL;
  if (!connectionString) throw new Error('missing_postgres_url');
  let target: URL;
  try {
    target = new URL(connectionString);
  } catch {
    throw new Error('invalid_postgres_url');
  }
  const database = decodeURIComponent(target.pathname.replace(/^\//u, ''));
  const safeDatabase =
    /(?:^|[-_.])(test|tests|testing|ci|dev|sandbox|local|benchmark)(?:[-_.]|$)/iu;
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    /prod(uction)?/iu.test(target.hostname) ||
    /prod(uction)?/iu.test(database) ||
    !safeDatabase.test(database)
  ) {
    throw new Error('unsafe_postgres_target');
  }

  const dimensions = parseInteger(
    'dimensions',
    process.env.MC_BENCHMARK_DIMENSIONS,
    DEFAULT_DIMENSIONS,
  );
  if (dimensions < 8 || dimensions > 4_000) throw new Error('unsupported_dimensions');
  const queryRuns = parseInteger(
    'query_runs',
    process.env.MC_BENCHMARK_QUERY_RUNS,
    DEFAULT_QUERY_RUNS,
  );
  if (queryRuns < 2) throw new Error('insufficient_query_runs');

  return {
    connectionString,
    dimensions,
    queryRuns,
    postgresContainer: process.env.MC_BENCHMARK_POSTGRES_CONTAINER?.trim() || null,
  };
}

function roundMilliseconds(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(2));
}

function vectorSeed(run: number, size: number): number {
  let seed = 201 + ((run * 7_919) % (size - 201));
  while (seed % 97 === 0 || seed % 20 === 0 || seed % 25 === 0) seed += 1;
  return seed;
}

function overlapRecall(reference: string[], candidate: string[]): number {
  if (reference.length === 0) return candidate.length === 0 ? 1 : 0;
  const candidateIds = new Set(candidate);
  return reference.filter((id) => candidateIds.has(id)).length / reference.length;
}

function inspectNode(
  node: Record<string, unknown>,
  expectedIndexName: string,
): { usesIdentityHnsw: boolean; usesSequentialScan: boolean } {
  const nodeType = String(node['Node Type'] ?? '');
  const indexName = String(node['Index Name'] ?? '');
  let usesIdentityHnsw =
    (nodeType === 'Index Scan' || nodeType === 'Index Only Scan') &&
    indexName === expectedIndexName;
  let usesSequentialScan = nodeType === 'Seq Scan';
  const children = Array.isArray(node.Plans) ? node.Plans : [];
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    const inspected = inspectNode(child as Record<string, unknown>, expectedIndexName);
    usesIdentityHnsw ||= inspected.usesIdentityHnsw;
    usesSequentialScan ||= inspected.usesSequentialScan;
  }
  return { usesIdentityHnsw, usesSequentialScan };
}

export function inspectExplainPlan(
  value: unknown,
  expectedIndexName = 'benchmark_documents_embedding_hnsw',
): PlanSummary {
  const root = Array.isArray(value) ? value[0] : undefined;
  if (!root || typeof root !== 'object') throw new Error('invalid_explain_plan');
  const plan = (root as Record<string, unknown>).Plan;
  if (!plan || typeof plan !== 'object') throw new Error('invalid_explain_plan');
  const executionTimeMs = Number((root as Record<string, unknown>)['Execution Time']);
  if (!Number.isFinite(executionTimeMs)) throw new Error('invalid_explain_timing');
  return {
    executionTimeMs,
    ...inspectNode(plan as Record<string, unknown>, expectedIndexName),
  };
}

function queryText(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && 'text' in first) {
    return String((first as { text: unknown }).text);
  }
  return '';
}

function instrumentAnnQueries(pool: Pool, timings: number[]): Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property !== 'connect') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(clientTarget, clientProperty) {
            if (clientProperty !== 'query') {
              const value = Reflect.get(clientTarget, clientProperty, clientTarget);
              return typeof value === 'function' ? value.bind(clientTarget) : value;
            }
            return (...args: unknown[]) => {
              const measure = queryText(args).includes('WITH nearest AS MATERIALIZED');
              const startedAt = measure ? performance.now() : 0;
              const result = Reflect.apply(clientTarget.query, clientTarget, args) as Promise<unknown>;
              if (!measure) return result;
              return result.finally(() => timings.push(performance.now() - startedAt));
            };
          },
        });
      };
    },
  }) as Pool;
}

async function ownBackendMemory(
  pool: Pool,
): Promise<{ backendPid: number; bytes: number } | null> {
  try {
    const result = await pool.query<{ backend_pid: number; bytes: string | null }>(
      `
        SELECT
          pg_backend_pid() AS backend_pid,
          sum(total_bytes)::bigint AS bytes
        FROM pg_backend_memory_contexts
      `,
    );
    const row = result.rows[0];
    return row?.bytes === null || row?.bytes === undefined
      ? null
      : { backendPid: row.backend_pid, bytes: Number(row.bytes) };
  } catch {
    return null;
  }
}

interface MemorySample {
  source: 'postgres-container-cgroup' | 'backend-context-fallback';
  bytes: number | null;
  backendPid: number | null;
}

async function memorySample(
  pool: Pool,
  postgresContainer: string | null,
): Promise<MemorySample> {
  if (postgresContainer) {
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['exec', postgresContainer, 'cat', '/sys/fs/cgroup/memory.current'],
        { encoding: 'utf8', windowsHide: true },
      );
      const bytes = Number(stdout.trim());
      return {
        source: 'postgres-container-cgroup',
        bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
        backendPid: null,
      };
    } catch {
      return {
        source: 'postgres-container-cgroup',
        bytes: null,
        backendPid: null,
      };
    }
  }

  const backend = await ownBackendMemory(pool);
  return {
    source: 'backend-context-fallback',
    bytes: backend?.bytes ?? null,
    backendPid: backend?.backendPid ?? null,
  };
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/u.test(identifier)) throw new Error('invalid_identifier');
  return `"${identifier}"`;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function createSyntheticVectorFunction(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION ${SYNTHETIC_VECTOR_FUNCTION}(
      seed bigint,
      dimensions integer
    )
    RETURNS vector
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $function$
      WITH components AS (
        SELECT
          dimension,
          (
            (
              (
                seed * 15485863
                + dimension::bigint * 32452843
                + seed * dimension * 49979687
              ) % 2000003
            )::double precision / 1000001.5 - 1
          )::real AS value
        FROM generate_series(1, dimensions) AS dimension
      ),
      normalized AS (
        SELECT
          dimension,
          (value / sqrt(sum(value * value) OVER ()))::real AS value
        FROM components
      )
      SELECT array_agg(value ORDER BY dimension)::vector
      FROM normalized
    $function$
  `);
}

async function identityIndexDefinition(
  pool: Pool,
  identityId: string,
): Promise<{ name: string; definition: string }> {
  const result = await pool.query<{ indexname: string; indexdef: string }>(
    `
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'semantic_vector_ann'
        AND indexdef LIKE '%USING hnsw%'
        AND indexdef LIKE '%' || $1 || '%'
    `,
    [identityId],
  );
  const name = result.rows[0]?.indexname;
  const definition = result.rows[0]?.indexdef;
  if (!name || !/^[a-z0-9_]+$/u.test(name)) throw new Error('identity_hnsw_missing');
  if (!definition?.startsWith('CREATE INDEX')) throw new Error('identity_hnsw_missing');
  return { name, definition };
}

async function cleanupIdentity(
  pool: Pool,
  identityId: string,
  indexName?: string,
): Promise<void> {
  if (indexName) await pool.query(`DROP INDEX IF EXISTS ${quoteIdentifier(indexName)}`);
  await pool.query('DELETE FROM semantic_index_identities WHERE id = $1', [identityId]);
  await pool.query(`DROP TABLE IF EXISTS ${STAGING_TABLE}`);
}

async function seedProductionTables(
  pool: Pool,
  identityId: string,
  size: number,
  dimensions: number,
): Promise<number> {
  const startedAt = performance.now();
  await pool.query(`DROP TABLE IF EXISTS ${STAGING_TABLE}`);
  await pool.query(`
    CREATE UNLOGGED TABLE ${STAGING_TABLE} (
      ordinal integer PRIMARY KEY,
      embedding vector(${dimensions}) NOT NULL
    )
  `);
  await pool.query(
    `
      INSERT INTO ${STAGING_TABLE} (ordinal, embedding)
      SELECT ordinal, ${SYNTHETIC_VECTOR_FUNCTION}(ordinal, $2)
      FROM generate_series(1, $1) AS ordinal
    `,
    [size, dimensions],
  );
  await pool.query(
    `
      INSERT INTO semantic_documents (
        id, index_id, entity_type, entity_id, version, title, body, keywords,
        metadata, source_revision, content_fingerprint, projection_version,
        sensitivity, retain_until, source_updated_at, created_at, updated_at, deleted_at
      )
      SELECT
        $1 || ':doc:' || ordinal,
        $1,
        CASE WHEN ordinal % 25 = 0 THEN 'project' ELSE 'task' END,
        'entity-' || ordinal,
        1,
        'Synthetic benchmark entity ' || ordinal,
        'Synthetic benchmark projection',
        '[]'::jsonb,
        jsonb_build_object(
          'scope', (ordinal % 10)::text,
          'category', (ordinal % 4)::text
        ),
        'revision-1',
        'synthetic-fingerprint-' || ordinal,
        1,
        CASE WHEN ordinal % 20 = 0 THEN 'restricted' ELSE 'standard' END,
        CASE WHEN ordinal % 97 = 0 THEN $2 ELSE NULL END,
        $3,
        $3,
        $3,
        NULL
      FROM ${STAGING_TABLE}
    `,
    [identityId, FUTURE, BENCHMARK_NOW],
  );
  await pool.query(
    `
      INSERT INTO semantic_vectors (
        id, index_id, document_id, document_version, entity_type, entity_id,
        source_revision, content_fingerprint, projection_version, provider, model,
        dimensions, sensitivity, embedding, norm, source_updated_at, embedded_at,
        index_run_id, intent_id, expires_at, created_at, updated_at
      )
      SELECT
        $1 || ':vector:' || ordinal,
        $1,
        $1 || ':doc:' || ordinal,
        1,
        CASE WHEN ordinal % 25 = 0 THEN 'project' ELSE 'task' END,
        'entity-' || ordinal,
        'revision-1',
        'synthetic-fingerprint-' || ordinal,
        1,
        'benchmark',
        'deterministic-synthetic',
        $2,
        CASE WHEN ordinal % 20 = 0 THEN 'restricted' ELSE 'standard' END,
        embedding::text,
        '1',
        $3,
        $3,
        NULL,
        NULL,
        CASE WHEN ordinal % 97 = 0 THEN $4 ELSE NULL END,
        $3,
        $3
      FROM ${STAGING_TABLE}
    `,
    [identityId, dimensions, BENCHMARK_NOW, FUTURE],
  );
  await pool.query(
    `
      INSERT INTO semantic_vector_ann (
        vector_id, index_id, document_id, entity_type, entity_id, sensitivity,
        metadata, dimensions, embedding, source_revision, source_updated_at,
        embedded_at, expires_at, retain_until
      )
      SELECT
        $1 || ':vector:' || ordinal,
        $1,
        $1 || ':doc:' || ordinal,
        CASE WHEN ordinal % 25 = 0 THEN 'project' ELSE 'task' END,
        'entity-' || ordinal,
        CASE WHEN ordinal % 20 = 0 THEN 'restricted' ELSE 'standard' END,
        jsonb_build_object(
          'scope', (ordinal % 10)::text,
          'category', (ordinal % 4)::text
        ),
        $2,
        embedding,
        'revision-1',
        $3,
        $3,
        CASE WHEN ordinal % 97 = 0 THEN $4 ELSE NULL END,
        CASE WHEN ordinal % 97 = 0 THEN $4 ELSE NULL END
      FROM ${STAGING_TABLE}
    `,
    [identityId, dimensions, BENCHMARK_NOW, FUTURE],
  );
  await pool.query(
    `
      UPDATE semantic_index_identities
      SET document_count = $1, vector_count = $1, updated_at = $2
      WHERE id = $3
    `,
    [size, BENCHMARK_NOW, identityId],
  );
  await pool.query(`DROP TABLE ${STAGING_TABLE}`);
  return roundMilliseconds(startedAt);
}

function metadataFilters(filter: SearchFilter | null): SemanticMetadataFilter[] | undefined {
  if (filter === null) return undefined;
  return [
    { keys: ['scope'], match: 'any', values: [String(filter.scopeId)] },
    { keys: ['category'], match: 'any', values: [String(filter.category)] },
  ];
}

function productionWhere(
  identityId: string,
  dimensions: number,
  filter: SearchFilter | null,
): {
  sql: string;
  values: unknown[];
} {
  const values: unknown[] = [identityId, BENCHMARK_NOW, dimensions];
  let sql = `
    a.index_id = $1
    AND a.dimensions = $3
    AND a.entity_type = 'task'
    AND a.sensitivity = 'standard'
    AND (a.expires_at IS NULL OR a.expires_at > $2)
    AND (a.retain_until IS NULL OR a.retain_until > $2)
  `;
  if (filter) {
    values.push(String(filter.scopeId), String(filter.category));
    sql += `
      AND a.metadata ->> 'scope' = $4
      AND a.metadata ->> 'category' = $5
    `;
  }
  return { sql, values };
}

async function exactReference(
  pool: Pool,
  identityId: string,
  dimensions: number,
  vector: string,
  filter: SearchFilter | null,
): Promise<string[]> {
  const where = productionWhere(identityId, dimensions, filter);
  const values = [...where.values];
  values.push(vector, K);
  const vectorParam = values.length - 1;
  const limitParam = values.length;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL jit = off');
    await client.query('SET LOCAL enable_indexscan = off');
    await client.query('SET LOCAL enable_indexonlyscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    const result = await client.query<{ entity_id: string }>(
      `
        SELECT a.entity_id
        FROM semantic_vector_ann a
        WHERE ${where.sql}
        ORDER BY a.embedding <=> $${vectorParam}::vector(${dimensions})
        LIMIT $${limitParam}
      `,
      values,
    );
    await client.query('COMMIT');
    return result.rows.map((row) => row.entity_id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function explainProductionAnn(
  pool: Pool,
  identityId: string,
  dimensions: number,
  indexName: string,
  vector: string,
  filter: SearchFilter | null,
): Promise<PlanSummary> {
  const values: unknown[] = [vector, BENCHMARK_NOW, ['task'], ['standard']];
  let where = `
    a.index_id = ${quoteSqlLiteral(identityId)}
    AND a.dimensions = ${dimensions}
    AND (a.expires_at IS NULL OR a.expires_at > $2)
    AND (a.retain_until IS NULL OR a.retain_until > $2)
    AND a.entity_type = ANY($3::text[])
    AND a.sensitivity = ANY($4::text[])
  `;
  if (filter) {
    values.push('scope', [String(filter.scopeId)], 'category', [String(filter.category)]);
    where += `
      AND a.metadata ->> $5 = ANY($6::text[])
      AND a.metadata ->> $7 = ANY($8::text[])
    `;
  }
  values.push(POSTGRES_HNSW_MIN_CANDIDATES);
  const limitParam = values.length;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL jit = off');
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_sort = off');
    await client.query(`SET LOCAL hnsw.ef_search = ${POSTGRES_HNSW_MIN_CANDIDATES}`);
    await client.query("SET LOCAL hnsw.iterative_scan = 'strict_order'");
    await client.query('SET LOCAL hnsw.max_scan_tuples = 20000');
    const explained = await client.query(`
      EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF, SUMMARY ON)
      WITH nearest AS MATERIALIZED (
        SELECT
          a.vector_id,
          a.embedding::halfvec(${dimensions})
            <=> $1::halfvec(${dimensions}) AS distance
        FROM semantic_vector_ann a
        WHERE ${where}
        ORDER BY a.embedding::halfvec(${dimensions})
          <=> $1::halfvec(${dimensions})
        LIMIT $${limitParam}
      )
      SELECT vector_id FROM nearest ORDER BY distance
    `, values);
    await client.query('COMMIT');
    return inspectExplainPlan(explained.rows[0]?.['QUERY PLAN'], indexName);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function queryVector(
  pool: Pool,
  seed: number,
  dimensions: number,
): Promise<{ serialized: string; embedding: Float32Array }> {
  const result = await pool.query<{ embedding: string }>(
    `SELECT ${SYNTHETIC_VECTOR_FUNCTION}($1, $2)::text AS embedding`,
    [seed, dimensions],
  );
  const serialized = result.rows[0]?.embedding;
  if (!serialized) throw new Error('query_vector_generation_failed');
  const parsed = JSON.parse(serialized) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== dimensions) {
    throw new Error('query_vector_generation_failed');
  }
  return { serialized, embedding: Float32Array.from(parsed as number[]) };
}

async function storageBytes(
  pool: Pool,
  indexName: string,
): Promise<{ productionTableBytes: number; identityIndexBytes: number }> {
  const result = await pool.query<{
    table_bytes: string;
    index_bytes: string;
  }>(
    `
      SELECT
        (
          pg_table_size('semantic_documents')
          + pg_table_size('semantic_vectors')
          + pg_table_size('semantic_vector_ann')
        )::bigint AS table_bytes,
        pg_relation_size($1)::bigint AS index_bytes
    `,
    [`public.${indexName}`],
  );
  return {
    productionTableBytes: Number(result.rows[0]?.table_bytes ?? 0),
    identityIndexBytes: Number(result.rows[0]?.index_bytes ?? 0),
  };
}

async function authorizationCohorts(
  pool: Pool,
  identityId: string,
): Promise<{ restricted: number; nonTask: number }> {
  const result = await pool.query<{ restricted: string; non_task: string }>(
    `
      SELECT
        count(*) FILTER (WHERE sensitivity = 'restricted')::bigint AS restricted,
        count(*) FILTER (WHERE entity_type <> 'task')::bigint AS non_task
      FROM semantic_vector_ann
      WHERE index_id = $1
    `,
    [identityId],
  );
  return {
    restricted: Number(result.rows[0]?.restricted ?? 0),
    nonTask: Number(result.rows[0]?.non_task ?? 0),
  };
}

function repositoryUpdateOrdinal(size: number): number {
  let ordinal = size - 1;
  while (ordinal % 97 === 0 || ordinal % 20 === 0 || ordinal % 25 === 0) {
    ordinal -= 1;
  }
  return ordinal;
}

async function exerciseLifecycle(
  pool: Pool,
  repository: PostgresSemanticIndexRepository,
  identityId: string,
  size: number,
  dimensions: number,
) {
  const repositoryOrdinal = repositoryUpdateOrdinal(size);
  const replacement = await queryVector(pool, repositoryOrdinal + size, dimensions);
  const repositoryUpdate: SemanticVectorWrite = {
    id: `${identityId}:vector:${repositoryOrdinal}`,
    indexId: identityId,
    documentId: `${identityId}:doc:${repositoryOrdinal}`,
    documentVersion: 1,
    entityType: 'task',
    entityId: `entity-${repositoryOrdinal}`,
    sourceRevision: 'revision-1',
    contentFingerprint: `synthetic-fingerprint-${repositoryOrdinal}`,
    projectionVersion: 1,
    provider: 'benchmark',
    model: 'deterministic-synthetic',
    dimensions,
    sensitivity: 'standard',
    embedding: replacement.embedding,
    sourceUpdatedAt: BENCHMARK_NOW,
    embeddedAt: BENCHMARK_NOW,
    indexRunId: null,
    intentId: null,
    expiresAt: null,
    now: BENCHMARK_NOW,
  };
  const repositoryUpdateStartedAt = performance.now();
  const repositoryUpdateResult = await repository.upsertVector(repositoryUpdate);
  const repositoryUpdateMs = roundMilliseconds(repositoryUpdateStartedAt);

  const batchUpdateStartedAt = performance.now();
  const updated = await pool.query(
    `
      WITH replacements AS MATERIALIZED (
        SELECT
          ordinal,
          ${SYNTHETIC_VECTOR_FUNCTION}(ordinal + $2, $3) AS embedding
        FROM generate_series($1 - 99, $1) AS ordinal
        WHERE ordinal <> $6
      ),
      updated_vectors AS (
        UPDATE semantic_vectors v
        SET
          embedding = replacements.embedding::text,
          norm = '1',
          updated_at = $4
        FROM replacements
        WHERE v.id = $5 || ':vector:' || replacements.ordinal
        RETURNING v.id
      )
      UPDATE semantic_vector_ann a
      SET
        embedding = replacements.embedding
      FROM replacements
      WHERE a.vector_id = $5 || ':vector:' || replacements.ordinal
    `,
    [size, size, dimensions, BENCHMARK_NOW, identityId, repositoryOrdinal],
  );
  const batchUpdateMs = roundMilliseconds(batchUpdateStartedAt);

  const deleteStartedAt = performance.now();
  let explicitlyDeleted = 0;
  for (let ordinal = 1; explicitlyDeleted < 100; ordinal++) {
    if (ordinal % 25 === 0) continue;
    if (await repository.deleteVector(identityId, 'task', `entity-${ordinal}`)) {
      explicitlyDeleted += 1;
    }
  }
  await pool.query(
    `
      UPDATE semantic_documents
      SET retain_until = $1
      WHERE index_id = $2
        AND entity_id IN (
          SELECT 'entity-' || ordinal
          FROM generate_series(201, 300) AS ordinal
        )
    `,
    [EXPIRED, identityId],
  );
  const expiry = await repository.expireDocuments({
    indexId: identityId,
    now: BENCHMARK_NOW,
    limit: 100,
  });
  const deleteAndExpiryMs = roundMilliseconds(deleteStartedAt);

  return {
    repositoryUpdateMs,
    repositoryUpdateStatus: repositoryUpdateResult.status,
    batchUpdateMs,
    batchUpdated: updated.rowCount ?? 0,
    deleteAndExpiryMs,
    explicitlyDeleted,
    expiredDeleted: expiry.documentsExpired,
  };
}

async function snapshot(pool: Pool, identityId: string): Promise<Snapshot> {
  const result = await pool.query<{
    document_count: string;
    vector_count: string;
    ann_count: string;
    document_checksum: string;
    vector_checksum: string;
    ann_checksum: string;
  }>(
    `
      SELECT
        (SELECT count(*) FROM semantic_documents WHERE index_id = $1)::bigint
          AS document_count,
        (SELECT count(*) FROM semantic_vectors WHERE index_id = $1)::bigint
          AS vector_count,
        (SELECT count(*) FROM semantic_vector_ann WHERE index_id = $1)::bigint
          AS ann_count,
        (
          SELECT md5(COALESCE(string_agg(id, ',' ORDER BY id), ''))
          FROM semantic_documents WHERE index_id = $1
        ) AS document_checksum,
        (
          SELECT md5(COALESCE(string_agg(id, ',' ORDER BY id), ''))
          FROM semantic_vectors WHERE index_id = $1
        ) AS vector_checksum,
        (
          SELECT md5(COALESCE(string_agg(vector_id, ',' ORDER BY vector_id), ''))
          FROM semantic_vector_ann WHERE index_id = $1
        ) AS ann_checksum
    `,
    [identityId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('snapshot_failed');
  return {
    documentCount: Number(row.document_count),
    vectorCount: Number(row.vector_count),
    annCount: Number(row.ann_count),
    documentChecksum: row.document_checksum,
    vectorChecksum: row.vector_checksum,
    annChecksum: row.ann_checksum,
  };
}

function databaseConnectionString(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function databaseCredentials(connectionString: string) {
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//u, '')),
  };
}

async function runPgTool(input: {
  executable: 'pg_dump' | 'pg_restore';
  args: string[];
  password: string;
  container: string | null;
  inputFile?: string;
  outputFile?: string;
}): Promise<void> {
  const args = input.container
    ? [
        'exec',
        ...(input.inputFile ? ['--interactive'] : []),
        input.container,
        '/bin/bash',
        '-ceu',
        'export PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"',
        '--',
        input.executable,
        ...input.args,
      ]
    : input.args;
  const executable = input.container ? 'docker' : input.executable;

  const child = spawn(executable, args, {
    env: { ...process.env, PGPASSWORD: input.password },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.resume();
  const exit = new Promise<void>((resolve, reject) => {
    child.on('error', () => reject(new Error(`${input.executable}_unavailable`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${input.executable}_failed`));
    });
  });
  const inputStream = input.inputFile
    ? pipeline(createReadStream(input.inputFile), child.stdin)
    : Promise.resolve(child.stdin.end());
  const outputStream = input.outputFile
    ? pipeline(child.stdout, createWriteStream(input.outputFile))
    : Promise.resolve(child.stdout.resume());
  await Promise.all([exit, inputStream, outputStream]);
}

async function exerciseBackupRestore(
  sourcePool: Pool,
  config: BenchmarkConfiguration,
  identityId: string,
  indexName: string,
): Promise<BackupRestoreResult> {
  const credentials = databaseCredentials(config.connectionString);
  const restoreDatabase = `mc_vector_restore_${process.pid}`;
  const dumpFile = `.mc-pgvector-benchmark-${process.pid}.dump`;
  const sourceSnapshot = await snapshot(sourcePool, identityId);
  const restoreProbe = await queryVector(sourcePool, 201, config.dimensions);
  let restorePool: Pool | null = null;
  let databaseCreated = false;
  let extensionInstalledFirst = false;

  try {
    const backupStartedAt = performance.now();
    const dumpArgs = [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--host',
      config.postgresContainer ? '127.0.0.1' : credentials.host,
      '--port',
      config.postgresContainer ? '5432' : credentials.port,
      '--username',
      credentials.user,
      '--dbname',
      credentials.database,
    ];
    await runPgTool({
      executable: 'pg_dump',
      args: dumpArgs,
      password: credentials.password,
      container: config.postgresContainer,
      outputFile: dumpFile,
    });
    const backupMs = roundMilliseconds(backupStartedAt);

    await sourcePool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(restoreDatabase)} WITH (FORCE)`);
    await sourcePool.query(`CREATE DATABASE ${quoteIdentifier(restoreDatabase)}`);
    databaseCreated = true;
    restorePool = new Pool({
      connectionString: databaseConnectionString(config.connectionString, restoreDatabase),
      max: 2,
    });
    await restorePool.query('CREATE EXTENSION vector');
    const version = await restorePool.query<{ extversion: string }>(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );
    extensionInstalledFirst = version.rows[0]?.extversion === EXPECTED_VECTOR_VERSION;
    if (!extensionInstalledFirst) throw new Error('restore_vector_version_mismatch');

    const restoreStartedAt = performance.now();
    await runPgTool({
      executable: 'pg_restore',
      args: [
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--host',
        config.postgresContainer ? '127.0.0.1' : credentials.host,
        '--port',
        config.postgresContainer ? '5432' : credentials.port,
        '--username',
        credentials.user,
        '--dbname',
        restoreDatabase,
      ],
      password: credentials.password,
      container: config.postgresContainer,
      inputFile: dumpFile,
    });
    const restoreMs = roundMilliseconds(restoreStartedAt);
    const restoredSnapshot = await snapshot(restorePool, identityId);
    const restoredCapability = await initializePostgresVectorSupport(restorePool, {
      mode: 'required',
    });
    const vectorMigrationsIdempotent =
      restoredCapability.available &&
      restoredCapability.extensionVersion === EXPECTED_VECTOR_VERSION;
    const restoredPlan = await explainProductionAnn(
      restorePool,
      identityId,
      config.dimensions,
      indexName,
      restoreProbe.serialized,
      null,
    );
    const restoredRepository = new PostgresSemanticIndexRepository(
      restorePool,
      5_000,
      {
        available: true,
        mode: 'required',
        extensionVersion: EXPECTED_VECTOR_VERSION,
        maxDimensions: 4_000,
      },
    );
    const restoredQuery = await restoredRepository.queryVectors({
      indexId: identityId,
      queryEmbedding: restoreProbe.embedding,
      limit: K,
      entityTypes: ['task'],
      sensitivities: ['standard'],
      now: BENCHMARK_NOW,
    });
    const repositoryQueryRestored =
      restoredQuery.scan.kind === 'postgres-hnsw' &&
      restoredQuery.results.length === K;
    const identityHnswRestored =
      restoredPlan.usesIdentityHnsw &&
      !restoredPlan.usesSequentialScan;
    return {
      method: 'pg-dump-custom-format',
      backupMs,
      restoreMs,
      databaseCreated,
      extensionInstalledFirst,
      rowCountsMatched:
        sourceSnapshot.documentCount === restoredSnapshot.documentCount &&
        sourceSnapshot.vectorCount === restoredSnapshot.vectorCount &&
        sourceSnapshot.annCount === restoredSnapshot.annCount,
      checksumsMatched:
        sourceSnapshot.documentChecksum === restoredSnapshot.documentChecksum &&
        sourceSnapshot.vectorChecksum === restoredSnapshot.vectorChecksum &&
        sourceSnapshot.annChecksum === restoredSnapshot.annChecksum,
      identityHnswRestored,
      repositoryQueryRestored,
      vectorMigrationsIdempotent,
    };
  } finally {
    if (restorePool) await restorePool.end().catch(() => undefined);
    if (databaseCreated) {
      await sourcePool.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(restoreDatabase)} WITH (FORCE)`,
      ).catch(() => undefined);
    }
    await rm(dumpFile, { force: true }).catch(() => undefined);
  }
}

async function benchmarkCorpus(
  rawPool: Pool,
  repository: PostgresSemanticIndexRepository,
  annQueryTimings: number[],
  config: BenchmarkConfiguration,
  size: number,
): Promise<BenchmarkResult> {
  const identityId = `mc-benchmark-${size}-${config.dimensions}`;
  await cleanupIdentity(rawPool, identityId);
  const memoryBefore = await memorySample(rawPool, config.postgresContainer);
  await repository.createIdentity({
    id: identityId,
    provider: 'benchmark',
    model: 'deterministic-synthetic',
    dimensions: config.dimensions,
    projectionVersion: 1,
    status: 'ready',
    now: BENCHMARK_NOW,
  });
  const identityIndex = await identityIndexDefinition(rawPool, identityId);
  const indexName = identityIndex.name;
  await rawPool.query(`DROP INDEX ${quoteIdentifier(indexName)}`);

  try {
    const backfillMs = await seedProductionTables(
      rawPool,
      identityId,
      size,
      config.dimensions,
    );
    const indexStartedAt = performance.now();
    const indexClient = await rawPool.connect();
    try {
      await indexClient.query(`SET maintenance_work_mem = '512MB'`);
      await indexClient.query(identityIndex.definition);
    } finally {
      await indexClient.query('RESET maintenance_work_mem').catch(() => undefined);
      indexClient.release();
    }
    const indexBuildMs = roundMilliseconds(indexStartedAt);
    await rawPool.query('ANALYZE semantic_vector_ann');
    const cohorts = await authorizationCohorts(rawPool, identityId);

    const lookupMs: number[] = [];
    const endToEndMs: number[] = [];
    const planExecutionMs: number[] = [];
    const unfilteredRecall: number[] = [];
    const filteredRecall: number[] = [];
    const plans: PlanSummary[] = [];
    let indexedScanContract = true;
    let filtersVerified = true;
    let unauthorizedResults = 0;

    for (let run = 0; run < WARMUP_QUERY_RUNS; run++) {
      const seed = vectorSeed(config.queryRuns + run, size);
      const vector = await queryVector(rawPool, seed, config.dimensions);
      const filter = run % 2 === 0
        ? null
        : { scopeId: seed % 10, category: seed % 4 };
      const response = await repository.queryVectors({
        indexId: identityId,
        queryEmbedding: vector.embedding,
        limit: K,
        entityTypes: ['task'],
        sensitivities: ['standard'],
        metadataFilters: metadataFilters(filter),
        now: BENCHMARK_NOW,
      });
      if (response.scan.kind !== 'postgres-hnsw') {
        throw new Error('warmup_query_not_indexed');
      }
    }

    for (let run = 0; run < config.queryRuns; run++) {
      const seed = vectorSeed(run, size);
      const vector = await queryVector(rawPool, seed, config.dimensions);
      const filter = run % 2 === 0
        ? null
        : { scopeId: seed % 10, category: seed % 4 };
      const exact = await exactReference(
        rawPool,
        identityId,
        config.dimensions,
        vector.serialized,
        filter,
      );
      const plan = await explainProductionAnn(
        rawPool,
        identityId,
        config.dimensions,
        indexName,
        vector.serialized,
        filter,
      );
      plans.push(plan);
      planExecutionMs.push(plan.executionTimeMs);

      annQueryTimings.length = 0;
      const request: SemanticQueryRequest = {
        indexId: identityId,
        queryEmbedding: vector.embedding,
        limit: K,
        entityTypes: ['task'],
        sensitivities: ['standard'],
        metadataFilters: metadataFilters(filter),
        now: BENCHMARK_NOW,
      };
      const startedAt = performance.now();
      const response = await repository.queryVectors(request);
      endToEndMs.push(performance.now() - startedAt);
      if (annQueryTimings.length !== 1) throw new Error('ann_query_not_measured');
      lookupMs.push(annQueryTimings[0]);
      indexedScanContract &&= response.scan.kind === 'postgres-hnsw';
      unauthorizedResults += response.results.filter((result) =>
        result.entityType !== 'task' || result.sensitivity !== 'standard'
      ).length;
      if (filter) {
        filtersVerified &&= response.results.every((result) =>
          result.metadata.scope === String(filter.scopeId) &&
          result.metadata.category === String(filter.category)
        );
      }
      const recall = overlapRecall(
        exact,
        response.results.map((result) => result.entityId),
      );
      (filter === null ? unfilteredRecall : filteredRecall).push(recall);
    }

    const storage = await storageBytes(rawPool, indexName);
    const lifecycle = await exerciseLifecycle(
      rawPool,
      repository,
      identityId,
      size,
      config.dimensions,
    );
    const backupRestore = size === 100_000
      ? await exerciseBackupRestore(rawPool, config, identityId, indexName)
      : null;
    const memoryAfter = await memorySample(rawPool, config.postgresContainer);
    const sameMemoryBackend =
      memoryBefore.backendPid !== null &&
      memoryAfter.backendPid !== null &&
      memoryBefore.backendPid === memoryAfter.backendPid;
    const memoryMeasurable =
      memoryBefore.bytes !== null &&
      memoryAfter.bytes !== null;
    const memoryGate = !config.postgresContainer || memoryMeasurable;
    const authorizationExcluded =
      cohorts.restricted > 0 &&
      cohorts.nonTask > 0 &&
      unauthorizedResults === 0;
    const vectorLookup = timingSummary(lookupMs);
    const endToEndRepository = timingSummary(endToEndMs);
    const recallAtK = {
      unfiltered: Number(
        (unfilteredRecall.reduce((sum, value) => sum + value, 0) /
          Math.max(1, unfilteredRecall.length)).toFixed(4),
      ),
      filtered: Number(
        (filteredRecall.reduce((sum, value) => sum + value, 0) /
          Math.max(1, filteredRecall.length)).toFixed(4),
      ),
    };
    const planGate =
      plans.every((plan) => plan.usesIdentityHnsw) &&
      plans.every((plan) => !plan.usesSequentialScan);
    const latencyGate = size === 100_000
      ? vectorLookup.p95Ms <= GATES.vectorLookupP95Ms
        && endToEndRepository.p95Ms <= GATES.endToEndRepositoryP95Ms
      : vectorLookup.p95Ms <= GATES.smokeVectorLookupP95Ms
        && endToEndRepository.p95Ms <= GATES.smokeEndToEndRepositoryP95Ms;
    const latencyThresholds = size === 100_000
      ? {
          vectorLookupP95Ms: GATES.vectorLookupP95Ms,
          endToEndRepositoryP95Ms: GATES.endToEndRepositoryP95Ms,
        }
      : {
          vectorLookupP95Ms: GATES.smokeVectorLookupP95Ms,
          endToEndRepositoryP95Ms: GATES.smokeEndToEndRepositoryP95Ms,
        };
    const backupGate = backupRestore === null || (
      backupRestore.backupMs <= GATES.backupMs &&
      backupRestore.restoreMs <= GATES.restoreMs &&
      backupRestore.extensionInstalledFirst &&
      backupRestore.rowCountsMatched &&
      backupRestore.checksumsMatched &&
      backupRestore.identityHnswRestored &&
      backupRestore.repositoryQueryRestored &&
      backupRestore.vectorMigrationsIdempotent
    );
    const gatesPassed =
      indexedScanContract &&
      filtersVerified &&
      authorizationExcluded &&
      memoryGate &&
      planGate &&
      latencyGate &&
      recallAtK.unfiltered >= GATES.minimumUnfilteredRecallAtK &&
      recallAtK.filtered >= GATES.minimumFilteredRecallAtK &&
      backfillMs <= GATES.backfillMs &&
      indexBuildMs <= GATES.indexBuildMs &&
      lifecycle.repositoryUpdateMs <= GATES.repositoryUpdateMs &&
      lifecycle.repositoryUpdateStatus === 'updated' &&
      lifecycle.batchUpdateMs <= GATES.batchUpdateMs &&
      lifecycle.deleteAndExpiryMs <= GATES.deleteAndExpiryMs &&
      lifecycle.batchUpdated === 99 &&
      lifecycle.explicitlyDeleted === 100 &&
      lifecycle.expiredDeleted === 100 &&
      backupGate;

    return {
      entities: size,
      dimensions: config.dimensions,
      runs: config.queryRuns,
      warmupRuns: WARMUP_QUERY_RUNS,
      backfillMs,
      indexBuildMs,
      vectorLookup,
      endToEndRepository,
      latencyThresholds,
      planExecution: timingSummary(planExecutionMs),
      recallAtK,
      repository: {
        allQueriesUsedIndexedScanContract: indexedScanContract,
        filtersVerified,
        unauthorizedResults,
        authorizationExcluded,
      },
      authorizationCohorts: cohorts,
      plans: {
        identityIndexName: indexName,
        allUseIdentityHnsw: plans.every((plan) => plan.usesIdentityHnsw),
        anySequentialScan: plans.some((plan) => plan.usesSequentialScan),
      },
      storage,
      postgresMemory: {
        source: memoryBefore.source,
        required: config.postgresContainer !== null,
        measurable: memoryMeasurable,
        sameBackend:
          memoryBefore.source === 'backend-context-fallback'
            ? sameMemoryBackend
            : null,
        beforeBytes: memoryBefore.bytes,
        afterBytes: memoryAfter.bytes,
        deltaBytes:
          memoryBefore.bytes === null ||
          memoryAfter.bytes === null ||
          (memoryBefore.source === 'backend-context-fallback' && !sameMemoryBackend)
            ? null
            : memoryAfter.bytes - memoryBefore.bytes,
      },
      lifecycle,
      backupRestore,
      gatesPassed,
    };
  } finally {
    await cleanupIdentity(rawPool, identityId, indexName);
  }
}

async function main() {
  const config = configuration();
  const rawPool = new Pool({
    connectionString: config.connectionString,
    application_name: 'mission-control-pgvector-benchmark',
    max: 4,
  });
  const annQueryTimings: number[] = [];

  try {
    currentStage = 'core-migrations';
    await runPostgresMigrations(rawPool);
    currentStage = 'vector-capability';
    const vectorCapability = await initializePostgresVectorSupport(rawPool, {
      mode: 'required',
    });
    if (
      !vectorCapability.available ||
      vectorCapability.extensionVersion !== EXPECTED_VECTOR_VERSION
    ) {
      throw new Error('unsupported_vector_version');
    }
    const capability = await rawPool.query<{ postgres_version: string }>(
      `SELECT current_setting('server_version_num') AS postgres_version`,
    );
    const postgresVersion = Number(capability.rows[0]?.postgres_version ?? 0);
    if (postgresVersion < 170_000 || postgresVersion >= 180_000) {
      throw new Error('unsupported_postgres_version');
    }
    currentStage = 'synthetic-vector-function';
    await createSyntheticVectorFunction(rawPool);
    const repository = new PostgresSemanticIndexRepository(
      instrumentAnnQueries(rawPool, annQueryTimings),
      5_000,
      vectorCapability,
    );
    const results: BenchmarkResult[] = [];
    for (const size of CORPUS_SIZES) {
      currentStage = `corpus-${size}`;
      results.push(
        await benchmarkCorpus(rawPool, repository, annQueryTimings, config, size),
      );
    }
    const gatesPassed = results.every((result) => result.gatesPassed);
    console.log(JSON.stringify({
      benchmark: 'postgres-semantic-repository-pgvector-hnsw',
      postgresMajor: 17,
      vectorVersion: vectorCapability.extensionVersion,
      dimensions: config.dimensions,
      k: K,
      gates: GATES,
      results,
      gatesPassed,
    }));
    if (!gatesPassed) process.exitCode = 1;
  } finally {
    await rawPool.query(`DROP TABLE IF EXISTS ${STAGING_TABLE}`).catch(() => undefined);
    await rawPool.query(
      `DROP FUNCTION IF EXISTS ${SYNTHETIC_VECTOR_FUNCTION}(bigint, integer)`,
    ).catch(() => undefined);
    await rawPool.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const code = error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
      ? error.message
      : 'benchmark_failed';
    console.log(JSON.stringify({
      benchmark: 'postgres-semantic-repository-pgvector-hnsw',
      gatesPassed: false,
      error: code,
      stage: currentStage,
      postgresCode:
        typeof error === 'object'
          && error !== null
          && 'code' in error
          && typeof error.code === 'string'
          && /^[A-Z0-9]{5}$/u.test(error.code)
          ? error.code
          : null,
    }));
    process.exitCode = 1;
  });
}
