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

const current = computeWebPersistenceGraph(process.cwd());
const taintedA = new Set([
  ...current.taintedLibA,
  ...current.taintedApiHelpers,
  ...current.tierARoutes,
]);

describe('L13 notification-web taint decrement', () => {
  it('stays at or below the L13 migration-unit ceiling', () => {
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(290);
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
});
