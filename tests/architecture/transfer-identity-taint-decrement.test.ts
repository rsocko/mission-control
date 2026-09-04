import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const TRANSFER_BRIDGE = 'src/lib/connectors/transfer-identity.ts';
const RELEASED_CALLER = 'src/lib/tasks/task-move-write-through.ts';
const REMOVED_TAINT = [TRANSFER_BRIDGE, RELEASED_CALLER] as const;

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/architecture/web-persistence-baseline.json'), 'utf8'),
) as {
  counts: Record<string, number>;
  decrementHistory?: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTaintedLibA: string[];
    removedTierARoutes: string[];
    newlyCleanRoutes: string[];
    tierBReclassifications: string[];
    notMigratedFromTheOwnedFileSet: string[];
  }>;
  taintedLibA: string[];
};
const current = computeWebPersistenceGraph(process.cwd());

describe('L06b transfer identity taint decrement', () => {
  it('records exactly the direct bridge and its transitive caller', () => {
    const entry = baseline.decrementHistory?.find((record) => record.layer === 'L06b');
    expect(entry).toBeDefined();
    expect(entry?.totalMigrationUnits).toEqual({ from: 325, to: 323, delta: -2 });
    expect(entry?.removedTaintedLibA).toEqual([...REMOVED_TAINT]);
    expect(entry?.removedTierARoutes).toEqual([]);
    expect(entry?.newlyCleanRoutes).toEqual([]);
    expect(entry?.tierBReclassifications).toEqual([]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it.each(REMOVED_TAINT)('%s is absent from every taint set', (file) => {
    expect(current.taintedLibA).not.toContain(file);
    expect(current.taintedApiHelpers).not.toContain(file);
    expect(current.tierARoutes).not.toContain(file);
    expect(current.tierBRoutes).not.toContain(file);
  });

  it('keeps the bridge backend-neutral without a hidden deferred fallback', () => {
    const source = readFileSync(join(process.cwd(), TRANSFER_BRIDGE), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/db['"]/);
    expect(source).not.toMatch(/import\(\s*['"]@\/db/);
    expect(source).not.toMatch(/better-sqlite3|drizzle-orm/);
  });

  it('pins the exact graph decrement without route reclassification', () => {
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
      tierARoutes: 143,
      tierBRoutes: 19,
      cleanRoutes: 104,
      directTaintSourceRoutes: 101,
      transitiveOnlyTaintSourceRoutes: 42,
      directDbNamespaceRoutes: 102,
      taintedLibA: 71,
      taintedApiHelpers: 0,
      totalMigrationUnits: 214,
    });
    expect(current.taintedLibA).toEqual(baseline.taintedLibA);
  });
});
