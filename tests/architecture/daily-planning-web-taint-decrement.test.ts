import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

/**
 * Layer-owned monotonic proof for the daily-planning/focus web surface.
 *
 * It deliberately owns only this layer's eleven routes, their cleanliness, the
 * excluded-domain non-ownership, and a migration-unit ceiling. The exact
 * current graph has exactly two owners — the canonical baseline JSON and the
 * dependency-free route sentinel — and this test never reads either.
 */
const ROUTES = [
  'src/app/api/energy/route.ts',
  'src/app/api/focus-items/route.ts',
  'src/app/api/mobile-dashboard/route.ts',
  'src/app/api/my-day/route.ts',
  'src/app/api/my-day/sync/route.ts',
  'src/app/api/navigation/counts/route.ts',
  'src/app/api/one-thing/route.ts',
  'src/app/api/recent-wins/dismiss/route.ts',
  'src/app/api/recent-wins/route.ts',
  'src/app/api/recent-wins/settings/route.ts',
  'src/app/api/schedule/route.ts',
] as const;

const CONTRACT = 'src/db/persistence/daily-planning.ts';
const SQLITE_ADAPTER = 'src/db/persistence/sqlite-daily-planning-repository.ts';
const POSTGRES_ADAPTER = 'src/db/postgres/repositories/daily-planning-repository.ts';

const OWNED_TEST_PATHS = [
  'tests/contracts/daily-planning-persistence.contract.ts',
  'tests/db/sqlite-daily-planning-persistence.contract.test.ts',
  'tests/db/postgres-daily-planning-persistence.contract.integration.test.ts',
  'tests/api/postgres-daily-planning-poisoned.test.ts',
  'tests/api/daily-planning-routes.test.ts',
  'tests/architecture/daily-planning-web-taint-decrement.test.ts',
] as const;

const OWNED_DOCUMENTATION_PATHS = [
  'docs/architecture/daily-planning-persistence.md',
  'docs/architecture/persistence-boundaries.md',
] as const;

/**
 * Domains this layer must not absorb. None of them may appear in the owned
 * route set, and none of their contracts may be re-exported by this layer.
 */
const EXCLUDED_ROUTE_PREFIXES = [
  'src/app/api/ai/',
  'src/app/api/graph/',
  'src/app/api/projects/',
  'src/app/api/notifications/',
  'src/app/api/alertmanager/',
  'src/app/api/push/',
  'src/app/api/scout/',
  'src/app/api/triage/',
  'src/app/api/tags/',
  'src/app/api/relationships/',
] as const;

/** Monotonic ceiling: this layer may only ever shrink the migration budget. */
const MIGRATION_UNIT_CEILING = 116;

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const current = computeWebPersistenceGraph(process.cwd());

