import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/settings/capture-destination/route.ts',
  'src/app/api/settings/dopamine-menu/route.ts',
  'src/app/api/settings/inbox-lists/route.ts',
] as const;

const PRODUCTION_PATHS = [
  ...OWNED_ROUTES,
  'src/lib/settings/preference-settings.ts',
] as const;

const TEST_PATHS = [
  'tests/api/settings-preferences-postgres-poisoned.test.ts',
  'tests/architecture/settings-preferences-taint-decrement.test.ts',
  'tests/contracts/preference-settings-repository.contract.ts',
  'tests/db/postgres-preference-settings.integration.test.ts',
  'tests/db/sqlite-preference-settings-repository.test.ts',
] as const;

const ARCHITECTURE_PATHS = [
  'docs/architecture/persistence-boundaries.md',
  join('tests', 'architecture', 'web-persistence-baseline.json'),
] as const;

const graph = computeWebPersistenceGraph(process.cwd());

describe('settings preference PostgreSQL taint decrement', () => {
  it('pins the 11-path implementation and proof cap', () => {
    expect(PRODUCTION_PATHS).toHaveLength(4);
    expect(TEST_PATHS).toHaveLength(5);
    expect(ARCHITECTURE_PATHS).toHaveLength(2);
    for (const path of [...PRODUCTION_PATHS, ...TEST_PATHS, ...ARCHITECTURE_PATHS]) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });

  it.each(OWNED_ROUTES)('%s is clean and never reclassified to deferred SQLite taint', (route) => {
    expect(graph.tierARoutes).not.toContain(route);
    expect(graph.tierBRoutes).not.toContain(route);
    expect(graph.cleanRoutes).toContain(route);
  });

});
