import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/connectors/[id]/cross-account/route.ts',
  'src/app/api/sync/tasks/resolve/route.ts',
] as const;

const EXCLUDED_ROUTES = [
  'src/app/api/connectors/[id]/retained-lists/[sourceListId]/route.ts',
  'src/app/api/connectors/github-bulk-transfer/route.ts',
  'src/app/api/sync/cleanup/route.ts',
  'src/app/api/sync/retained/resolve/route.ts',
] as const;

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const baseline = JSON.parse(
  source('tests/architecture/web-persistence-baseline.json'),
) as {
  decrementHistory: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTierARoutes: string[];
    newlyCleanRoutes: string[];
    removedDirectTaintSourceRoutes: string[];
    removedDirectDbNamespaceRoutes: string[];
    tierBReclassifications: string[];
    excludedRoutes?: string[];
  }>;
};
const graph = computeWebPersistenceGraph(process.cwd());

describe('connector transfer/sync control-plane taint decrement', () => {
  it('records the exact bounded decrement and exclusions', () => {
    const entry = baseline.decrementHistory.find(
      ({ layer }) => layer === 'connector-transfer-sync-control-plane',
    );
    expect(entry?.totalMigrationUnits).toEqual({ from: 167, to: 165, delta: -2 });
    expect(entry?.removedTierARoutes).toEqual([...OWNED_ROUTES]);
    expect(entry?.newlyCleanRoutes).toEqual([...OWNED_ROUTES]);
    expect(entry?.removedDirectTaintSourceRoutes).toEqual([...OWNED_ROUTES]);
    expect(entry?.removedDirectDbNamespaceRoutes).toEqual([...OWNED_ROUTES]);
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.excludedRoutes).toEqual([...EXCLUDED_ROUTES]);
  });

  it.each(OWNED_ROUTES)('%s is clean rather than deferred', (route) => {
    expect(graph.cleanRoutes).toContain(route);
    expect(graph.tierARoutes).not.toContain(route);
    expect(graph.tierBRoutes).not.toContain(route);
    expect(graph.directTaintSourceRoutes).not.toContain(route);
    expect(graph.directDbNamespaceRoutes).not.toContain(route);
    expect(source(route)).not.toMatch(
      /from\s+['"]@\/db(?:\/|['"])|import\(\s*['"]@\/db|better-sqlite3|drizzle-orm/,
    );
  });

  it('keeps the excluded candidate routes in their prior graph tiers', () => {
    expect(graph.tierARoutes).toContain(EXCLUDED_ROUTES[0]);
    expect(graph.tierBRoutes).toContain(EXCLUDED_ROUTES[1]);
    expect(graph.tierARoutes).toContain(EXCLUDED_ROUTES[2]);
    expect(graph.tierBRoutes).toContain(EXCLUDED_ROUTES[3]);
  });

  it('pins the exact composed graph without Tier B growth', () => {
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
      tierARoutes: 108,
      tierBRoutes: 5,
      cleanRoutes: 153,
      directTaintSourceRoutes: 78,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 79,
      taintedLibA: 57,
      taintedApiHelpers: 0,
      totalMigrationUnits: 165,
    });
  });

  it('pins the SQLite-poisoned PostgreSQL route proofs', () => {
    expect(source('tests/api/cross-account-validation.test.ts')).toContain(
      'POISONED: cross-account route must not import SQLite',
    );
    expect(source('tests/api/sync-task-resolution-postgres-poisoned.test.ts')).toContain(
      'POISONED: sync task resolution must not import SQLite',
    );
  });
});
