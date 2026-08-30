import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateResourceGates,
  inspectExplainPlan,
  percentile,
  POSTGRES_VECTOR_100K_RESOURCE_CEILINGS,
} from '../../scripts/benchmark-postgres-vector';

describe('PostgreSQL vector benchmark helpers', () => {
  it('computes nearest-rank percentiles deterministically', () => {
    expect(percentile([9, 1, 5, 3], 0.5)).toBe(3);
    expect(percentile([9, 1, 5, 3], 0.95)).toBe(9);
  });

  it('proves the expected HNSW plan without accepting a sequential scan', () => {
    expect(inspectExplainPlan([{
      Plan: {
        'Node Type': 'Limit',
        Plans: [{
          'Node Type': 'Index Scan',
          'Index Name': 'idx_semantic_ann_identity',
        }],
      },
      'Execution Time': 4.25,
    }], 'idx_semantic_ann_identity')).toEqual({
      executionTimeMs: 4.25,
      usesIdentityHnsw: true,
      usesSequentialScan: false,
    });
  });

  it('detects a sequential fallback even when another branch uses HNSW', () => {
    const plan = inspectExplainPlan([{
      Plan: {
        'Node Type': 'Append',
        Plans: [
          {
            'Node Type': 'Index Scan',
            'Index Name': 'benchmark_documents_embedding_hnsw',
          },
          { 'Node Type': 'Seq Scan' },
        ],
      },
      'Execution Time': 8,
    }]);

    expect(plan.usesIdentityHnsw).toBe(true);
    expect(plan.usesSequentialScan).toBe(true);
  });

  it('passes 100k resource measurements at their explicit ceilings', () => {
    expect(evaluateResourceGates(
      100_000,
      {
        memoryDeltaBytes: POSTGRES_VECTOR_100K_RESOURCE_CEILINGS.memoryDeltaBytes,
        productionTableBytes:
          POSTGRES_VECTOR_100K_RESOURCE_CEILINGS.productionTableBytes,
        identityIndexBytes:
          POSTGRES_VECTOR_100K_RESOURCE_CEILINGS.identityIndexBytes,
      },
      true,
    )).toEqual({
      memoryDeltaPassed: true,
      productionTablePassed: true,
      identityIndexPassed: true,
      passed: true,
    });
  });

  it.each([
    ['memory', {
      memoryDeltaBytes: POSTGRES_VECTOR_100K_RESOURCE_CEILINGS.memoryDeltaBytes + 1,
      productionTableBytes:
        POSTGRES_VECTOR_100K_RESOURCE_CEILINGS.productionTableBytes,
      identityIndexBytes:
        POSTGRES_VECTOR_100K_RESOURCE_CEILINGS.identityIndexBytes,
    }],
    ['table', {
      memoryDeltaBytes: POSTGRES_VECTOR_100K_RESOURCE_CEILINGS.memoryDeltaBytes,
      productionTableBytes:
        POSTGRES_VECTOR_100K_RESOURCE_CEILINGS.productionTableBytes + 1,
      identityIndexBytes:
        POSTGRES_VECTOR_100K_RESOURCE_CEILINGS.identityIndexBytes,
    }],
    ['index', {
      memoryDeltaBytes: POSTGRES_VECTOR_100K_RESOURCE_CEILINGS.memoryDeltaBytes,
      productionTableBytes:
        POSTGRES_VECTOR_100K_RESOURCE_CEILINGS.productionTableBytes,
      identityIndexBytes:
        POSTGRES_VECTOR_100K_RESOURCE_CEILINGS.identityIndexBytes + 1,
    }],
  ])('fails the 100k %s resource ceiling above its boundary', (_name, measurements) => {
    expect(evaluateResourceGates(100_000, measurements, true).passed).toBe(false);
  });

  it('requires the 100k memory measurement in the pinned container gate', () => {
    const measurements = {
      memoryDeltaBytes: null,
      productionTableBytes: 1,
      identityIndexBytes: 1,
    };
    expect(evaluateResourceGates(100_000, measurements, true).passed).toBe(false);
    expect(evaluateResourceGates(100_000, measurements, false).passed).toBe(true);
  });

  it('uses the production repository and performs a real custom-format restore', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts', 'benchmark-postgres-vector.ts'),
      'utf8',
    );

    expect(source).toContain('PostgresSemanticIndexRepository');
    expect(source).toContain('repository.queryVectors(request)');
    expect(source).toContain('repository.markIdentityReady(identityId');
    expect(source).toContain('resolvePostgresConfig');
    expect(source).toContain("throw new Error('non_production_statement_timeout')");
    expect(source).toContain('poolStatementTimeoutMs: postgresConfig.pool.statement_timeout');
    expect(source).not.toContain("SET maintenance_work_mem = '512MB'");
    expect(source).toContain("'--format=custom'");
    expect(source).not.toContain("'--table'");
    expect(source).toContain("executable: 'pg_dump'");
    expect(source).toContain("executable: 'pg_restore'");
    expect(source).toContain("initializePostgresVectorSupport(restorePool");
    expect(source).toContain('vectorMigrationsIdempotent');
    expect(source).toMatch(
      /async function exactReference[\s\S]*ORDER BY a\.embedding <=> \$\$\{vectorParam\}::vector/u,
    );
    expect(source).toContain("THEN 'project' ELSE 'task'");
    expect(source).toContain("THEN 'restricted' ELSE 'standard'");
    expect(source).toContain('dimension::bigint * 32452843');
    expect(source).toContain('unauthorizedResults');
    expect(source).toContain('repository.upsertVector(repositoryUpdate)');
    expect(source).toContain('/sys/fs/cgroup/memory.current');
    expect(source).toContain('WARMUP_QUERY_RUNS = 2');
    expect(source).not.toContain('database-local-logical-copy');
  });
});
