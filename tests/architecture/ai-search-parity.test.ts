import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const PRODUCTION_PATHS = [
  'src/app/api/ai/search/route.ts',
  'src/db/persistence/core-repositories.ts',
  'src/db/index.ts',
  'src/db/persistence/sqlite-core-repositories.ts',
  'src/db/postgres/repositories/connector-repository.ts',
  'src/db/runtime.ts',
  'src/lib/search/embedding-request.ts',
  'src/lib/search/index.ts',
  'src/lib/search/semantic.ts',
] as const;
const TEST_PATHS = [
  'tests/contracts/connector-deleted-ids.contract.ts',
  'tests/db/sqlite-core-repositories.test.ts',
  'tests/db/postgres-core-repositories.integration.test.ts',
  'tests/api/ai-search-route.test.ts',
  'tests/api/ai-search-postgres-poisoned.test.ts',
  'tests/architecture/ai-search-parity.test.ts',
  'tests/helpers/process-runtime-registries.ts',
  'tests/search/embedding-provider-routing.test.ts',
  'tests/search/embedding-rebuild-route.test.ts',
  'tests/search/semantic-retrieval.test.ts',
  'tests/search/semantic-search-perf.test.ts',
  'tests/search/semantic-status.test.ts',
  'tests/search/task-embedding-neighbors.test.ts',
  'tests/search/staged-search.test.ts',
  'tests/search/search-publication.test.ts',
] as const;
const ARCHITECTURE_PATHS = [
  'tests/architecture/web-persistence-baseline.json',
  'docs/architecture/persistence-boundaries.md',
] as const;
const ROUTE = 'src/app/api/ai/search/route.ts';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const baseline = JSON.parse(source('tests/architecture/web-persistence-baseline.json')) as {
  decrementHistory: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTierARoutes: string[];
    removedTaintedLibA: string[];
    newlyCleanRoutes: string[];
    removedDirectTaintSourceRoutes: string[];
    removedDirectDbNamespaceRoutes: string[];
    tierBReclassifications: string[];
    notMigratedFromTheOwnedFileSet: string[];
  }>;
};
const current = computeWebPersistenceGraph(process.cwd());

describe('L20 AI search visibility parity', () => {
  it('pins the exact approved 26-path cap', () => {
    expect(PRODUCTION_PATHS).toHaveLength(9);
    expect(TEST_PATHS).toHaveLength(15);
    expect(ARCHITECTURE_PATHS).toHaveLength(2);
    for (const path of [...PRODUCTION_PATHS, ...TEST_PATHS, ...ARCHITECTURE_PATHS]) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });

  it('records exactly the one-route decrement with no reclassification', () => {
    const entry = baseline.decrementHistory.find(({ layer }) => layer === 'L20');
    expect(entry?.totalMigrationUnits).toEqual({ from: 167, to: 163, delta: -4 });
    expect(entry?.removedTaintedLibA).toEqual([
      'src/lib/search/embedding-request.ts',
      'src/lib/search/index.ts',
      'src/lib/search/semantic.ts',
    ]);
    expect(entry?.removedTierARoutes).toEqual([ROUTE]);
    expect(entry?.newlyCleanRoutes).toEqual([ROUTE]);
    expect(entry?.removedDirectTaintSourceRoutes).toEqual([ROUTE]);
    expect(entry?.removedDirectDbNamespaceRoutes).toEqual([ROUTE]);
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it('keeps the route clean and the search libraries backend-neutral', () => {
    expect(current.cleanRoutes).toContain(ROUTE);
    expect(current.tierARoutes).not.toContain(ROUTE);
    expect(current.tierBRoutes).not.toContain(ROUTE);
    expect(current.directTaintSourceRoutes).not.toContain(ROUTE);
    expect(current.directDbNamespaceRoutes).not.toContain(ROUTE);

    const route = source(ROUTE);
    expect(route).toContain("typeof connectorRepository.listDeletedIds !== 'function'");
    expect(route).toContain('connectorRepository.listDeletedIds()');
    expect(route).toContain("from '@/lib/search/semantic'");
    expect(route).not.toMatch(/(?:from\s*['"]@\/db(?:['"/])|import\(\s*['"]@\/db)/);
    expect(route).not.toMatch(/better-sqlite3|\bfrom\s*['"]pg['"]|\bdrizzle-orm\b/);
    for (const path of [
      'src/lib/search/embedding-request.ts',
      'src/lib/search/index.ts',
      'src/lib/search/semantic.ts',
      'src/lib/search/fts.ts',
      'src/lib/search/keyword-runtime.ts',
      'src/lib/search/repository.ts',
    ]) {
      expect(source(path), path).not.toMatch(
        /better-sqlite3|\bfrom\s*['"]pg['"]|@\/db(?:['"/])/,
      );
    }
  });

  it('keeps the neutral contract driver-free and adapter ordering explicit', () => {
    expect(source('src/db/persistence/core-repositories.ts')).not.toMatch(
      /better-sqlite3|\bfrom\s*['"]pg['"]|drizzle-orm|@\/db\/schema|@\/db\/postgres/,
    );
    expect(source('src/db/persistence/sqlite-core-repositories.ts'))
      .toContain('ORDER BY id COLLATE BINARY');
    expect(source('src/db/postgres/repositories/connector-repository.ts'))
      .toContain('COLLATE "C"');
    expect(source('src/db/runtime.ts'))
      .toContain('PostgreSQL connector deleted-ID repository has not been registered');
    expect(source('src/db/runtime.ts'))
      .toContain('return repository.listDeletedIds()');
    expect(source('src/db/index.ts'))
      .toContain("from '@/lib/semantic-index/runtime'");
    expect(source('src/db/index.ts')).not.toMatch(
      /import\(\s*['"]@\/lib\/semantic-index\/runtime['"]\s*\)/,
    );
    expect(source('src/db/runtime.ts')).not.toMatch(
      /(?:from\s*['"]@\/lib\/semantic-index\/runtime['"]|import\(\s*['"]@\/lib\/semantic-index\/runtime['"]\s*\))/,
    );
  });

  it('holds the exact composed graph after the decrement', () => {
    expect({
      apiRoutes: current.apiRoutes.length,
      tierARoutes: current.tierARoutes.length,
      tierBRoutes: current.tierBRoutes.length,
      cleanRoutes: current.cleanRoutes.length,
      directTaintSourceRoutes: current.directTaintSourceRoutes.length,
      transitiveOnlyTaintSourceRoutes: current.transitiveOnlyTaintSourceRoutes.length,
      directDbNamespaceRoutes: current.directDbNamespaceRoutes.length,
      taintedLibA: current.taintedLibA.length,
      taintedApiHelpers: current.taintedApiHelpers.length,
      totalMigrationUnits: current.totalMigrationUnits,
    }).toEqual({
      apiRoutes: 266,
      tierARoutes: 109,
      tierBRoutes: 5,
      cleanRoutes: 152,
      directTaintSourceRoutes: 79,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 80,
      taintedLibA: 54,
      taintedApiHelpers: 0,
      totalMigrationUnits: 163,
    });
  });
});
