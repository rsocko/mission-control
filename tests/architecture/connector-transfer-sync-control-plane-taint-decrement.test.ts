import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/connectors/[id]/cross-account/route.ts',
  'src/app/api/sync/tasks/resolve/route.ts',
] as const;

const EXCLUDED_ROUTES = [
  'src/app/api/connectors/[id]/retained-lists/[sourceListId]/route.ts',
  'src/app/api/connectors/github-bulk-transfer/route.ts',
  'src/app/api/sync/cleanup/route.ts',
  'src/app/api/sync/retained/resolve/route.ts',
] as const;

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const graph = computeWebPersistenceGraph(process.cwd());

describe('connector transfer/sync control-plane taint decrement', () => {
  it('owns exactly two routes and leaves the distinct candidates excluded', () => {
    expect(OWNED_ROUTES).toHaveLength(2);
    expect(EXCLUDED_ROUTES).toHaveLength(4);
    expect(new Set([...OWNED_ROUTES, ...EXCLUDED_ROUTES]).size).toBe(6);
  });

  it.each(OWNED_ROUTES)('%s is clean rather than deferred', (route) => {
    expect(graph.cleanRoutes).toContain(route);
    expect(graph.tierARoutes).not.toContain(route);
    expect(graph.tierBRoutes).not.toContain(route);
    expect(graph.directTaintSourceRoutes).not.toContain(route);
    expect(graph.directDbNamespaceRoutes).not.toContain(route);
    expect(source(route)).not.toMatch(
      /from\s+['"]@\/db(?:\/|['"])|import\(\s*['"]@\/db|better-sqlite3|drizzle-orm/,
    );
  });

  it('keeps the excluded candidate routes in their prior graph tiers', () => {
    expect(graph.tierARoutes).toContain(EXCLUDED_ROUTES[0]);
    expect(graph.tierBRoutes).toContain(EXCLUDED_ROUTES[1]);
    expect(graph.tierARoutes).toContain(EXCLUDED_ROUTES[2]);
    expect(graph.tierBRoutes).toContain(EXCLUDED_ROUTES[3]);
  });

  it('pins the SQLite-poisoned PostgreSQL route proofs', () => {
    expect(source('tests/api/cross-account-validation.test.ts')).toContain(
      'POISONED: cross-account route must not import SQLite',
    );
    expect(source('tests/api/sync-task-resolution-postgres-poisoned.test.ts')).toContain(
      'POISONED: sync task resolution must not import SQLite',
    );
  });
});
