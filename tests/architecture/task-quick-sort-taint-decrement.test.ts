import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/tasks/quick-sort-stats/route.ts',
  'src/app/api/tasks/quick-sort/operations/[id]/undo/route.ts',
  'src/app/api/tasks/quick-sort/operations/route.ts',
] as const;

const OWNED_LIBRARY = 'src/lib/quick-sort/operations.ts';
const FORBIDDEN_PERSISTENCE = /from\s+['"]@\/db(?:\/|['"])|import\(\s*['"]@\/db|better-sqlite3|drizzle-orm/;

const graph = computeWebPersistenceGraph(process.cwd());

describe('task quick-sort persistence decrement', () => {
  it('stays at or below the task quick-sort migration-unit ceiling', () => {
    expect(graph.totalMigrationUnits).toBeLessThanOrEqual(178);
  });

  it.each([...OWNED_ROUTES, OWNED_LIBRARY])('%s evaluates no persistence driver surface', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).not.toMatch(FORBIDDEN_PERSISTENCE);
  });

  it.each(OWNED_ROUTES)('%s is clean rather than deferred', (route) => {
    expect(graph.cleanRoutes).toContain(route);
    expect(graph.tierARoutes).not.toContain(route);
    expect(graph.tierBRoutes).not.toContain(route);
  });
});
