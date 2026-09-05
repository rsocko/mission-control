import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/push/preferences/route.ts',
  'src/app/api/push/scheduler/route.ts',
] as const;

const OWNED_LIBS = [
  'src/lib/notifications/quiet-hours.ts',
  'src/lib/push/scheduler.ts',
] as const;

const PRODUCTION_PATHS = [
  ...OWNED_ROUTES,
  'src/db/persistence/notification-delivery.ts',
  'src/db/persistence/notification-push.ts',
  'src/db/persistence/sqlite-notification-delivery-repository.ts',
  'src/db/persistence/sqlite-notification-push-repository.ts',
  'src/db/postgres/repositories/notification-delivery-repository.ts',
  'src/db/postgres/repositories/notification-push-repository.ts',
  'src/instrumentation.ts',
  ...OWNED_LIBS,
  'src/lib/push/notification-push-service.ts',
] as const;

const TEST_PATHS = [
  'tests/api/push-preferences.test.ts',
  'tests/api/push-scheduler.test.ts',
  'tests/architecture/ai-execution-memory-parity.test.ts',
  'tests/architecture/ai-provider-configuration-parity.test.ts',
  'tests/architecture/analytics-taint-decrement.test.ts',
  'tests/architecture/external-agent-taint-decrement.test.ts',
  'tests/architecture/finance-connector-web-parity.test.ts',
  'tests/architecture/finance-web-parity.test.ts',
  'tests/architecture/ideation-workspace-taint-decrement.test.ts',
  'tests/architecture/l11-connector-core-parity.test.ts',
  'tests/architecture/l12a-connector-domains-parity.test.ts',
  'tests/architecture/notification-push-taint-decrement.test.ts',
  'tests/architecture/notification-web-taint-decrement.test.ts',
  'tests/architecture/project-hierarchy-taint-decrement.test.ts',
  'tests/architecture/project-organization-taint-decrement.test.ts',
  'tests/architecture/runtime-observability-parity.test.ts',
  'tests/architecture/task-core-taint-decrement.test.ts',
  'tests/architecture/task-quick-sort-taint-decrement.test.ts',
  'tests/architecture/task-read-taint-decrement.test.ts',
  'tests/architecture/task-write-taint-decrement.test.ts',
  'tests/architecture/transfer-identity-taint-decrement.test.ts',
  'tests/architecture/triage-native-web-persistence-boundary.test.ts',
  'tests/architecture/web-persistence-baseline.json',
  'tests/contracts/notification-push-repository.contract.ts',
  'tests/contracts/finance-assistant-persistence.contract.ts',
  'tests/db/notification-push-postgres-import-safety.test.ts',
  'tests/db/postgres-notification-push-repository.integration.test.ts',
  'tests/db/sqlite-notification-push-repository.test.ts',
  'tests/notifications/scheduled-trigger-dedup.test.ts',
] as const;

const ARCHITECTURE_PATHS = [
  'docs/architecture/persistence-boundaries.md',
] as const;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/architecture/web-persistence-baseline.json'), 'utf8'),
) as {
  decrementHistory?: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTaintedLibA: string[];
    removedTierARoutes: string[];
    newlyCleanRoutes: string[];
    removedDirectTaintSourceRoutes?: string[];
    removedDirectDbNamespaceRoutes?: string[];
    removedTransitiveOnlyTaintSourceRoutes?: string[];
    tierBReclassifications: string[];
    notMigratedFromTheOwnedFileSet: Array<{ file: string; reason: string }>;
  }>;
};

const current = computeWebPersistenceGraph(process.cwd());

describe('notification push taint decrement', () => {
  it('pins the CI-proven 42-path cap and its 12 production paths', () => {
    expect(PRODUCTION_PATHS).toHaveLength(12);
    expect(TEST_PATHS).toHaveLength(29);
    expect(ARCHITECTURE_PATHS).toHaveLength(1);
    const paths = [...PRODUCTION_PATHS, ...TEST_PATHS, ...ARCHITECTURE_PATHS];
    expect(paths).toHaveLength(42);
    expect(new Set(paths).size).toBe(42);
    for (const path of paths) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });

  it('composes the push port atomically without a parallel selector or trigger cycle', () => {
    expect(source('src/db/persistence/notification-delivery.ts'))
      .toContain('push: NotificationPushPersistence');
    expect(source('src/db/persistence/sqlite-notification-delivery-repository.ts'))
      .toContain('push: createSqliteNotificationPushRepository(sqlite)');
    expect(source('src/db/postgres/repositories/notification-delivery-repository.ts'))
      .toContain('push: createPostgresNotificationPushRepository(pool)');

    const service = source('src/lib/push/notification-push-service.ts');
    expect(service).toContain('repositories.notificationDelivery.push');
    expect(service).not.toMatch(/getProcessRuntimeSlot|resolveDatabaseBackend|fallback/i);
    expect(source('src/lib/push/scheduler.ts')).not.toMatch(
      /from\s*['"](?:@\/lib\/push\/triggers|\.\/triggers)['"]/,
    );
    expect(source('src/instrumentation.ts')).toContain('registerScheduledPushHandlers({');
  });

  it('records the exact owned decrement with no deferred migration', () => {
    const entry = baseline.decrementHistory?.find(
      item => item.layer === 'notification-push',
    );
    expect(entry).toBeDefined();
    expect(entry?.totalMigrationUnits).toEqual({ from: 167, to: 163, delta: -4 });
    expect(entry?.removedTierARoutes.sort()).toEqual([...OWNED_ROUTES].sort());
    expect(entry?.newlyCleanRoutes.sort()).toEqual([...OWNED_ROUTES].sort());
    expect(entry?.removedDirectTaintSourceRoutes?.sort()).toEqual([...OWNED_ROUTES].sort());
    expect(entry?.removedDirectDbNamespaceRoutes?.sort()).toEqual([...OWNED_ROUTES].sort());
    expect(entry?.removedTransitiveOnlyTaintSourceRoutes).toEqual([]);
    expect(entry?.removedTaintedLibA.sort()).toEqual([...OWNED_LIBS].sort());
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it.each(OWNED_ROUTES)('%s is clean and evaluates no database handle', (route) => {
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    expect(source).not.toMatch(/from\s*['"]@\/db['"]/);
    expect(source).not.toMatch(/import\(\s*['"]@\/db['"]\s*\)/);
    expect(source).not.toMatch(/better-sqlite3/);
  });

  it.each(OWNED_LIBS)('%s is no longer import-time tainted', (path) => {
    expect(current.taintedLibA).not.toContain(path);
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
