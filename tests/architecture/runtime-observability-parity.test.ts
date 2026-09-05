import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/health/live/route.ts',
  'src/app/api/health/ready/route.ts',
  'src/app/api/health/route.ts',
  'src/app/api/health/runtime/route.ts',
  'src/app/api/metrics/route.ts',
  'src/app/api/telemetry/runtime/route.ts',
] as const;

const graph = computeWebPersistenceGraph(process.cwd());

describe('runtime observability PostgreSQL parity', () => {
  it('moves every owned route from Tier B to clean without reclassification', () => {
    for (const route of OWNED_ROUTES) {
      expect(graph.tierARoutes).not.toContain(route);
      expect(graph.tierBRoutes).not.toContain(route);
      expect(graph.cleanRoutes).toContain(route);
    }
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

  it('keeps backend selection and SQLite evaluation out of route-facing seams', () => {
    const neutralFiles = [
      'src/lib/telemetry/database-health-runtime.ts',
      'src/lib/telemetry/health-snapshot-runtime.ts',
      'src/lib/telemetry/runtime-persistence.ts',
      'src/lib/telemetry/runtime.ts',
    ];
    for (const path of neutralFiles) {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(source).not.toMatch(/from ['"]@\/db(?:\/|['"])/);
      expect(source).not.toContain("import('@/db");
      expect(source).not.toContain('better-sqlite3');
      expect(source).not.toContain('resolveDatabaseBackend');
    }
  });
});
