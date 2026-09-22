import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/tasks/[id]/attachments/route.ts',
  'src/app/api/tasks/[id]/copy/route.ts',
  'src/app/api/tasks/[id]/promote/route.ts',
  'src/app/api/tasks/[id]/subtasks/route.ts',
  'src/app/api/tasks/[id]/tags/route.ts',
] as const;

const FORBIDDEN_PERSISTENCE =
  /from\s+['"]@\/db(?:\/|['"])|import\(\s*['"]@\/db|better-sqlite3|drizzle-orm/;

const graph = computeWebPersistenceGraph(process.cwd());

describe('task ancillary lifecycle persistence decrement', () => {
  it('stays at or below the task ancillary lifecycle migration-unit ceiling', () => {
    expect(graph.totalMigrationUnits).toBeLessThanOrEqual(150);
  });

  it.each(OWNED_ROUTES)('%s evaluates no persistence driver surface', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).not.toMatch(FORBIDDEN_PERSISTENCE);
  });

  it.each(OWNED_ROUTES)('%s is clean rather than deferred', (route) => {
    expect(graph.cleanRoutes).toContain(route);
    expect(graph.tierARoutes).not.toContain(route);
    expect(graph.tierBRoutes).not.toContain(route);
  });

});
