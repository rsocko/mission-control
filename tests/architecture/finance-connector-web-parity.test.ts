import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { computeWebPersistenceGraph } from './web-persistence-graph';

/**
 * L12b: finance connector/operator PostgreSQL web/API parity.
 *
 * Pins the exact owned route and library sets, proves the owned files and the
 * two new adapters stay behind driver-free ports, and recomputes the exact
 * before/delta/after graph this layer committed.
 */

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const OWNED_ROUTES = [
  'src/app/api/connectors/[id]/finance-operations/route.ts',
  'src/app/api/connectors/[id]/finance/attribution-exceptions/[exceptionId]/route.ts',
  'src/app/api/connectors/[id]/finance/attribution-exceptions/route.ts',
  'src/app/api/connectors/[id]/finance/recovery/route.ts',
  'src/app/api/connectors/[id]/health/route.ts',
  'src/app/api/connectors/[id]/test/route.ts',
  'src/app/api/finance/transactions/[id]/kid/route.ts',
] as const;

const OWNED_LIBRARIES = [
  'src/lib/connectors/monarch-money/attribution-service.ts',
  'src/lib/connectors/monarch-money/dataset-sync.ts',
  'src/lib/finance-insights/cutover-operator.ts',
  'src/lib/finance-insights/cutover.ts',
] as const;

const PORTS = [
  'src/db/persistence/finance-operator.ts',
  'src/db/persistence/finance-attribution.ts',
  'src/db/persistence/core-repositories.ts',
] as const;

const ADAPTERS = [
  'src/db/persistence/sqlite-finance-operator-repository.ts',
  'src/db/postgres/repositories/finance-operator-repository.ts',
] as const;

