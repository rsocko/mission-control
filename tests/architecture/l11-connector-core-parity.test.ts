import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/connectors/route.ts',
  'src/app/api/source-lists/[id]/route.ts',
  'src/app/api/source-lists/[id]/rename/route.ts',
  'src/app/api/source-lists/rename/route.ts',
  'src/app/api/source-lists/reorder/route.ts',
  'src/app/api/source-rankings/route.ts',
  'src/app/api/sync/deletions/[id]/route.ts',
  'src/app/api/sync/route.ts',
] as const;

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/architecture/web-persistence-baseline.json'), 'utf8'),
) as {
  decrementHistory?: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTierARoutes: string[];
    newlyCleanRoutes: string[];
    tierBReclassifications: string[];
    notMigratedFromTheOwnedFileSet: string[];
  }>;
};
const current = computeWebPersistenceGraph(process.cwd());

describe('L11 connector-core PostgreSQL parity', () => {
  it('records the exact eight-route decrement with no deferrals or reclassification', () => {
    const entry = baseline.decrementHistory?.find(({ layer }) => layer === 'L11');
    expect(entry).toBeDefined();
    expect(entry?.totalMigrationUnits).toEqual({ from: 313, to: 305, delta: -8 });
    expect(entry?.removedTierARoutes).toEqual([...OWNED_ROUTES]);
    expect(entry?.newlyCleanRoutes).toEqual([...OWNED_ROUTES]);
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it.each(OWNED_ROUTES)('%s is fully clean rather than deferred to Tier B', (route) => {
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
  });

  it.each(OWNED_ROUTES)('%s uses the connector composition seam without @/db', (route) => {
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    expect(source).toContain('@/lib/connectors/management-service');
    expect(source).not.toMatch(
      /(?:^|\n)\s*import\s+(?!type\b)[^;]*from\s+['"]@\/db(?:['"/])/,
    );
    expect(source).not.toMatch(/import\(\s*['"]@\/db/);
    expect(source).not.toMatch(/better-sqlite3/);
  });

  it('pins the approved post-L11 graph exactly', () => {
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
      tierARoutes: 113,
      tierBRoutes: 13,
      cleanRoutes: 140,
      directTaintSourceRoutes: 83,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 84,
      taintedLibA: 61,
      taintedApiHelpers: 0,
      totalMigrationUnits: 174,
    });
  });
});
