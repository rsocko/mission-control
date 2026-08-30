import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectExplainPlan,
  percentile,
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

  it('uses the production repository and performs a real custom-format restore', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts', 'benchmark-postgres-vector.ts'),
      'utf8',
    );

    expect(source).toContain('PostgresSemanticIndexRepository');
    expect(source).toContain('repository.queryVectors(request)');
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
    expect(source).not.toContain('database-local-logical-copy');
  });
});
