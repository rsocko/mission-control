import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { computeWebPersistenceGraph } from './web-persistence-graph';

const ROUTE_ROOTS = [
  'src/app/api/tasks/route.ts',
  'src/app/api/tasks/[id]/route.ts',
] as const;

const CLEAN_ROUTES = [
  ...ROUTE_ROOTS,
  'src/app/api/mcp/tasks/[id]/route.ts',
] as const;

const FORBIDDEN_ROUTE_IMPORTS = [
  /from\s+['"]@\/db(?:\/|['"])/,
  /from\s+['"]drizzle-orm(?:\/|['"])/,
  /from\s+['"]@\/lib\/connectors['"]/,
  /from\s+['"]@\/lib\/sync['"]/,
  /from\s+['"]@\/lib\/search['"]/,
  /from\s+['"]@\/lib\/triage\/actions['"]/,
  /from\s+['"]@\/lib\/connectors\/scout\/reconciliation-service['"]/,
  /import\(\s*['"]@\/db/,
] as const;

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/architecture/web-persistence-baseline.json'), 'utf8'),
) as {
  decrementHistory: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTaintedApiHelpers: string[];
    removedTaintedLibA: string[];
    removedTierARoutes: string[];
    newlyCleanRoutes: string[];
    tierBReclassifications: string[];
    notMigratedFromTheOwnedFileSet: unknown[];
  }>;
};

const current = computeWebPersistenceGraph(process.cwd());

describe('L07 task-write taint decrement', () => {
  it('makes exactly the two task roots and MCP forwarding route clean', () => {
    for (const route of CLEAN_ROUTES) {
      expect(current.cleanRoutes).toContain(route);
      expect(current.tierARoutes).not.toContain(route);
      expect(current.tierBRoutes).not.toContain(route);
    }
  });

  it('keeps owned route roots off database and mixed-domain barrels', () => {
    for (const route of ROUTE_ROOTS) {
      const source = readFileSync(join(process.cwd(), route), 'utf8');
      for (const forbidden of FORBIDDEN_ROUTE_IMPORTS) {
        expect(source, `${route} must not match ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it('records the exact decrement with no Tier-B reclassification or deferral', () => {
    const entry = baseline.decrementHistory.find((record) => record.layer === 'L07');
    expect(entry).toMatchObject({
      totalMigrationUnits: { from: 301, to: 298, delta: -3 },
      removedTaintedApiHelpers: [],
      removedTaintedLibA: [],
      removedTierARoutes: [...CLEAN_ROUTES],
      newlyCleanRoutes: [...CLEAN_ROUTES],
      tierBReclassifications: [],
      notMigratedFromTheOwnedFileSet: [],
    });
  });

  it('holds the exact approved graph after-set', () => {
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
      tierARoutes: 205,
      tierBRoutes: 26,
      cleanRoutes: 35,
      directTaintSourceRoutes: 132,
      transitiveOnlyTaintSourceRoutes: 73,
      directDbNamespaceRoutes: 133,
      taintedLibA: 92,
      taintedApiHelpers: 1,
      totalMigrationUnits: 298,
    });
  });
});
