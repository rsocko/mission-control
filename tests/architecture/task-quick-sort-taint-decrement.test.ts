import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/tasks/quick-sort-stats/route.ts',
  'src/app/api/tasks/quick-sort/operations/[id]/undo/route.ts',
  'src/app/api/tasks/quick-sort/operations/route.ts',
] as const;

const OWNED_LIBRARY = 'src/lib/quick-sort/operations.ts';
const FORBIDDEN_PERSISTENCE = /from\s+['"]@\/db(?:\/|['"])|import\(\s*['"]@\/db|better-sqlite3|drizzle-orm/;

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/architecture/web-persistence-baseline.json'), 'utf8'),
) as {
  decrementHistory?: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTaintedLibA: string[];
    removedTierARoutes: string[];
    newlyCleanRoutes: string[];
    tierBReclassifications: string[];
    notMigratedFromTheOwnedFileSet: unknown[];
  }>;
};

const graph = computeWebPersistenceGraph(process.cwd());

describe('task quick-sort persistence decrement', () => {
  it('records the exact bounded layer with no deferrals or reclassifications', () => {
    const entry = baseline.decrementHistory?.find((record) => record.layer === 'task-quick-sort');
    expect(entry).toBeDefined();
    expect(entry?.totalMigrationUnits).toEqual({ from: 182, to: 178, delta: -4 });
    expect(entry?.removedTaintedLibA).toEqual([OWNED_LIBRARY]);
    expect(entry?.removedTierARoutes).toEqual(OWNED_ROUTES);
    expect(entry?.newlyCleanRoutes).toEqual(OWNED_ROUTES);
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it.each([...OWNED_ROUTES, OWNED_LIBRARY])('%s evaluates no persistence driver surface', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).not.toMatch(FORBIDDEN_PERSISTENCE);
  });

  it.each(OWNED_ROUTES)('%s is clean rather than deferred', (route) => {
    expect(graph.cleanRoutes).toContain(route);
    expect(graph.tierARoutes).not.toContain(route);
    expect(graph.tierBRoutes).not.toContain(route);
  });

  it('pins the exact graph after the decrement', () => {
    expect({
      apiRoutes: graph.apiRoutes.length,
      tierARoutes: graph.tierARoutes.length,
      tierBRoutes: graph.tierBRoutes.length,
      cleanRoutes: graph.cleanRoutes.length,
      directTaintSourceRoutes: graph.directTaintSourceRoutes.length,
      transitiveOnlyTaintSourceRoutes: graph.transitiveOnlyTaintSourceRoutes.length,
      directDbNamespaceRoutes: graph.directDbNamespaceRoutes.length,
      taintedLibA: graph.taintedLibA.length,
      taintedApiHelpers: graph.taintedApiHelpers.length,
      totalMigrationUnits: graph.totalMigrationUnits,
    }).toEqual({
      apiRoutes: 266,
      tierARoutes: 107,
      tierBRoutes: 5,
      cleanRoutes: 154,
      directTaintSourceRoutes: 77,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 78,
      taintedLibA: 56,
      taintedApiHelpers: 0,
      totalMigrationUnits: 163,
    });
  });
});
