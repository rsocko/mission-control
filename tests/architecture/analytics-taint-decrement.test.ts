import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

/**
 * L17 derived-analytics web/API PostgreSQL persistence parity ratchet.
 *
 * Pins the exact owned route/library sets, proves the migrated libraries keep
 * no raw handle, driver, schema, or `@/db` namespace reach, proves no route
 * file was touched, proves no new runtime slot / fallback / dual-write /
 * backend probe was introduced, proves each driver stays confined to its own
 * backend-named adapter (including the three declared SQLite→PostgreSQL
 * translations), and holds the exact composed graph after the decrement.
 */

const ROUTES = [
  'src/app/api/dashboard/kpis/route.ts',
  'src/app/api/insights/observations/route.ts',
  'src/app/api/insights/route.ts',
  'src/app/api/stats/route.ts',
  'src/app/api/tag-insights/route.ts',
  'src/app/api/word-insights/route.ts',
] as const;
/**
 * `/api/insights/observations` becomes Tier B rather than clean: its residual
 * reach is the deferred `import()` of the AI provider config resolver inside
 * `src/lib/stats/observations.ts`, which belongs to the held AI provider layer.
 */
const TIER_B_ROUTE = 'src/app/api/insights/observations/route.ts';
const NEWLY_CLEAN_ROUTES = ROUTES.filter((route) => route !== TIER_B_ROUTE);
const LIBRARIES = [
  'src/lib/stats/flow-query.ts',
  'src/lib/stats/index.ts',
  'src/lib/stats/insights.ts',
  'src/lib/tag-insights/service.ts',
  'src/lib/word-insights/service.ts',
] as const;
const NEUTRAL_CONTRACT = 'src/db/persistence/analytics.ts';
const SQLITE_ADAPTER = 'src/db/persistence/sqlite-analytics-repositories.ts';
const POSTGRES_ADAPTER = 'src/db/postgres/repositories/analytics-repositories.ts';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

/**
 * Strips comments so an assertion about the *code* is not satisfied or
 * defeated by prose that documents the very rule being asserted.
 */
