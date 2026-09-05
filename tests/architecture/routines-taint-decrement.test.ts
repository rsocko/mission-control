import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const ROUTES = [
  'src/app/api/routines/[id]/route.ts',
  'src/app/api/routines/completions/route.ts',
  'src/app/api/routines/route.ts',
] as const;
const SERVICE = 'src/lib/routines/service.ts';
const CONTRACT = 'src/db/persistence/routines.ts';
const SQLITE_ADAPTER = 'src/db/persistence/sqlite-routines-repository.ts';
const POSTGRES_ADAPTER = 'src/db/postgres/repositories/routines-repository.ts';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const baseline = JSON.parse(source(
  'tests/architecture/web-persistence-baseline.json',
)) as {
  decrementHistory: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTierARoutes: string[];
    newlyCleanRoutes: string[];
    removedDirectTaintSourceRoutes: string[];
    removedDirectDbNamespaceRoutes: string[];
    tierBReclassifications: string[];
    notMigratedFromTheOwnedFileSet: string[];
  }>;
};
const current = computeWebPersistenceGraph(process.cwd());

describe('personal-planning routines taint decrement', () => {
  it('records the exact three-route decrement with no reclassification', () => {
    const entry = baseline.decrementHistory.find(
      ({ layer }) => layer === 'personal-planning-routines',
    );
    expect(entry?.totalMigrationUnits).toEqual({ from: 167, to: 164, delta: -3 });
    expect(entry?.removedTierARoutes).toEqual([...ROUTES]);
    expect(entry?.newlyCleanRoutes).toEqual([...ROUTES]);
    expect(entry?.removedDirectTaintSourceRoutes).toEqual([...ROUTES]);
    expect(entry?.removedDirectDbNamespaceRoutes).toEqual([...ROUTES]);
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it.each(ROUTES)('%s is clean and imports only the neutral routines service', (route) => {
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
    expect(current.directTaintSourceRoutes).not.toContain(route);
    expect(current.transitiveOnlyTaintSourceRoutes).not.toContain(route);
    expect(current.directDbNamespaceRoutes).not.toContain(route);

    const text = source(route);
    expect(text).toContain("from '@/lib/routines/service'");
    expect(text).not.toMatch(/(?:from\s*['"]@\/db(?:['"/])|import\(\s*['"]@\/db)/);
    expect(text).not.toMatch(/better-sqlite3|\bfrom\s*['"]pg['"]|\bdrizzle-orm\b/);
    expect(text).not.toMatch(/getWorkerPersistenceRepositories|resolveDatabaseBackend/);
  });

  it('keeps the route-facing service and contract backend-neutral', () => {
    const service = source(SERVICE);
    expect(service).toContain(
      "import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime'",
    );
    expect(service).toContain('(await getWorkerPersistenceRepositories()).routines');
    expect(service).not.toMatch(/@\/db\/schema|@\/db\/postgres|@\/db\/persistence\/sqlite-/);
    expect(service).not.toMatch(/better-sqlite3|\bfrom\s*['"]pg['"]|\bdrizzle-orm\b/);
    expect(service).not.toMatch(/resolveDatabaseBackend|MC_DATABASE_BACKEND|fallback/i);

    expect(source(CONTRACT)).not.toMatch(
      /better-sqlite3|\bfrom\s*['"]pg['"]|drizzle-orm|@\/db\/schema|@\/db\/postgres/,
    );
  });

  it('composes one routines repository for each backend with no fallback slot', () => {
    expect(source('src/db/persistence/worker-repositories.ts'))
      .toContain('routines: RoutinesRepository');
    expect(source('src/db/persistence/sqlite-worker-runtime.ts'))
      .toContain('routines: createSqliteRoutinesRepository(sqlite)');
    expect(source('src/db/postgres/repositories/index.ts'))
      .toContain('routines: createPostgresRoutinesRepository(pool)');
    expect(source('src/db/runtime.ts'))
      .toContain("routines: new Proxy({} as WorkerPersistenceRepositories['routines']");
  });

  it('confines driver behavior and preserves serialized completion creation', () => {
    const sqlite = source(SQLITE_ADAPTER);
    expect(sqlite).toContain("import type Database from 'better-sqlite3'");
    expect(sqlite).not.toMatch(/\bfrom\s*['"]pg['"]/);
    expect(sqlite).toContain('.immediate()');
    expect(sqlite).toContain('ORDER BY sort_order ASC, created_at COLLATE BINARY ASC');

    const postgres = source(POSTGRES_ADAPTER);
    expect(postgres).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3/);
    expect(postgres).toContain('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(postgres).not.toContain('SERIALIZABLE');
    expect(postgres).toContain('pg_advisory_xact_lock(hashtext($1))');
    expect(postgres).toContain('routine-completion:${command.routineId}:${command.date}');
    expect(postgres).toContain('ORDER BY sort_order ASC, created_at COLLATE "C" ASC');
  });

  it('holds the exact post-routines graph', () => {
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
      tierARoutes: 107,
      tierBRoutes: 5,
      cleanRoutes: 154,
      directTaintSourceRoutes: 77,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 78,
      taintedLibA: 57,
      taintedApiHelpers: 0,
      totalMigrationUnits: 164,
    });
  });
});
