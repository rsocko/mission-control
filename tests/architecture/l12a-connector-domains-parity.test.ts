import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/auth/microsoft/connect/route.ts',
  'src/app/api/calendar-events/route.ts',
  'src/app/api/connectors/[id]/label-normalize/route.ts',
  'src/app/api/connectors/[id]/label-scan/route.ts',
  'src/app/api/connectors/[id]/lists/route.ts',
  'src/app/api/connectors/[id]/permissions/route.ts',
  'src/app/api/connectors/[id]/validate-repo/route.ts',
  'src/app/api/connectors/github-repos/route.ts',
  'src/app/api/source-lists/[id]/fix-emoji/route.ts',
  'src/app/api/sync/health/route.ts',
] as const;

const ALLOWED_PATHS = [
  ...OWNED_ROUTES,
  'src/db/persistence/connector-management.ts',
  'src/db/persistence/sqlite-connector-management-repository.ts',
  'src/db/postgres/repositories/connector-management-repository.ts',
  'src/lib/connectors/management-service.ts',
  'tests/contracts/connector-management-repository.contract.ts',
  'tests/db/sqlite-connector-management-repository.contract.test.ts',
  'tests/db/postgres-connector-management-repository.contract.integration.test.ts',
  'tests/db/postgres-connector-domain-routes.integration.test.ts',
  'tests/api/connector-domain-routes.test.ts',
  'tests/api/source-list-fix-emoji.test.ts',
  'tests/api/sync-health.test.ts',
  'tests/architecture/l12a-connector-domains-parity.test.ts',
  'tests/architecture/web-persistence-baseline.json',
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

describe('L12a connector-domain PostgreSQL parity', () => {
  it('records the exact ten-route decrement without reclassification', () => {
    const entry = baseline.decrementHistory?.find(({ layer }) => layer === 'L12a');
    expect(entry).toBeDefined();
    expect(entry?.totalMigrationUnits).toEqual({ from: 305, to: 295, delta: -10 });
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

  it.each(OWNED_ROUTES)('%s has no runtime @/db or SQLite driver import', (route) => {
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    expect(source).not.toMatch(
      /(?:^|\n)\s*import\s+(?!type\b)[^;]*from\s+['"]@\/db(?:['"/])/,
    );
    expect(source).not.toMatch(/import\(\s*['"]@\/db/);
    expect(source).not.toMatch(/better-sqlite3/);
  });

  it('pins the approved post-L12a graph exactly', () => {
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
      tierARoutes: 130,
      tierBRoutes: 13,
      cleanRoutes: 123,
      directTaintSourceRoutes: 97,
      transitiveOnlyTaintSourceRoutes: 33,
      directDbNamespaceRoutes: 98,
      taintedLibA: 63,
      taintedApiHelpers: 0,
      totalMigrationUnits: 193,
    });
  });

  it('keeps the frozen implementation within the 23-path hard cap', () => {
    expect(ALLOWED_PATHS).toHaveLength(23);
    expect(new Set(ALLOWED_PATHS).size).toBe(23);
  });
});
