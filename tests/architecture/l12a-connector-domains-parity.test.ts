import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/auth/microsoft/connect/route.ts',
  'src/app/api/calendar-events/route.ts',
  'src/app/api/connectors/[id]/label-normalize/route.ts',
  'src/app/api/connectors/[id]/label-scan/route.ts',
  'src/app/api/connectors/[id]/lists/route.ts',
  'src/app/api/connectors/[id]/permissions/route.ts',
  'src/app/api/connectors/[id]/validate-repo/route.ts',
  'src/app/api/connectors/github-repos/route.ts',
  'src/app/api/source-lists/[id]/fix-emoji/route.ts',
  'src/app/api/sync/health/route.ts',
] as const;

const current = computeWebPersistenceGraph(process.cwd());

describe('L12a connector-domain PostgreSQL parity', () => {
  it('stays at or below the L12a migration-unit ceiling', () => {
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(295);
  });

  it.each(OWNED_ROUTES)('%s is fully clean rather than deferred to Tier B', (route) => {
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
  });

  it.each(OWNED_ROUTES)('%s has no runtime @/db or SQLite driver import', (route) => {
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    expect(source).not.toMatch(
      /(?:^|\n)\s*import\s+(?!type\b)[^;]*from\s+['"]@\/db(?:['"/])/,
    );
    expect(source).not.toMatch(/import\(\s*['"]@\/db/);
    expect(source).not.toMatch(/better-sqlite3/);
  });
});
