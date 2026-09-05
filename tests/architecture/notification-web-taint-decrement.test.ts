import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { computeWebPersistenceGraph } from './web-persistence-graph';

/**
 * Layer L13 decrement proof: notification/web-push persistence parity.
 *
 * Pins the exact seven routes plus the one tainted lib that L13 removed,
 * and verifies no Tier B reclassifications occurred.
 */

const OWNED_ROUTES = [
  'src/app/api/notifications/[id]/snooze/route.ts',
  'src/app/api/notifications/bulk/route.ts',
  'src/app/api/notifications/route.ts',
  'src/app/api/notifications/views/[id]/route.ts',
  'src/app/api/notifications/views/route.ts',
  'src/app/api/notifications/writebacks/route.ts',
  'src/app/api/push/subscribe/route.ts',
] as const;

const OWNED_LIB = 'src/lib/notifications/notification-writeback.ts';

const FORBIDDEN_HANDLE = /^(@\/db|better-sqlite3|drizzle-orm\/better-sqlite3(\/|$))$/;
const PERSISTENCE_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/g;

function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(PERSISTENCE_IMPORT)) {
    const clause = source
      .slice(match.index ?? 0, (match.index ?? 0) + match[0].length)
      .replace(/from\s*['"][^'"]+['"]$/, '');
    const typeOnly = /\bimport\s+type\b|\bexport\s+type\b/.test(clause)
      || (() => {
        const bindings = clause.match(/\{([\s\S]*)\}/);
        if (!bindings) return false;
        const inner = bindings[1].split(',').map(s => s.trim()).filter(Boolean);
        return inner.length > 0 && inner.every(part => /^type\s/.test(part));
      })();
    if (!typeOnly) specifiers.push(match[1]);
  }
  return specifiers;
}

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/architecture/web-persistence-baseline.json'), 'utf8'),
) as {
  counts: Record<string, number>;
  decrementHistory?: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTaintedApiHelpers: string[];
    removedTaintedLibA: string[];
    removedTierARoutes: string[];
    newlyCleanRoutes: string[];
    tierBReclassifications: string[];
    notMigratedFromTheOwnedFileSet: Array<{ file: string; reason: string }>;
  }>;
};

const current = computeWebPersistenceGraph(process.cwd());
const taintedA = new Set([
  ...current.taintedLibA,
  ...current.taintedApiHelpers,
  ...current.tierARoutes,
]);

describe('L13 notification-web taint decrement', () => {
  it('records the layer in the baseline decrement history', () => {
    const entry = baseline.decrementHistory?.find(r => r.layer === 'L13');
    expect(entry, 'L13 must be recorded in web-persistence-baseline.json').toBeDefined();
    expect(entry?.totalMigrationUnits).toEqual({ from: 298, to: 290, delta: -8 });
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
    expect(entry?.removedTierARoutes.sort()).toEqual([...OWNED_ROUTES].sort());
    expect(entry?.newlyCleanRoutes.sort()).toEqual([...OWNED_ROUTES].sort());
    expect(entry?.removedTaintedLibA).toEqual([OWNED_LIB]);
  });

  it.each(OWNED_ROUTES)('%s is clean (no Tier A or Tier B)', (route) => {
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
  });

  it.each(OWNED_ROUTES)('%s evaluates no database handle or SQLite driver', (route) => {
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    const forbidden = valueImportSpecifiers(source)
      .filter(spec => FORBIDDEN_HANDLE.test(spec));
    expect(forbidden, `${route} must not import a database handle or driver`).toEqual([]);
    expect(source, `${route} must not defer a @/db import`).not.toMatch(/import\(\s*['"]@\/db/);
    expect(source, `${route} must not name a SQLite driver`).not.toMatch(/better-sqlite3/);
  });

  it('notification-writeback.ts is no longer import-time tainted', () => {
    expect(taintedA.has(OWNED_LIB)).toBe(false);
    const source = readFileSync(join(process.cwd(), OWNED_LIB), 'utf8');
    const forbidden = valueImportSpecifiers(source)
      .filter(spec => FORBIDDEN_HANDLE.test(spec));
    expect(forbidden).toEqual([]);
  });

  it('holds the exact recomputed counts this layer committed', () => {
    expect({
      taintedLibA: current.taintedLibA.length,
      taintedApiHelpers: current.taintedApiHelpers.length,
      tierARoutes: current.tierARoutes.length,
      tierBRoutes: current.tierBRoutes.length,
      cleanRoutes: current.cleanRoutes.length,
      directTaintSourceRoutes: current.directTaintSourceRoutes.length,
      transitiveOnlyTaintSourceRoutes: current.transitiveOnlyTaintSourceRoutes.length,
      directDbNamespaceRoutes: current.directDbNamespaceRoutes.length,
      totalMigrationUnits: current.totalMigrationUnits,
    }).toEqual({
      taintedLibA: 61,
      taintedApiHelpers: 0,
      tierARoutes: 121,
      tierBRoutes: 19,
      cleanRoutes: 126,
      directTaintSourceRoutes: 91,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 92,
      totalMigrationUnits: 182,
    });
  });
});
