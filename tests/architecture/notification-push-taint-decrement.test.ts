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
  'tests/architecture/notification-push-taint-decrement.test.ts',
  'tests/contracts/notification-push-repository.contract.ts',
  'tests/db/notification-push-postgres-import-safety.test.ts',
  'tests/db/postgres-notification-push-repository.integration.test.ts',
  'tests/db/sqlite-notification-push-repository.test.ts',
  'tests/notifications/scheduled-trigger-dedup.test.ts',
  'tests/sync/postgres-web-composition-poisoned.test.ts',
] as const;

const ARCHITECTURE_PATHS = [
  'docs/architecture/persistence-boundaries.md',
] as const;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const current = computeWebPersistenceGraph(process.cwd());

describe('notification push taint decrement', () => {
  it('pins the approved production cap and focused support paths', () => {
    expect(PRODUCTION_PATHS).toHaveLength(12);
    expect(TEST_PATHS).toHaveLength(9);
    expect(ARCHITECTURE_PATHS).toHaveLength(1);
    const paths = [...PRODUCTION_PATHS, ...TEST_PATHS, ...ARCHITECTURE_PATHS];
    expect(paths).toHaveLength(22);
    expect(new Set(paths).size).toBe(22);
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
    const instrumentation = source('src/instrumentation.ts');
    const sqliteGuard = instrumentation.indexOf("resolveDatabaseBackend() === 'sqlite'");
    const triggerImport = instrumentation.indexOf("import('@/lib/push/triggers')");
    expect(sqliteGuard).toBeGreaterThan(-1);
    expect(triggerImport).toBeGreaterThan(sqliteGuard);
    expect(instrumentation).toContain('registerScheduledPushHandlers({');
  });

  it('accounts for the four owned migration units without Tier B reclassification', () => {
    expect(OWNED_ROUTES.length + OWNED_LIBS.length).toBe(4);
    for (const route of OWNED_ROUTES) {
      expect(current.tierBRoutes).not.toContain(route);
    }
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

});
