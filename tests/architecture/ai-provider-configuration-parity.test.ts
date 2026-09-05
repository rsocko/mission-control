import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_PRODUCTION_PATHS = [
  'src/app/api/ai/models/route.ts',
  'src/app/api/ai/provider/route.ts',
  'src/db/persistence/core-repositories.ts',
  'src/db/persistence/sqlite-core-repositories.ts',
  'src/db/postgres/repositories/settings-repository.ts',
  'src/db/runtime.ts',
  'src/lib/ai/config-resolver.ts',
  'src/lib/ai/provider-configuration-service.ts',
  'src/lib/ai/provider-routing-core.ts',
  'src/lib/search/embedding-config-core.ts',
  'src/lib/search/embedding-provider-status.ts',
] as const;

const OWNED_TEST_PATHS = [
  'tests/api/ai-models-route.test.ts',
  'tests/api/ai-provider-routing.test.ts',
  'tests/architecture/ai-provider-configuration-parity.test.ts',
  'tests/architecture/analytics-taint-decrement.test.ts',
  'tests/architecture/external-agent-taint-decrement.test.ts',
  'tests/architecture/ideation-workspace-taint-decrement.test.ts',
  'tests/architecture/l11-connector-core-parity.test.ts',
  'tests/architecture/l12a-connector-domains-parity.test.ts',
  'tests/architecture/notification-web-taint-decrement.test.ts',
  'tests/architecture/project-hierarchy-taint-decrement.test.ts',
  'tests/architecture/task-core-taint-decrement.test.ts',
  'tests/architecture/task-read-taint-decrement.test.ts',
  'tests/architecture/task-write-taint-decrement.test.ts',
  'tests/architecture/transfer-identity-taint-decrement.test.ts',
  'tests/architecture/triage-native-web-persistence-boundary.test.ts',
  'tests/architecture/web-persistence-baseline.json',
  'tests/contracts/finance-assistant-persistence.contract.ts',
  'tests/contracts/settings-repository-batch.contract.ts',
  'tests/db/sqlite-settings-repository-batch.test.ts',
  'tests/db/postgres-settings-repository-batch.integration.test.ts',
  'tests/db/postgres-ai-provider-routes.integration.test.ts',
] as const;

const OWNED_ROUTES = [
  'src/app/api/ai/models/route.ts',
  'src/app/api/ai/provider/route.ts',
] as const;

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
    notMigratedFromTheOwnedFileSet: string[];
  }>;
};
const current = computeWebPersistenceGraph(process.cwd());

describe('L10 AI provider configuration parity', () => {
  it('pins the exact approved 32-path ownership boundary', () => {
    expect(OWNED_PRODUCTION_PATHS).toHaveLength(11);
    expect(OWNED_TEST_PATHS).toHaveLength(21);
    for (const path of [...OWNED_PRODUCTION_PATHS, ...OWNED_TEST_PATHS]) {
      expect(existsSync(join(process.cwd(), path)), `${path} must exist`).toBe(true);
    }
  });

  it('records exactly the two-route decrement with no Tier B reclassification', () => {
    const entry = baseline.decrementHistory?.find((record) => record.layer === 'L10');
    expect(entry).toBeDefined();
    expect(entry?.totalMigrationUnits).toEqual({ from: 206, to: 204, delta: -2 });
    expect(entry?.removedTierARoutes).toEqual([...OWNED_ROUTES]);
    expect(entry?.newlyCleanRoutes).toEqual([...OWNED_ROUTES]);
    expect(entry?.removedTaintedLibA).toEqual([]);
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it.each(OWNED_ROUTES)('%s is clean without a deferred database fallback', (route) => {
    expect(current.cleanRoutes).toContain(route);
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/db(?:['"/])/);
    expect(source).not.toMatch(/import\(\s*['"]@\/db/);
    expect(source).not.toMatch(/config-resolver|provider-factory|search\/semantic/);
  });

  it('keeps new services backend-neutral and hides all driver/schema handles', () => {
    for (const path of [
      'src/lib/ai/provider-configuration-service.ts',
      'src/lib/ai/provider-routing-core.ts',
      'src/lib/search/embedding-config-core.ts',
      'src/lib/search/embedding-provider-status.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(source).not.toMatch(/better-sqlite3|drizzle-orm|@\/db\/(?:schema|runtime)/);
      expect(source).not.toMatch(/import\(\s*['"]@\/db/);
    }
  });

  it('holds the exact recomputed graph after the decrement', () => {
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
      tierARoutes: 108,
      tierBRoutes: 5,
      cleanRoutes: 153,
      directTaintSourceRoutes: 78,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 79,
      taintedLibA: 55,
      taintedApiHelpers: 0,
      totalMigrationUnits: 163,
    });
  });
});
