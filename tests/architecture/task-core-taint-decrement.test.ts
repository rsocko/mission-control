import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { computeWebPersistenceGraph } from './web-persistence-graph';

/**
 * Layer L04 decrement proof.
 *
 * The PostgreSQL route sentinel owns the exact current graph. This file keeps
 * the L04-owned files clean and retains only a monotonic layer ceiling, so
 * later parity decrements do not require edits here.
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

const current = computeWebPersistenceGraph(process.cwd());
const taintedA = new Set([
  ...current.taintedLibA,
  ...current.taintedApiHelpers,
  ...current.tierARoutes,
]);

describe('L04 task-core taint decrement', () => {
  it('stays at or below the L04 migration-unit ceiling', () => {
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(325);
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
});
