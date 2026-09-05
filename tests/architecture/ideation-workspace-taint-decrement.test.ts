import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

/**
 * L16 ideation-workspace web/API PostgreSQL persistence parity ratchet.
 *
 * Pins the exact owned route/library sets, proves the migrated files keep no
 * raw handle, driver, schema, or `@/db` namespace reach (static or dynamic),
 * proves no new runtime slot / fallback / dual-write / backend probe was
 * introduced, proves both adapters share one checkpoint policy, and holds the
 * layer-owned migration-unit ceiling.
 */

const ROUTES = [
  'src/app/api/ideation/workspaces/[id]/duplicate/route.ts',
  'src/app/api/ideation/workspaces/[id]/route.ts',
  'src/app/api/ideation/workspaces/[id]/versions/[revision]/route.ts',
  'src/app/api/ideation/workspaces/[id]/versions/route.ts',
  'src/app/api/ideation/workspaces/route.ts',
] as const;
const ROUTE_HELPER = 'src/app/api/ideation/workspaces/route-errors.ts';
const LIBRARIES = [
  'src/lib/graph-workspace/service.ts',
] as const;
const NEUTRAL_CONTRACT = 'src/lib/graph-workspace/repository.ts';
const POSTGRES_ADAPTER = 'src/db/postgres/repositories/ideation-workspace-repository.ts';
const SQLITE_ADAPTER = 'src/lib/graph-workspace/sqlite-repository.ts';
const RETIRED_SQLITE_COMPOSITION = 'src/lib/persistence/sqlite-runtime.ts';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const current = computeWebPersistenceGraph(process.cwd());

describe('L16 ideation-workspace taint decrement', () => {
  it('stays at or below the L16 migration-unit ceiling', () => {
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(264);
  });

  it.each(ROUTES)('%s is clean', (route) => {
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
    expect(current.directTaintSourceRoutes).not.toContain(route);
    expect(current.transitiveOnlyTaintSourceRoutes).not.toContain(route);
    expect(current.directDbNamespaceRoutes).not.toContain(route);
  });

  it.each([...ROUTES, ROUTE_HELPER])('%s keeps no @/db namespace or driver import', (path) => {
    const text = source(path);
    expect(text).not.toMatch(/(?:from\s*['"]@\/db(?:['"/])|import\(\s*['"]@\/db)/);
    expect(text).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3/);
    expect(text).not.toMatch(/\bfrom\s*['"]pg['"]|require\(\s*['"]pg['"]\s*\)/);
    expect(text).not.toMatch(/\bdrizzle-orm\b/);
  });

  it.each(LIBRARIES)('%s has no persistence taint or relocation', (path) => {
    expect(current.taintedLibA).not.toContain(path);
    const text = source(path);
    // The backend-neutral contract module is allowed; the SQLite database
    // module, schema, backend adapters, and drivers are not.
    expect(text).not.toMatch(/(?:from\s*['"]@\/db['"]|import\(\s*['"]@\/db['"]\s*\))/);
    expect(text).not.toMatch(/@\/db\/schema|@\/db\/postgres|@\/db\/persistence\/sqlite-/);
    expect(text).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3/);
    expect(text).not.toMatch(/\bfrom\s*['"]pg['"]|require\(\s*['"]pg['"]\s*\)/);
    expect(text).not.toMatch(/\bdrizzle-orm\b/);
  });

  it('retires the SQLite-only composition root instead of relocating it', () => {
    expect(existsSync(join(process.cwd(), RETIRED_SQLITE_COMPOSITION))).toBe(false);
    expect(current.taintedLibA).not.toContain(RETIRED_SQLITE_COMPOSITION);
  });

  it('routes every read and mutation through the composed worker repository', () => {
    const service = source('src/lib/graph-workspace/service.ts');
    expect(service).toContain(
      "import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime'",
    );
    expect(service).toContain('(await getWorkerPersistenceRepositories()).ideationWorkspaces');
    // No new runtime slot, backend probe, fallback, or dual write.
    expect(service).not.toMatch(/getProcessRuntimeSlot|resolveDatabaseBackend|MC_DATABASE_BACKEND/);
    expect(service).not.toMatch(/fallback|dualWrite|dual-write/i);
    for (const path of [...ROUTES, ROUTE_HELPER]) {
      expect(source(path)).not.toMatch(/getWorkerPersistenceRepositories|ideationWorkspaces/);
    }
  });

  it('keeps the backend-neutral contract free of any driver', () => {
    const text = source(NEUTRAL_CONTRACT);
    expect(text).not.toMatch(/better-sqlite3|\bfrom\s*['"]pg['"]|drizzle-orm/);
    expect(text).not.toMatch(/@\/db\/schema|@\/db\/postgres|@\/db['"]/);
    expect(text).toContain('shouldCheckpointIdeationRevision');
  });

  it('confines each driver to its own backend-named adapter', () => {
    const sqlite = source(SQLITE_ADAPTER);
    expect(sqlite).toContain("import type Database from 'better-sqlite3'");
    expect(sqlite).not.toMatch(/\bfrom\s*['"]pg['"]/);
    expect(sqlite).toContain('COLLATE NOCASE, id');

    const postgres = source(POSTGRES_ADAPTER);
    expect(postgres).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3/);
    expect(postgres).toContain('FOR UPDATE');
    expect(postgres).toContain('COLLATE "C"');
    // ASCII-only folding reproduces SQLite's `COLLATE NOCASE` exactly; a
    // locale-aware `lower(name)` silently reorders non-ASCII names.
    expect(postgres).toContain("translate(name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'");
    expect(postgres).not.toMatch(/ORDER BY[\s\S]{0,120}lower\(name\)/i);

    // Both adapters share one checkpoint policy rather than duplicating it.
    for (const adapter of [sqlite, postgres]) {
      expect(adapter).toContain('shouldCheckpointIdeationRevision');
      expect(adapter).not.toContain('5 * 60 * 1000');
    }
  });

  it('composes the adapter for both backends without a new registry', () => {
    expect(source('src/db/persistence/worker-repositories.ts'))
      .toContain('ideationWorkspaces: IdeationWorkspaceRepository');
    expect(source('src/db/persistence/sqlite-worker-runtime.ts'))
      .toContain('ideationWorkspaces: new SqliteIdeationWorkspaceRepository(sqlite)');
    expect(source('src/db/postgres/repositories/index.ts'))
      .toContain('ideationWorkspaces: createPostgresIdeationWorkspaceRepository(pool)');
    expect(source('src/db/runtime.ts'))
      .toContain("requirePostgresWorkerRepositories().ideationWorkspaces[");
  });
});
