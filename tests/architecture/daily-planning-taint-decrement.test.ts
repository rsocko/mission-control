import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const ROUTE = 'src/app/api/daily-completions/route.ts';
const BASELINE = 'tests/architecture/web-persistence-baseline.json';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const current = computeWebPersistenceGraph(process.cwd());
const baseline = JSON.parse(source(BASELINE)) as {
  decrementHistory: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTaintedApiHelpers: string[];
    removedTaintedLibA: string[];
    removedTierARoutes: string[];
    newlyCleanRoutes: string[];
    tierBReclassifications: string[];
    notMigratedFromTheOwnedFileSet: string[];
  }>;
};

describe('daily planning read-model taint decrement', () => {
  it('records the exact one-route decrement', () => {
    const entry = baseline.decrementHistory.find(
      ({ layer }) => layer === 'daily-planning-read-model',
    );
    expect(entry).toMatchObject({
      totalMigrationUnits: { from: 167, to: 166, delta: -1 },
      removedTaintedApiHelpers: [],
      removedTaintedLibA: [],
      removedTierARoutes: [ROUTE],
      newlyCleanRoutes: [ROUTE],
      tierBReclassifications: [],
      notMigratedFromTheOwnedFileSet: [],
    });
  });

  it('keeps the route clean and delegates through the landed analytics repository', () => {
    expect(current.cleanRoutes).toContain(ROUTE);
    expect(current.tierARoutes).not.toContain(ROUTE);
    expect(current.tierBRoutes).not.toContain(ROUTE);
    expect(current.directDbNamespaceRoutes).not.toContain(ROUTE);

    const text = source(ROUTE);
    expect(text).toContain(
      "import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime'",
    );
    expect(text).toContain('.analytics.kpis');
    expect(text).toContain('countTasksCompletedIn');
    expect(text).not.toMatch(/from\s*['"]@\/db(?:['"/])|import\(\s*['"]@\/db/);
    expect(text).not.toMatch(/drizzle-orm|better-sqlite3|@\/lib\/utils\/sqlite-date/);
    expect(text).not.toMatch(/resolveDatabaseBackend|MC_DATABASE_BACKEND|fallback/i);
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
      tierARoutes: 109,
      tierBRoutes: 5,
      cleanRoutes: 152,
      directTaintSourceRoutes: 79,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 80,
      taintedLibA: 57,
      taintedApiHelpers: 0,
      totalMigrationUnits: 166,
    });
  });
});
