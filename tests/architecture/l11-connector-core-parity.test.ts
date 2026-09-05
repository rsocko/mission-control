import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/connectors/route.ts',
  'src/app/api/source-lists/[id]/route.ts',
  'src/app/api/source-lists/[id]/rename/route.ts',
  'src/app/api/source-lists/rename/route.ts',
  'src/app/api/source-lists/reorder/route.ts',
  'src/app/api/source-rankings/route.ts',
  'src/app/api/sync/deletions/[id]/route.ts',
  'src/app/api/sync/route.ts',
] as const;

const current = computeWebPersistenceGraph(process.cwd());

describe('L11 connector-core PostgreSQL parity', () => {
  it('stays at or below the L11 migration-unit ceiling', () => {
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(305);
  });

  it.each(OWNED_ROUTES)('%s is fully clean rather than deferred to Tier B', (route) => {
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
  });

  it.each(OWNED_ROUTES)('%s uses the connector composition seam without @/db', (route) => {
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    expect(source).toContain('@/lib/connectors/management-service');
    expect(source).not.toMatch(
      /(?:^|\n)\s*import\s+(?!type\b)[^;]*from\s+['"]@\/db(?:['"/])/,
    );
    expect(source).not.toMatch(/import\(\s*['"]@\/db/);
    expect(source).not.toMatch(/better-sqlite3/);
  });
});