const RUNTIME_DATABASE_IMPORT =
  /(?:^|\n)import\s+(?!type\s)[^;]*?from\s+['"](?:better-sqlite3|pg|drizzle-orm[^'"]*|@\/db(?:['"]|\/(?:index|schema|finance-schema)['"]))/;
const DYNAMIC_DATABASE_IMPORT = /import\(\s*['"]@\/db(?:\/(?:index|schema))?['"]\s*\)/;
const RAW_HANDLE = /\bsqlite\.(?:prepare|transaction|exec|pragma)\b/;

const current = computeWebPersistenceGraph(process.cwd());
const baseline = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/architecture/web-persistence-baseline.json'), 'utf8'),
) as {
  counts: Record<string, number>;
  tierBRoutes: string[];
  taintedApiHelpers: string[];
  decrementHistory: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTaintedLibA: string[];
    removedTierARoutes: string[];
    newlyCleanRoutes: string[];
    removedDirectTaintSourceRoutes?: string[];
    removedDirectDbNamespaceRoutes?: string[];
    removedTransitiveOnlyTaintSourceRoutes?: string[];
    tierBReclassifications: string[];
    notMigratedFromTheOwnedFileSet: string[];
  }>;
};

describe('L12b finance connector/operator web parity', () => {
  it('keeps every owned route and library free of SQLite reach', () => {
    for (const path of [...OWNED_ROUTES, ...OWNED_LIBRARIES]) {
      const contents = source(path);
      expect(contents, path).not.toMatch(RUNTIME_DATABASE_IMPORT);
      expect(contents, path).not.toMatch(DYNAMIC_DATABASE_IMPORT);
      expect(contents, path).not.toMatch(RAW_HANDLE);
    }
  });

  it('keeps the new and expanded ports driver-free and facade-free', () => {
    for (const path of PORTS) {
      const contents = source(path);
      expect(contents, path).not.toMatch(
        /from\s+['"](?:better-sqlite3|pg|drizzle-orm[^'"]*|@\/db\/(?:schema|finance-schema))['"]/,
      );
      for (const escapeHatch of [
        /\bquery\s*\(\s*sql\b/,
        /\bexecute\s*\(\s*(?:sql|statement|text)\b/,
        /\bgetHandle\b/,
        /\bgetConnection\b/,
        /\bwithTransaction\b/,
        /\bresolveDatabaseBackend\b/,
        /dual[- ]?write/i,
        /\bfallback[A-Z]/,
      ]) {
        expect(contents, `${path} ${String(escapeHatch)}`).not.toMatch(escapeHatch);
      }
    }
  });

  it('composes the operator port without adding a runtime slot', () => {
    const finance = source('src/db/persistence/finance-worker.ts');
    expect(finance).toContain('readonly operator: FinanceOperatorPersistence');
    // The operator port is composed inside the finance member; it must never
    // become its own registered process runtime slot.
    for (const path of [
      'src/db/persistence/finance-operator.ts',
      ...ADAPTERS,
    ]) {
      expect(source(path), path).not.toMatch(/getProcessRuntimeSlot|register[A-Za-z]*Runtime/);
    }
  });

  it('keeps provider I/O out of both operator adapters', () => {
    for (const path of ADAPTERS) {
      const contents = source(path);
      expect(contents, path).not.toMatch(/MonarchBridgeClient|\bfetch\s*\(/);
      expect(contents, path).not.toMatch(/resolveDatabaseBackend|dual[- ]?write/i);
    }
  });

  it('keeps the only L12a seam on the generic connector repository', () => {
    const core = source('src/db/persistence/core-repositories.ts');
    expect(core).toContain('recordTestResult(');
    expect(source('src/db/persistence/sqlite-core-repositories.ts'))
      .toContain('async recordTestResult(');
    expect(source('src/db/postgres/repositories/connector-repository.ts'))
      .toContain('async recordTestResult(');
    // The finance operator port must not own a generic connector badge write.
    expect(source('src/db/persistence/finance-operator.ts'))
      .not.toMatch(/recordTestResult\s*\(/);
  });

  it('does not relocate the Monarch dynamic import boundary', () => {
    const connector = source('src/lib/connectors/monarch-money/index.ts');
    expect(connector).toContain("await import('./attribution-service')");
    expect(connector).toContain(
      "process.env.MC_DATABASE_BACKEND === 'postgres'",
    );
  });

  it('schedules the exception retry strictly after commit', () => {
    const service = source('src/lib/connectors/monarch-money/attribution-service.ts');
    const commit = service.indexOf('persistence.actOnException');
    const wake = service.indexOf('repository.enqueue(');
    expect(commit).toBeGreaterThan(0);
    expect(wake).toBeGreaterThan(commit);
    expect(service).toContain('result.retryScheduled && isDurableSyncMode()');
    expect(service).not.toContain('enqueueSyncJobInCurrentTransaction');

    const route = source(
      'src/app/api/connectors/[id]/finance/attribution-exceptions/[exceptionId]/route.ts',
    );
    expect(route).toContain('if (result.retryScheduled)');
  });

  it('wakes the notification dispatcher only after the cutover commits', () => {
    const cutover = source('src/lib/finance-insights/cutover.ts');
    const commit = cutover.indexOf('operator.enableCutover(');
    const wake = cutover.indexOf('wakeNotificationDeliveryDispatcher()');
    expect(commit).toBeGreaterThan(0);
    expect(wake).toBeGreaterThan(commit);
    expect(cutover).toContain('if (outcome.hasPendingDelivery)');
    for (const path of ADAPTERS) {
      expect(source(path), path).not.toContain('wakeNotificationDeliveryDispatcher');
    }
  });

  it('records the exact committed decrement', () => {
    const entry = baseline.decrementHistory.find((record) => record.layer === 'L12b');
    expect(entry, 'L12b must be recorded in web-persistence-baseline.json').toBeDefined();
    expect(entry?.totalMigrationUnits).toEqual({ from: 204, to: 193, delta: -11 });
    expect(entry?.removedTierARoutes).toEqual([...OWNED_ROUTES]);
    expect(entry?.newlyCleanRoutes).toEqual([...OWNED_ROUTES]);
    expect(entry?.removedTaintedLibA).toEqual([...OWNED_LIBRARIES]);
    expect(entry?.removedDirectTaintSourceRoutes).toEqual([
      'src/app/api/connectors/[id]/finance/recovery/route.ts',
      'src/app/api/connectors/[id]/health/route.ts',
      'src/app/api/connectors/[id]/test/route.ts',
    ]);
    expect(entry?.removedDirectDbNamespaceRoutes).toEqual([
      'src/app/api/connectors/[id]/finance/recovery/route.ts',
      'src/app/api/connectors/[id]/health/route.ts',
      'src/app/api/connectors/[id]/test/route.ts',
    ]);
    expect(entry?.removedTransitiveOnlyTaintSourceRoutes).toEqual([
      'src/app/api/connectors/[id]/finance-operations/route.ts',
      'src/app/api/connectors/[id]/finance/attribution-exceptions/[exceptionId]/route.ts',
      'src/app/api/connectors/[id]/finance/attribution-exceptions/route.ts',
      'src/app/api/finance/transactions/[id]/kid/route.ts',
    ]);
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it('recomputes the exact after graph and adds no new taint', () => {
    for (const route of OWNED_ROUTES) {
      expect(current.cleanRoutes, route).toContain(route);
      expect(current.tierARoutes, route).not.toContain(route);
      expect(current.tierBRoutes, route).not.toContain(route);
      expect(current.directDbNamespaceRoutes, route).not.toContain(route);
    }
    for (const library of OWNED_LIBRARIES) {
      expect(current.taintedLibA, library).not.toContain(library);
    }
    // No Tier B increase and no new tainted API helper.
    expect(current.tierBRoutes).toEqual(baseline.tierBRoutes);
    expect(current.taintedApiHelpers).toEqual(baseline.taintedApiHelpers);
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
      taintedLibA: 56,
      taintedApiHelpers: 0,
      totalMigrationUnits: 163,
    });
    expect(baseline.counts).toEqual({
      apiRoutes: 266,
      tierARoutes: 107,
      tierBRoutes: 5,
      cleanRoutes: 154,
      directTaintSourceRoutes: 77,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 78,
      taintedLibA: 56,
      taintedApiHelpers: 0,
      totalMigrationUnits: 163,
    });
  });
});
