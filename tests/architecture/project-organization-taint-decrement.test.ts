import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const ROUTES = [
  'src/app/api/hub-projects/[id]/route.ts',
  'src/app/api/hub-projects/[id]/rule-matches/route.ts',
  'src/app/api/hub-projects/route.ts',
  'src/app/api/list-groups/[id]/route.ts',
  'src/app/api/list-groups/reorder/route.ts',
  'src/app/api/list-groups/route.ts',
  'src/app/api/project-phases/[id]/route.ts',
  'src/app/api/project-phases/route.ts',
] as const;
const SERVICES = [
  'src/lib/list-groups/service.ts',
  'src/lib/projects/organization-service.ts',
] as const;
const CONTRACT = 'src/db/persistence/project-organization.ts';
const SQLITE_ADAPTER = 'src/db/persistence/sqlite-project-organization-repositories.ts';
const POSTGRES_ADAPTER =
  'src/db/postgres/repositories/project-organization-repositories.ts';

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
    removedTierARoutes: string[];
    newlyCleanRoutes: string[];
    removedDirectTaintSourceRoutes: string[];
    removedDirectDbNamespaceRoutes: string[];
    tierBReclassifications: string[];
    notMigratedFromTheOwnedFileSet: unknown[];
  }>;
};
const current = computeWebPersistenceGraph(process.cwd());

describe('L19 project-organization taint decrement', () => {
  it('records the exact composed decrement', () => {
    const entry = baseline.decrementHistory.find(({ layer }) => layer === 'L19');
    expect(entry?.totalMigrationUnits).toEqual({ from: 175, to: 167, delta: -8 });
    expect(entry?.removedTierARoutes.sort()).toEqual([...ROUTES].sort());
    expect(entry?.newlyCleanRoutes.sort()).toEqual([...ROUTES].sort());
    expect(entry?.removedDirectTaintSourceRoutes.sort()).toEqual([...ROUTES].sort());
    expect(entry?.removedDirectDbNamespaceRoutes.sort()).toEqual([...ROUTES].sort());
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it.each(ROUTES)('%s is clean and keeps no persistence import', (route) => {
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
    expect(current.directTaintSourceRoutes).not.toContain(route);
    expect(current.transitiveOnlyTaintSourceRoutes).not.toContain(route);
    expect(current.directDbNamespaceRoutes).not.toContain(route);

    const text = source(route);
    expect(text).not.toMatch(/(?:from\s*['"]@\/db(?:['"/])|import\(\s*['"]@\/db)/);
    expect(text).not.toMatch(/better-sqlite3|\bfrom\s*['"]pg['"]|\bdrizzle-orm\b/);
    expect(text).not.toMatch(/getWorkerPersistenceRepositories|projectAutomation/);
  });

  it.each(SERVICES)('%s resolves only the composed neutral capability', (path) => {
    expect(current.taintedLibA).not.toContain(path);
    const text = source(path);
    expect(text).toContain(
      "import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime'",
    );
    expect(text).toContain('repositories.projectAutomation.');
    expect(text).not.toMatch(/@\/db\/schema|@\/db\/postgres|@\/db\/persistence\/sqlite-/);
    expect(text).not.toMatch(/better-sqlite3|\bfrom\s*['"]pg['"]|\bdrizzle-orm\b/);
    expect(text).not.toMatch(/getProcessRuntimeSlot|resolveDatabaseBackend|MC_DATABASE_BACKEND/);
    expect(text).not.toMatch(/fallback|dualWrite|dual-write/i);
  });

  it('keeps one atomic projectAutomation composition with no parallel runtime slot', () => {
    const contract = source('src/db/persistence/project-automation.ts');
    expect(contract).toContain('hierarchy: ProjectHierarchyPersistence');
    expect(contract).toContain('projectAdministration: ProjectAdministrationPersistence');
    expect(contract).toContain('listOrganization: ListOrganizationPersistence');

    const sqlite = source('src/db/persistence/sqlite-project-automation-repository.ts');
    expect(sqlite).toContain(
      'projectAdministration: createSqliteProjectAdministrationRepository(sqlite)',
    );
    expect(sqlite).toContain(
      'listOrganization: createSqliteListOrganizationRepository(sqlite)',
    );
    const postgres = source(
      'src/db/postgres/repositories/project-automation-repository.ts',
    );
    expect(postgres).toContain(
      'projectAdministration: createPostgresProjectAdministrationRepository(pool)',
    );
    expect(postgres).toContain(
      'listOrganization: createPostgresListOrganizationRepository(pool)',
    );
  });

  it('keeps the neutral contract driver-free and confines both adapters', () => {
    expect(source(CONTRACT)).not.toMatch(
      /better-sqlite3|\bfrom\s*['"]pg['"]|drizzle-orm|@\/db\/schema|@\/db\/postgres/,
    );

    const sqlite = source(SQLITE_ADAPTER);
    expect(sqlite).toContain("import type Database from 'better-sqlite3'");
    expect(sqlite).not.toMatch(/\bfrom\s*['"]pg['"]/);
    expect(sqlite).toContain('.immediate()');
    expect(sqlite).toContain('.deferred()');
    expect(sqlite).toContain('COLLATE BINARY');

    const postgres = source(POSTGRES_ADAPTER);
    expect(postgres).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3/);
    expect(postgres).toContain('pg_advisory_lock(hashtext($1))');
    expect(postgres).toContain('pg_advisory_xact_lock(hashtext($1))');
    expect(postgres).toContain('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(postgres).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(postgres).toContain('COLLATE "C"');
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
