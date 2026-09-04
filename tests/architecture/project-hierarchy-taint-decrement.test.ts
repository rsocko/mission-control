import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

/**
 * L15 project-hierarchy web/API PostgreSQL persistence parity ratchet.
 *
 * Pins the exact owned route/library sets, proves the migrated files keep no
 * raw handle, driver, schema, or `@/db` namespace reach (static or dynamic),
 * proves no new runtime slot / fallback / dual-write / backend probe was
 * introduced, and holds the exact composed graph after the decrement.
 */

const ROUTES = [
  'src/app/api/hub-projects/[id]/tasks/route.ts',
  'src/app/api/project-phases/[id]/items/reorder/route.ts',
  'src/app/api/project-phases/[id]/items/route.ts',
  'src/app/api/projects/[id]/hierarchy/route.ts',
] as const;
const LIBRARIES = [
  'src/lib/projects/hierarchy-service.ts',
  'src/lib/projects/hierarchy-transitions.ts',
] as const;
const NEUTRAL_CONTRACTS = [
  'src/db/persistence/project-hierarchy.ts',
  'src/lib/projects/hierarchy-transitions.ts',
] as const;
const POSTGRES_ADAPTER = 'src/db/postgres/repositories/project-hierarchy-repository.ts';
const SQLITE_ADAPTER = 'src/db/persistence/sqlite-project-hierarchy-repository.ts';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
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

describe('L15 project-hierarchy taint decrement', () => {
  it('records the exact historical decrement', () => {
    const entry = baseline.decrementHistory.find(({ layer }) => layer === 'L15');
    expect(entry?.totalMigrationUnits).toEqual({ from: 277, to: 272, delta: -5 });
    expect(entry?.removedTaintedLibA).toEqual(['src/lib/projects/hierarchy-service.ts']);
    expect(entry?.removedTierARoutes.sort()).toEqual([...ROUTES].sort());
    expect(entry?.newlyCleanRoutes.sort()).toEqual([...ROUTES].sort());
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it.each(ROUTES)('%s is clean', (route) => {
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
    expect(current.directTaintSourceRoutes).not.toContain(route);
    expect(current.transitiveOnlyTaintSourceRoutes).not.toContain(route);
    expect(current.directDbNamespaceRoutes).not.toContain(route);
  });

  it.each(ROUTES)('%s keeps no @/db namespace or driver import', (path) => {
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

  it('keeps the graph Universe compatibility caller outside the decrement', () => {
    const caller = 'src/app/api/graph/universe/clusters/save/route.ts';
    expect(current.tierARoutes).toContain(caller);
    expect(source(caller)).toContain('await getProjectHierarchySnapshot(projectId)');
  });

  it('routes every read and mutation through the composed worker repository', () => {
    const service = source('src/lib/projects/hierarchy-service.ts');
    expect(service).toContain(
      "import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime'",
    );
    expect(service).toContain('repositories.projectAutomation.hierarchy');
    // No new runtime slot, backend probe, fallback, or dual write.
    expect(service).not.toMatch(/getProcessRuntimeSlot|resolveDatabaseBackend|MC_DATABASE_BACKEND/);
    expect(service).not.toMatch(/fallback|dualWrite|dual-write/i);
    for (const route of ROUTES) {
      expect(source(route)).not.toMatch(/getWorkerPersistenceRepositories|projectAutomation/);
    }
  });

  it('keeps the backend-neutral contract and planner free of any driver', () => {
    for (const path of NEUTRAL_CONTRACTS) {
      const text = source(path);
      expect(text).not.toMatch(/better-sqlite3|\bfrom\s*['"]pg['"]|drizzle-orm/);
      expect(text).not.toMatch(/@\/db\/schema|@\/db\/postgres/);
    }
  });

  it('confines each driver to its own backend-named adapter', () => {
    const sqlite = source(SQLITE_ADAPTER);
    expect(sqlite).toContain("import type Database from 'better-sqlite3'");
    expect(sqlite).not.toMatch(/\bfrom\s*['"]pg['"]/);
    expect(sqlite).toContain('.immediate()');
    expect(sqlite).toContain('project_hierarchy_mutation_context');

    const postgres = source(POSTGRES_ADAPTER);
    expect(postgres).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3/);
    expect(postgres).toContain('pg_advisory_lock(hashtext($1))');
    expect(postgres).toContain('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(postgres).toContain('FOR UPDATE');
    expect(postgres).toContain('COLLATE "C"');

    // Both adapters share one planner rather than duplicating command semantics.
    for (const adapter of [sqlite, postgres]) {
      expect(adapter).toContain('planProjectHierarchyCommand');
      expect(adapter).not.toMatch(/case 'move_tasks'|case 'assign_tasks'|case 'reorder_phases'/);
    }
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
      tierARoutes: 175,
      tierBRoutes: 27,
      cleanRoutes: 64,
      directTaintSourceRoutes: 124,
      transitiveOnlyTaintSourceRoutes: 51,
      directDbNamespaceRoutes: 125,
      taintedLibA: 78,
      taintedApiHelpers: 0,
      totalMigrationUnits: 253,
    });
  });
});
