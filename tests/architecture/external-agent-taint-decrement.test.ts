import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const ROUTES = [
  'src/app/api/external-agents/[id]/route.ts',
  'src/app/api/external-agents/dispatch/route.ts',
  'src/app/api/external-agents/dispatches/[id]/result/route.ts',
  'src/app/api/external-agents/dispatches/[id]/route.ts',
  'src/app/api/external-agents/dispatches/claim/route.ts',
  'src/app/api/external-agents/dispatches/route.ts',
  'src/app/api/external-agents/import/route.ts',
  'src/app/api/external-agents/route.ts',
] as const;
const LIBRARIES = [
  'src/lib/external-agents/http.ts',
  'src/lib/external-agents/policy.ts',
  'src/lib/external-agents/registry.ts',
  'src/lib/external-agents/service.ts',
  'src/lib/external-agents/transports.ts',
] as const;

const current = computeWebPersistenceGraph(process.cwd());

describe('L14 external-agent taint decrement', () => {
  it('stays at or below the L14 migration-unit ceiling', () => {
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(292);
  });

  it.each(ROUTES)('%s is clean', (route) => {
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.cleanRoutes).toContain(route);
  });

  it.each(LIBRARIES)('%s has no persistence taint or relocation', (path) => {
    expect(current.taintedLibA).not.toContain(path);
    const source = readFileSync(join(process.cwd(), path), 'utf8');
    expect(source).not.toMatch(/(?:from\s*['"]@\/db(?:['"/])|import\(\s*['"]@\/db)/);
    expect(source).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3/);
  });
});
