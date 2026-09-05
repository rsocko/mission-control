import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const ROUTES = [
  'src/app/api/external-agents/[id]/route.ts',
  'src/app/api/external-agents/dispatch/route.ts',
  'src/app/api/external-agents/dispatches/[id]/result/route.ts',
  'src/app/api/external-agents/dispatches/[id]/route.ts',
  'src/app/api/external-agents/dispatches/claim/route.ts',
  'src/app/api/external-agents/dispatches/route.ts',
  'src/app/api/external-agents/import/route.ts',
  'src/app/api/external-agents/route.ts',
] as const;
const LIBRARIES = [
  'src/lib/external-agents/http.ts',
  'src/lib/external-agents/policy.ts',
  'src/lib/external-agents/registry.ts',
  'src/lib/external-agents/service.ts',
  'src/lib/external-agents/transports.ts',
] as const;

const baseline = JSON.parse(readFileSync(
  join(process.cwd(), 'tests/architecture/web-persistence-baseline.json'),
  'utf8',
)) as {
  decrementHistory: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTaintedLibA: string[];
    removedTierARoutes: string[];
    newlyCleanRoutes: string[];
    tierBReclassifications: string[];
    notMigratedFromTheOwnedFileSet: unknown[];
  }>;
};
const current = computeWebPersistenceGraph(process.cwd());

describe('L14 external-agent taint decrement', () => {
  it('records the exact historical decrement', () => {
    const entry = baseline.decrementHistory.find(({ layer }) => layer === 'L14');
    expect(entry?.totalMigrationUnits).toEqual({ from: 305, to: 292, delta: -13 });
    expect(entry?.removedTaintedLibA.sort()).toEqual([...LIBRARIES].sort());
    expect(entry?.removedTierARoutes.sort()).toEqual([...ROUTES].sort());
    expect(entry?.newlyCleanRoutes.sort()).toEqual([...ROUTES].sort());
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it.each(ROUTES)('%s is clean', (route) => {
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
  });

  it.each(LIBRARIES)('%s has no persistence taint or relocation', (path) => {
    expect(current.taintedLibA).not.toContain(path);
    const source = readFileSync(join(process.cwd(), path), 'utf8');
    expect(source).not.toMatch(/(?:from\s*['"]@\/db(?:['"/])|import\(\s*['"]@\/db)/);
    expect(source).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3/);
  });

  it('holds the exact composed graph', () => {
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
});