describe('daily-planning web taint decrement', () => {
  it('pins the owned implementation, proof, and documentation paths', () => {
    expect(ROUTES).toHaveLength(11);
    expect(OWNED_TEST_PATHS).toHaveLength(6);
    expect(OWNED_DOCUMENTATION_PATHS).toHaveLength(2);
    for (const path of [
      ...ROUTES,
      CONTRACT,
      SQLITE_ADAPTER,
      POSTGRES_ADAPTER,
      ...OWNED_TEST_PATHS,
      ...OWNED_DOCUMENTATION_PATHS,
    ]) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });

  it.each(ROUTES)('%s is clean and free of database, schema, and driver imports', (route) => {
    expect(current.cleanRoutes).toContain(route);
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.directTaintSourceRoutes).not.toContain(route);
    expect(current.transitiveOnlyTaintSourceRoutes).not.toContain(route);
    expect(current.directDbNamespaceRoutes).not.toContain(route);

    const text = source(route);
    expect(text).not.toMatch(/(?:from\s*['"]@\/db(?:['"/])|import\(\s*['"]@\/db)/);
    expect(text).not.toMatch(/better-sqlite3|\bfrom\s*['"]pg['"]|\bdrizzle-orm\b/);
    expect(text).not.toMatch(/@\/lib\/utils\/sqlite-date|@\/lib\/notifications\/lifecycle-sql/);
    expect(text).not.toMatch(/resolveDatabaseBackend|MC_DATABASE_BACKEND|fallback/i);
  });

  it('does not own any excluded domain route', () => {
    for (const route of ROUTES) {
      for (const prefix of EXCLUDED_ROUTE_PREFIXES) {
        expect(route.startsWith(prefix), `${route} must not be an excluded-domain route`)
          .toBe(false);
      }
    }
  });

  it('keeps the daily-planning contract backend-neutral and free of escape hatches', () => {
    const contract = source(CONTRACT);
    expect(contract).not.toMatch(
      /better-sqlite3|\bfrom\s*['"]pg['"]|drizzle-orm|@\/db\/schema|@\/db\/postgres/,
    );
    expect(contract).not.toMatch(/\btransaction\b\s*[:(]|runTransaction|SQL`|sql`/);
    expect(contract).toContain('export interface DailyPlanningPersistence');
    for (const member of [
      'energy:', 'focus:', 'dashboard:', 'navigation:',
      'myDay:', 'myDaySync:', 'oneThing:', 'schedule:', 'recentWins:',
    ]) {
      expect(contract).toContain(member);
    }
  });

  it('registers one daily-planning capability per backend with no fallback slot', () => {
    expect(source(CONTRACT))
      .toMatch(/dailyPlanning\??: DailyPlanningPersistence/);
    expect(source('src/db/persistence/sqlite-worker-runtime.ts'))
      .toContain('dailyPlanning: createSqliteDailyPlanningPersistence(sqlite)');
    expect(source('src/db/postgres/repositories/index.ts'))
      .toContain('dailyPlanning: createPostgresDailyPlanningPersistence(pool)');
    expect(source('src/db/runtime.ts'))
      .toContain("dailyPlanning: new Proxy({} as NonNullable<WorkerPersistenceRepositories['dailyPlanning']>");
  });

  it('confines driver behavior and pins the serialized namespaces', () => {
    const sqlite = source(SQLITE_ADAPTER);
    expect(sqlite).toContain("import type Database from 'better-sqlite3'");
    expect(sqlite).not.toMatch(/\bfrom\s*['"]pg['"]/);
    expect(sqlite).toContain('.immediate()');
    expect(sqlite).toContain('isDatabaseContentionError');

    const postgres = source(POSTGRES_ADAPTER);
    expect(postgres).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3|@\/db\/schema/);
    expect(postgres).toContain('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(postgres).not.toContain('SERIALIZABLE');
    expect(postgres).toContain('pg_advisory_xact_lock(hashtext($1))');
    expect(postgres).toContain('LOCK TABLE energy_checkins IN SHARE ROW EXCLUSIVE MODE');
    expect(postgres).toContain('daily-planning:focus:${scope}:${date}');
    expect(postgres).toContain('daily-planning:my-day:${date}');
    expect(postgres).toContain('daily-planning:one-thing:${weekMonday}');
    expect(postgres.match(/function \w+LockKey\(/g)).toHaveLength(3);
    expect(postgres).not.toContain('daily-planning:energy:');
    // PostgreSQL must never borrow the SQLite adapter.
    expect(postgres).not.toContain('sqlite-daily-planning-repository');
  });

  it('never reads the canonical exact-current graph and only ratchets downward', () => {
    const self = source('tests/architecture/daily-planning-web-taint-decrement.test.ts');
    expect(self).not.toContain(['web-persistence', 'baseline.json'].join('-'));
    expect(self).not.toContain(['postgres', 'route', 'sentinel'].join('-'));
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(MIGRATION_UNIT_CEILING);
    expect(current.taintedApiHelpers).toEqual([]);
  });
});
