import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { computeWebPersistenceGraph } from './web-persistence-graph';

const ROUTE_ROOTS = [
  'src/app/api/tasks/route.ts',
  'src/app/api/tasks/[id]/route.ts',
] as const;

const CLEAN_ROUTES = [
  ...ROUTE_ROOTS,
  'src/app/api/mcp/tasks/[id]/route.ts',
] as const;

const FORBIDDEN_ROUTE_IMPORTS = [
  /from\s+['"]@\/db(?:\/|['"])/,
  /from\s+['"]drizzle-orm(?:\/|['"])/,
  /from\s+['"]@\/lib\/connectors['"]/,
  /from\s+['"]@\/lib\/sync['"]/,
  /from\s+['"]@\/lib\/search['"]/,
  /from\s+['"]@\/lib\/triage\/actions['"]/,
  /from\s+['"]@\/lib\/connectors\/scout\/reconciliation-service['"]/,
  /import\(\s*['"]@\/db/,
] as const;

const current = computeWebPersistenceGraph(process.cwd());

describe('L07 task-write taint decrement', () => {
  it('makes exactly the two task roots and MCP forwarding route clean', () => {
    for (const route of CLEAN_ROUTES) {
      expect(current.cleanRoutes).toContain(route);
      expect(current.tierARoutes).not.toContain(route);
      expect(current.tierBRoutes).not.toContain(route);
    }
  });

  it('keeps owned route roots off database and mixed-domain barrels', () => {
    for (const route of ROUTE_ROOTS) {
      const source = readFileSync(join(process.cwd(), route), 'utf8');
      for (const forbidden of FORBIDDEN_ROUTE_IMPORTS) {
        expect(source, `${route} must not match ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it('stays at or below the L07 migration-unit ceiling', () => {
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(298);
  });
});
