import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const TRANSFER_BRIDGE = 'src/lib/connectors/transfer-identity.ts';
const RELEASED_CALLER = 'src/lib/tasks/task-move-write-through.ts';
const REMOVED_TAINT = [TRANSFER_BRIDGE, RELEASED_CALLER] as const;

const current = computeWebPersistenceGraph(process.cwd());

describe('L06b transfer identity taint decrement', () => {
  it('stays at or below the L06b migration-unit ceiling', () => {
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(323);
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
});
