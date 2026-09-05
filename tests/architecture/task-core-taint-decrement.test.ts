import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { computeWebPersistenceGraph } from './web-persistence-graph';

/**
 * Layer L04 decrement proof.
 *
 * The generic ratchet in `web-persistence-baseline.test.ts` only guarantees
 * that the taint footprint never *grows*. This file pins what L04 actually
 * removed, file by file, from the exact 13-file owned set, and — for the one
 * owned file whose residual taint belonged to a different layer — records the
 * exact former edge rather than accepting a prose deferral. L06b resolves that
 * edge; this suite now pins all 13 L04-owned files as clean.
 */

/** The full L04-owned file set: every one of these must be persistence-clean. */
const OWNED = [
  'src/app/api/tasks/canonical-filter.ts',
  'src/app/api/tasks/filter-factory.ts',
  'src/app/api/tasks/filter-query.ts',
  'src/app/api/tasks/query-builder.ts',
  'src/app/api/tasks/stats-computer.ts',
  'src/lib/priority-entities.ts',
  'src/lib/tasks/edit-policy.ts',
  'src/lib/tasks/local-task-lifecycle.ts',
  'src/lib/tasks/mutation-policy.ts',
  'src/lib/tasks/scout-hard-delete.ts',
  'src/lib/tasks/task-move-pending-sync.ts',
  'src/lib/tasks/task-move-write-through.ts',
  'src/lib/utils/resolve-task-list-names.ts',
] as const;

/**
 * The four helpers that still *compile Drizzle predicates* for the remaining
 * L07 task routes. They evaluate no database handle and
 * no driver — `@/db/schema` is table metadata and
 * `@/db/persistence/sqlite-task-filter` is a handle-free predicate compiler —
 * which is why the census already counts them as clean. Pinning the list
 * here means no *other* owned file can quietly acquire a Drizzle surface, and
 * that these four can only ever shrink out of it.
 */
const LEGACY_PREDICATE_HELPERS = [
  'src/app/api/tasks/canonical-filter.ts',
  'src/app/api/tasks/filter-factory.ts',
  'src/app/api/tasks/filter-query.ts',
  'src/app/api/tasks/query-builder.ts',
] as const;

const PERSISTENCE_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/g;
/** The database handle and the SQLite driver: never allowed in an owned file. */
const FORBIDDEN_HANDLE = /^(@\/db|better-sqlite3|drizzle-orm\/better-sqlite3(\/|$))$/;
/** Any Drizzle/table surface at all: allowed only in the legacy predicate helpers. */
const DRIZZLE_SURFACE = /^(@\/db(\/|$)|drizzle-orm(\/|$)|better-sqlite3$)/;

function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(PERSISTENCE_IMPORT)) {
    const clause = source
      .slice(match.index ?? 0, (match.index ?? 0) + match[0].length)
      .replace(/from\s*['"][^'"]+['"]$/, '');
    // `import type ... ` / `import { type A, type B }` are erased at build
    // time and evaluate nothing, exactly like the census treats them.
    const bindings = clause.match(/\{([\s\S]*)\}/);
    const typeOnly = /\bimport\s+type\b|\bexport\s+type\b/.test(clause)
      || (bindings !== null
        && bindings[1].split(',').map((part) => part.trim()).filter(Boolean).length > 0
        && bindings[1].split(',').map((part) => part.trim()).filter(Boolean)
          .every((part) => /^type\s/.test(part)));
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
    ownedFilesWithResidualForeignLayerTaint?: Array<{
      file: string;
      persistenceMigrated: boolean;
      blockedBy: string[];
      evidence: string;
    }>;
  }>;
};

const current = computeWebPersistenceGraph(process.cwd());
const taintedA = new Set([
  ...current.taintedLibA,
  ...current.taintedApiHelpers,
  ...current.tierARoutes,
]);

