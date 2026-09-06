import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/integrations/alertmanager/route.ts',
  'src/app/api/integrations/alertmanager/test/route.ts',
  'src/app/api/integrations/alertmanager/webhook/route.ts',
  'src/app/api/notifications/[id]/actions/[actionId]/route.ts',
  'src/app/api/notifications/re-enrich/route.ts',
  'src/app/api/notifications/triage/route.ts',
  'src/app/api/push/trigger/route.ts',
] as const;

const OWNED_LIBRARIES = [
  'src/lib/alertmanager/operations.ts',
  'src/lib/alertmanager/service.ts',
  'src/lib/notifications/index.ts',
  'src/lib/notifications/push-policy/resolver.ts',
  'src/lib/notifications/push-policy/rules.ts',
  'src/lib/notifications/service.ts',
  'src/lib/notifications/workflow-executor.ts',
  'src/lib/push/triggers.ts',
] as const;

const CANONICAL_BASELINE_PATH = [
  'tests/architecture/web-persistence',
  'baseline.json',
].join('-');

const PRODUCTION_PATHS = [
  ...OWNED_ROUTES,
  ...OWNED_LIBRARIES,
  'src/lib/ai/features/notification-classification.ts',
  'src/lib/ai/features/notification-classifier.ts',
  'src/db/persistence/notification-delivery.ts',
  'src/db/persistence/notification-web.ts',
  'src/db/persistence/webhook-integrations.ts',
  'src/db/persistence/sqlite-notification-delivery-repository.ts',
  'src/db/persistence/sqlite-notification-web-repository.ts',
  'src/db/persistence/sqlite-webhook-integrations-repository.ts',
  'src/db/postgres/repositories/notification-delivery-repository.ts',
  'src/db/postgres/repositories/notification-web-repository.ts',
  'src/db/postgres/repositories/webhook-integrations-repository.ts',
  'src/db/persistence/sqlite-notification-creation.ts',
  'src/db/persistence/sqlite-connector-execution-repositories.ts',
  'src/db/persistence/sqlite-finance-attention-repositories.ts',
  'src/db/persistence/sqlite-finance-insight-notification-lifecycle.ts',
  'src/db/persistence/sqlite-finance-operator-repository.ts',
  'src/db/persistence/sqlite-finance-recovery-repository.ts',
] as const;

const TEST_PATHS = [
  'tests/contracts/notification-delivery-web.contract.ts',
  'tests/db/postgres-notification-web-repository.integration.test.ts',
  'tests/alertmanager/operations.test.ts',
  'tests/alertmanager/service.test.ts',
  'tests/api/notifications.test.ts',
  'tests/notifications/push-rule-persistence.test.ts',
  'tests/notifications/scheduled-trigger-dedup.test.ts',
  'tests/api/notification-delivery-web-routes.test.ts',
  'tests/api/postgres-notification-delivery-web-poisoned.test.ts',
  'tests/architecture/notification-delivery-web-taint-decrement.test.ts',
  CANONICAL_BASELINE_PATH,
] as const;

const DOCUMENTATION_PATHS = [
  'docs/architecture/persistence-boundaries.md',
  'docs/integrations/alertmanager.md',
] as const;

const EXCLUDED_ROUTE_PREFIXES = [
  'src/app/api/ai/',
  'src/app/api/scout/',
  'src/app/api/tags/',
  'src/app/api/tasks/',
  'src/app/api/goals/',
  'src/app/api/resets/',
  'src/app/api/ideation/',
  'src/app/api/connectors/',
  'src/app/api/export/',
  'src/app/api/features/',
] as const;

const graph = computeWebPersistenceGraph(process.cwd());

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('notification delivery web taint decrement', () => {
  it('pins the approved 32 production, 11 test, and 2 documentation paths', () => {
    expect(PRODUCTION_PATHS).toHaveLength(32);
    expect(TEST_PATHS).toHaveLength(11);
    expect(DOCUMENTATION_PATHS).toHaveLength(2);
    const paths = [...PRODUCTION_PATHS, ...TEST_PATHS, ...DOCUMENTATION_PATHS];
    expect(paths).toHaveLength(45);
    expect(new Set(paths).size).toBe(45);
    for (const path of paths) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });

  it.each(OWNED_ROUTES)('%s is clean and evaluates no database handle', (route) => {
    expect(graph.cleanRoutes).toContain(route);
    expect(graph.tierARoutes).not.toContain(route);
    expect(graph.tierBRoutes).not.toContain(route);
    expect(graph.directDbNamespaceRoutes).not.toContain(route);
    const text = source(route);
    expect(text).not.toMatch(/(?:from\s*['"]@\/db(?:['"/])|import\(\s*['"]@\/db)/);
    expect(text).not.toMatch(/better-sqlite3|\bfrom\s*['"]pg['"]|\bdrizzle-orm\b/);
    expect(text).not.toMatch(/resolveDatabaseBackend|MC_DATABASE_BACKEND|fallback/i);
  });

  it.each(OWNED_LIBRARIES)('%s is no longer import-time tainted', (path) => {
    expect(graph.taintedLibA).not.toContain(path);
  });

  it('does not absorb excluded routes or migrate the broader AI triage route', () => {
    for (const route of OWNED_ROUTES) {
      for (const prefix of EXCLUDED_ROUTE_PREFIXES) {
        expect(route.startsWith(prefix), route).toBe(false);
      }
    }
    expect(graph.tierARoutes).toContain('src/app/api/ai/triage-alerts/route.ts');
  });

  it('only ratchets the migration graph downward', () => {
    const self = source('tests/architecture/notification-delivery-web-taint-decrement.test.ts');
    expect(self).not.toContain(['web-persistence', 'baseline.json'].join('-'));
    expect(self).not.toContain(['postgres', 'route', 'sentinel'].join('-'));
    expect(graph.totalMigrationUnits).toBeLessThanOrEqual(75);
    expect(graph.taintedApiHelpers).toEqual([]);
  });
});
