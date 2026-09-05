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
    // The Tier B digest is the load-bearing one here. L17 reclassified exactly
    // one route -
    // `src/app/api/insights/observations/route.ts` - from an import-time
    // failure to a call-time one, because its only residual reach is a
    // deferred `import()` of the AI provider config resolver. That single
    // reclassification is declared in the baseline's `decrementHistory` and
    // asserted by `analytics-taint-decrement.test.ts`. L08a then removed its
    // eight owned Tier B triage routes, and runtime observability parity
    // removed six more. The non-route digests reflect the composed L16, L17,
    // L08a, and L18 removals; taintedApiHelpers remains empty.
    expect(digest(current.tierBRoutes))
      .toBe('2c839bdae24fab27c245d516a003c03e2952ee107ed6ba0c47ba41ffda86ff40');
    expect(digest(current.taintedLibA))
      .toBe('60fd13dc48ee641028587e1bddf3eb8ef57cfb000445996039ab99288629d1d6');
    expect(digest(current.taintedApiHelpers))
      .toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
    expect(current.taintedApiHelpers).toEqual([]);
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
      tierARoutes: 121,
      tierBRoutes: 5,
      cleanRoutes: 140,
      directTaintSourceRoutes: 91,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 92,
      taintedLibA: 58,
      taintedApiHelpers: 0,
      totalMigrationUnits: 179,
    });
  });
});