function code(path: string) {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

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

describe('L17 derived-analytics taint decrement', () => {
  it('records the exact historical decrement', () => {
    const entry = baseline.decrementHistory.find(({ layer }) => layer === 'L17');
    expect(entry?.totalMigrationUnits).toEqual({ from: 264, to: 253, delta: -11 });
    expect(entry?.removedTaintedLibA.sort()).toEqual([...LIBRARIES].sort());
    expect(entry?.removedTierARoutes.sort()).toEqual([...ROUTES].sort());
    expect(entry?.newlyCleanRoutes.sort()).toEqual([...NEWLY_CLEAN_ROUTES].sort());
    expect(entry?.tierBReclassifications).toEqual([TIER_B_ROUTE]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it.each(NEWLY_CLEAN_ROUTES)('%s is clean', (route) => {
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
    expect(current.directTaintSourceRoutes).not.toContain(route);
    expect(current.transitiveOnlyTaintSourceRoutes).not.toContain(route);
    expect(current.directDbNamespaceRoutes).not.toContain(route);
  });

  it('reclassifies exactly the observations route to Tier B', () => {
    expect(current.tierARoutes).not.toContain(TIER_B_ROUTE);
    expect(current.tierBRoutes).toContain(TIER_B_ROUTE);
    expect(current.directDbNamespaceRoutes).not.toContain(TIER_B_ROUTE);
    // The residual reach is the held AI provider layer's deferred import.
    expect(source('src/lib/stats/observations.ts'))
      .toMatch(/await import\(\s*'@\/lib\/ai\/config-resolver'/);
    expect(current.taintedLibA).not.toContain('src/lib/stats/observations.ts');
  });

  it.each(ROUTES)('%s keeps no @/db namespace or driver import', (path) => {
    const text = source(path);
    expect(text).not.toMatch(/(?:from\s*['"]@\/db(?:['"/])|import\(\s*['"]@\/db)/);
    expect(text).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3/);
    expect(text).not.toMatch(/\bfrom\s*['"]pg['"]|require\(\s*['"]pg['"]\s*\)/);
    expect(text).not.toMatch(/\bdrizzle-orm\b/);
    // No route file learns about the composition either; the whole decrement
    // is transitive through the five migrated libraries.
    expect(text).not.toMatch(/getWorkerPersistenceRepositories|analytics\./);
  });

  it('keeps the tainted shared API helper count at its final target', () => {
    expect(current.taintedApiHelpers).toEqual([]);
  });

  it.each(LIBRARIES)('%s has no persistence taint or relocation', (path) => {
    expect(current.taintedLibA).not.toContain(path);
    const text = source(path);
    // The backend-neutral contract module is allowed; the SQLite database
    // module, schema, backend adapters, and drivers are not.
    expect(text).not.toMatch(/(?:from\s*['"]@\/db['"]|import\(\s*['"]@\/db['"]\s*\))/);
    expect(text).not.toMatch(/@\/db\/schema|@\/db\/postgres|@\/db\/persistence\/sqlite-|@\/db\/task-history/);
    expect(text).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3/);
    expect(text).not.toMatch(/\bfrom\s*['"]pg['"]|require\(\s*['"]pg['"]\s*\)/);
    expect(text).not.toMatch(/\bdrizzle-orm\b/);
    expect(text).not.toMatch(/@\/lib\/utils\/sqlite-date|@\/lib\/notifications\/lifecycle-sql/);
    // No new runtime slot or backend probe.
    expect(text).not.toMatch(/getProcessRuntimeSlot|resolveDatabaseBackend|MC_DATABASE_BACKEND/);
    expect(text).not.toMatch(/dualWrite|dual-write/i);
    expect(text).toContain(
      "import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime'",
    );
    expect(text).toMatch(/\(await getWorkerPersistenceRepositories\(\)\)\.analytics\./);
  });

  it('keeps the backend-neutral contract free of any driver', () => {
    const text = source(NEUTRAL_CONTRACT);
    expect(text).not.toMatch(/better-sqlite3|\bfrom\s*['"]pg['"]|drizzle-orm/);
    expect(text).not.toMatch(/@\/db\/schema|@\/db\/postgres|@\/db['"]/);
    // Read-only surface: no command, transaction, or compare-and-swap concept.
    expect(code(NEUTRAL_CONTRACT)).not.toMatch(/transaction|FOR UPDATE|revision|idempotency/i);
    expect(text).toContain('export interface AnalyticsPersistence');
  });

  it('confines each driver to its own backend-named adapter', () => {
    const sqlite = source(SQLITE_ADAPTER);
    expect(sqlite).toContain("from 'drizzle-orm/better-sqlite3'");
    expect(sqlite).not.toMatch(/\bfrom\s*['"]pg['"]/);
    // The SQLite adapter keeps the moved query bodies verbatim, including the
    // shared helpers the migrated libraries no longer reach.
    expect(sqlite).toContain("from '@/lib/utils/sqlite-date'");
    expect(sqlite).toContain("from '@/lib/notifications/lifecycle-sql'");
    expect(sqlite).toContain("from '@/db/task-history'");

    const postgres = source(POSTGRES_ADAPTER);
    expect(postgres).not.toMatch(/better-sqlite3|drizzle-orm/);
    expect(postgres).toContain("import type { Pool } from 'pg'");
    // Translation 1: the instant is constructed from validated fields, never
    // cast. A cast would reject the overflow dates and hours SQLite normalizes
    // and would accept the colon-less offsets SQLite refuses.
    expect(postgres).toContain('make_date(');
    expect(postgres).toContain('make_interval(');
    expect(postgres).toContain("AT TIME ZONE 'UTC'");
    expect(code(POSTGRES_ADAPTER)).not.toMatch(/::timestamptz\s*\n?\s*ELSE|pg_input_is_valid/);
    expect(code(POSTGRES_ADAPTER)).not.toMatch(/\$\{column\}::timestamp/);
    // Translation 2: byte ordering, not the locale-aware default collation.
    expect(postgres).toContain('COLLATE "C"');
    // Translation 3: ASCII-only folding, exactly as SQLite's lower() behaves.
    expect(postgres).toContain("translate(btrim(name), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'");
    expect(postgres).not.toMatch(/lower\(btrim\(name\)\)|lower\(trim\(name\)\)/);
    // Read-only: no transaction, lock, or isolation change anywhere.
    expect(postgres).not.toMatch(/FOR UPDATE|FOR SHARE|pg_advisory/);
    expect(postgres).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|ISOLATION LEVEL|pool\.connect\(/);
    // Not the sibling text constant, whose digest clause drops NULL-level rows.
    expect(postgres).toContain("(level IS NULL OR level IN ('urgent', 'action_needed'");
    expect(code(POSTGRES_ADAPTER)).not.toContain("level <> 'digest'");
  });

  it('composes the adapter for both backends without a new registry', () => {
    expect(source('src/db/persistence/worker-repositories.ts'))
      .toContain('analytics: AnalyticsPersistence');
    expect(source('src/db/persistence/sqlite-worker-runtime.ts'))
      .toContain('analytics: createSqliteAnalyticsPersistence(db)');
    expect(source('src/db/postgres/repositories/index.ts'))
      .toContain('analytics: createPostgresAnalyticsPersistence(pool)');
    expect(source('src/db/runtime.ts'))
      .toContain('requirePostgresWorkerRepositories().analytics[');
  });

  it('adds no schema migration for a read-only layer', () => {
    const journal = JSON.parse(source('drizzle/postgres/meta/_journal.json')) as {
      entries: Array<{ tag: string }>;
    };
    expect(journal.entries.some((entry) => /analytic|stats|insight/i.test(entry.tag))).toBe(false);
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
      tierARoutes: 118,
      tierBRoutes: 13,
      cleanRoutes: 135,
      directTaintSourceRoutes: 88,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 89,
      taintedLibA: 60,
      taintedApiHelpers: 0,
      totalMigrationUnits: 178,
    });
  });
});