describe('L04 task-core taint decrement', () => {
  it('records the layer in the baseline decrement history with no deferrals', () => {
    const entry = baseline.decrementHistory?.find((record) => record.layer === 'L04');
    expect(entry, 'L04 must be recorded in web-persistence-baseline.json').toBeDefined();
    expect(entry?.totalMigrationUnits).toEqual({ from: 338, to: 325, delta: -13 });
    expect(entry?.tierBReclassifications).toEqual([]);
    // No file from the owned set may be parked as "not migrated".
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
    expect(
      entry?.removedTaintedApiHelpers.concat(entry.removedTaintedLibA).sort(),
    ).toEqual(OWNED.filter(
      (file) => file !== 'src/lib/tasks/task-move-write-through.ts',
    ).sort());

    const historicalResidual = entry?.ownedFilesWithResidualForeignLayerTaint ?? [];
    expect(historicalResidual.map((record) => record.file))
      .toEqual(['src/lib/tasks/task-move-write-through.ts']);
    expect(historicalResidual[0].persistenceMigrated).toBe(true);
    expect(historicalResidual[0].blockedBy).toEqual(['src/lib/connectors/transfer-identity.ts']);
    expect(historicalResidual[0].evidence.length).toBeGreaterThan(60);
  });

  it.each(OWNED)('%s evaluates no database handle or SQLite driver', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const forbidden = valueImportSpecifiers(source)
      .filter((specifier) => FORBIDDEN_HANDLE.test(specifier));
    expect(forbidden, `${file} must not import a database handle or driver`).toEqual([]);
    expect(source, `${file} must not defer a @/db import`).not.toMatch(/import\(\s*['"]@\/db/);
    expect(source, `${file} must not name a SQLite driver`).not.toMatch(/better-sqlite3/);
  });

  it.each(OWNED)('%s only keeps a Drizzle surface if it is a pinned legacy helper', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const drizzleSurface = valueImportSpecifiers(source)
      .filter((specifier) => DRIZZLE_SURFACE.test(specifier));
    if ((LEGACY_PREDICATE_HELPERS as readonly string[]).includes(file)) return;
    expect(
      drizzleSurface,
      `${file} is fully portable and must not name a Drizzle table or dialect`,
    ).toEqual([]);
  });

  it.each(OWNED)('%s is no longer import-time SQLite-tainted', (file) => {
    expect(taintedA.has(file)).toBe(false);
  });

  it('confirms L06b resolved the recorded foreign-layer edge', () => {
    const file = 'src/lib/tasks/task-move-write-through.ts';
    expect(taintedA.has(file)).toBe(false);
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const blocking = valueImportSpecifiers(source)
      .map((specifier) => (specifier.startsWith('@/') ? `src/${specifier.slice(2)}` : null))
      .filter((base): base is string => base !== null)
      .flatMap((base) => [`${base}.ts`, `${base}/index.ts`])
      .filter((candidate) => taintedA.has(candidate));
    expect([...new Set(blocking)].sort()).toEqual([]);
  });

  it('un-taints the Scout hard-delete route without reclassifying it as deferred taint', () => {
    const route = 'src/app/api/tasks/[id]/hard-delete/route.ts';
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
  });

  it('keeps the composition seam itself free of any SQLite reference', () => {
    const seam = readFileSync(
      join(process.cwd(), 'src/lib/tasks/core/runtime.ts'),
      'utf8',
    );
    // A dynamic import here would move every consumer from Tier A to Tier B
    // instead of removing them from the census, which is precisely the
    // reclassification the ratchet is designed to reject.
    expect(seam).not.toMatch(/better-sqlite3/);
    expect(seam).not.toMatch(/from\s+'@\/db/);
    expect(seam).not.toMatch(/import\(\s*'@\/db/);
  });

  it('holds the exact recomputed counts this layer committed', () => {
    expect({
      apiRoutes: current.apiRoutes.length,
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
      apiRoutes: 266,
      taintedLibA: 57,
      taintedApiHelpers: 0,
      tierARoutes: 107,
      tierBRoutes: 5,
      cleanRoutes: 154,
      directTaintSourceRoutes: 77,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 78,
      totalMigrationUnits: 164,
    });
  });
});
