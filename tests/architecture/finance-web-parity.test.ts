import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/finance/kids/route.ts',
  'src/app/api/finance/notifications/[id]/dismiss/route.ts',
  'src/app/api/finance/notifications/route.ts',
  'src/app/api/finance/overview/route.ts',
  'src/app/api/finance/summary/route.ts',
  'src/app/api/finance/transactions/[id]/category/route.ts',
  'src/app/api/finance/transactions/route.ts',
] as const;

const COLLATERALLY_CLEAN_ROUTES = [
  'src/app/api/finance/alerts/[id]/dismiss/route.ts',
  'src/app/api/finance/alerts/route.ts',
] as const;

const OWNED_LIBRARIES = [
  'src/lib/connectors/monarch-money/snapshot-sync.ts',
  'src/lib/finance/operations.ts',
] as const;

const PORT = 'src/db/persistence/finance-web.ts';
const ADAPTERS = [
  'src/db/persistence/sqlite-finance-web-repository.ts',
  'src/db/postgres/repositories/finance-web-repository.ts',
] as const;

const RUNTIME_DATABASE_IMPORT =
  /(?:^|\n)import\s+(?!type\s)[^;]*?from\s+['"](?:better-sqlite3|pg|drizzle-orm[^'"]*|@\/db(?:['"]|\/(?:index|schema|finance-schema)['"]))/;
const DYNAMIC_DATABASE_IMPORT = /import\(\s*['"]@\/db(?:\/(?:index|schema))?['"]\s*\)/;
const RAW_HANDLE = /\bsqlite\.(?:prepare|transaction|exec|pragma)\b/;

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const current = computeWebPersistenceGraph(process.cwd());

describe('L12c finance end-user web/API PostgreSQL parity', () => {
  it('keeps the frozen route and supporting-library cap free of SQLite reach', () => {
    for (const path of [...OWNED_ROUTES, ...OWNED_LIBRARIES]) {
      const contents = source(path);
      expect(contents, path).not.toMatch(RUNTIME_DATABASE_IMPORT);
      expect(contents, path).not.toMatch(DYNAMIC_DATABASE_IMPORT);
      expect(contents, path).not.toMatch(RAW_HANDLE);
    }
  });

  it('keeps the web port driver-free and both adapters free of provider I/O', () => {
    const contract = source(PORT);
    expect(contract).not.toMatch(
      /from\s+['"](?:better-sqlite3|pg|drizzle-orm[^'"]*|@\/db\/(?:schema|finance-schema))['"]/,
    );
    expect(contract).not.toMatch(/resolveDatabaseBackend|dual[- ]?write|fallback[A-Z]/i);
    for (const path of ADAPTERS) {
      const adapter = source(path);
      expect(adapter, path).not.toMatch(/MonarchBridgeClient|\bfetch\s*\(/);
      expect(adapter, path).not.toMatch(/resolveDatabaseBackend|dual[- ]?write/i);
    }
  });

  it('composes finance.web atomically for both backends without a new runtime slot', () => {
    expect(source('src/db/persistence/finance-worker.ts'))
      .toContain('readonly web: FinanceWebPersistence');
    expect(source('src/db/persistence/sqlite-worker-runtime.ts'))
      .toContain('web: createSqliteFinanceWebPersistence(sqlite)');
    expect(source('src/db/postgres/repositories/index.ts'))
      .toContain('web: createPostgresFinanceWebPersistence(pool)');
    for (const path of [PORT, ...ADAPTERS]) {
      expect(source(path), path).not.toMatch(/getProcessRuntimeSlot|register[A-Za-z]*Runtime/);
    }
  });

  it('keeps external category I/O between a fenced claim and completion', () => {
    const snapshot = source('src/lib/connectors/monarch-money/snapshot-sync.ts');
    const connector = source('src/lib/connectors/monarch-money/index.ts');
    const claim = snapshot.indexOf('web.claimCategoryUpdate');
    const externalWrite = snapshot.indexOf('new MonarchBridgeClient(config).updateCategory');
    const complete = snapshot.indexOf('web.completeCategoryUpdate');
    const failure = snapshot.indexOf('web.failCategoryUpdate');
    expect(connector).not.toContain('Legacy finance category write-back is unavailable');
    expect(connector).toContain("await import('./snapshot-sync')");
    expect(claim).toBeGreaterThan(0);
    expect(externalWrite).toBeGreaterThan(claim);
    expect(complete).toBeGreaterThan(externalWrite);
    expect(failure).toBeGreaterThan(complete);
  });

  it('stays at or below the L12c migration-unit ceiling', () => {
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(182);
  });

  it('keeps owned and collateral routes plus owned libraries free of graph taint', () => {
    for (const route of [...OWNED_ROUTES, ...COLLATERALLY_CLEAN_ROUTES]) {
      expect(current.cleanRoutes, route).toContain(route);
      expect(current.tierARoutes, route).not.toContain(route);
      expect(current.tierBRoutes, route).not.toContain(route);
    }
    for (const library of OWNED_LIBRARIES) {
      expect(current.taintedLibA, library).not.toContain(library);
    }
  });
});
