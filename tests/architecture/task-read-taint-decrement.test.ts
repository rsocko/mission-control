import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const ROUTES = [
  'src/app/api/tasks/[id]/attachments/[attachmentId]/route.ts',
  'src/app/api/tasks/[id]/document-preview/route.ts',
  'src/app/api/tasks/[id]/linked-sources/route.ts',
  'src/app/api/tasks/[id]/relationship-candidates/route.ts',
  'src/app/api/tasks/detect-duplicates/route.ts',
  'src/app/api/tasks/filter-options/route.ts',
  'src/app/api/tasks/group-counts/route.ts',
  'src/app/api/tasks/quick-sort/route.ts',
  'src/app/api/tasks/quick-sort/suggestions/route.ts',
] as const;

const DEFERRED_LIBRARIES = [
  'src/lib/ai/config-resolver.ts',
  'src/lib/ai/provider-factory.ts',
  'src/lib/graph/neighbors-service.ts',
  'src/lib/graph/service.ts',
  'src/lib/search/embedding-request.ts',
  'src/lib/search/semantic.ts',
  'src/lib/semantic-index/config.ts',
  'src/lib/semantic-index/runtime.ts',
  'src/lib/semantic-index/sensitivity.ts',
] as const;

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/architecture/web-persistence-baseline.json'), 'utf8'),
) as {
  tierBRoutes: string[];
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

describe('L05 task-read taint decrement', () => {
  it('makes exactly the nine approved route roots clean', () => {
    for (const route of ROUTES) {
      expect(current.cleanRoutes).toContain(route);
      expect(current.tierARoutes).not.toContain(route);
      expect(current.tierBRoutes).not.toContain(route);
    }
  });

  it('keeps route modules free of database, Drizzle, and mixed graph imports', () => {
    for (const route of ROUTES) {
      const source = readFileSync(join(process.cwd(), route), 'utf8');
      expect(source).not.toMatch(/from\s+['"]@\/db(?:\/|['"])/);
      expect(source).not.toMatch(/from\s+['"]drizzle-orm(?:\/|['"])/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/graph\/service['"]/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/sync(?:\/|['"])/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/connectors['"]/);
      expect(source).not.toMatch(/import\(\s*['"]@\/db/);
    }
  });

  it('leaves every deferred mixed library visible as a normal Tier A unit', () => {
    for (const library of DEFERRED_LIBRARIES) {
      expect(current.taintedLibA).toContain(library);
    }
  });

  it('preserves the exact pre-L05 Tier B and non-route taint sets', () => {
    const digest = (entries: string[]) => createHash('sha256')
      .update(JSON.stringify(entries))
      .digest('hex');
    expect(digest(current.tierBRoutes))
      .toBe('dbf5405c2e0d0829788e8359ec21c76229969ddad055257fdd6b25babda34b59');
    expect(digest(current.taintedLibA))
      .toBe('77ddad1d399193465a5923d89dfa36d6bc0629e7b1e94895211c5eab42535b08');
    expect(digest(current.taintedApiHelpers))
      .toBe('b412e594fc79dc685267810475becf3c8f4b27cb58343eecc8cbddd2360b3abf');
    expect(current.tierBRoutes).toEqual(baseline.tierBRoutes);
  });

  it('records the exact decrement and global counts', () => {
    const entry = baseline.decrementHistory.find((record) => record.layer === 'L05');
    expect(entry).toMatchObject({
      totalMigrationUnits: { from: 310, to: 301, delta: -9 },
      removedTaintedApiHelpers: [],
      removedTaintedLibA: [],
      removedTierARoutes: [...ROUTES],
      newlyCleanRoutes: [...ROUTES],
      tierBReclassifications: [],
      notMigratedFromTheOwnedFileSet: [],
    });
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
      tierARoutes: 186,
      tierBRoutes: 26,
      cleanRoutes: 54,
      directTaintSourceRoutes: 124,
      transitiveOnlyTaintSourceRoutes: 62,
      directDbNamespaceRoutes: 125,
      taintedLibA: 85,
      taintedApiHelpers: 1,
      totalMigrationUnits: 272,
    });
  });
});
