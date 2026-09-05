import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const ROUTE = 'src/app/api/daily-completions/route.ts';
const PRODUCTION_PATHS = [ROUTE] as const;
const TEST_PATHS = [
  'tests/api/daily-completions-postgres-parity.test.ts',
  'tests/architecture/daily-planning-taint-decrement.test.ts',
] as const;
const ARCHITECTURE_PATHS = [
  'docs/architecture/persistence-boundaries.md',
  'tests/architecture/web-persistence-baseline.json',
] as const;

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const current = computeWebPersistenceGraph(process.cwd());

describe('daily planning read-model taint decrement', () => {
  it('pins the five-path implementation and proof cap', () => {
    expect(PRODUCTION_PATHS).toHaveLength(1);
    expect(TEST_PATHS).toHaveLength(2);
    expect(ARCHITECTURE_PATHS).toHaveLength(2);
    for (const path of [...PRODUCTION_PATHS, ...TEST_PATHS, ...ARCHITECTURE_PATHS]) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });

  it('keeps the route clean and delegates through the landed analytics repository', () => {
    expect(current.cleanRoutes).toContain(ROUTE);
    expect(current.tierARoutes).not.toContain(ROUTE);
    expect(current.tierBRoutes).not.toContain(ROUTE);
    expect(current.directDbNamespaceRoutes).not.toContain(ROUTE);

    const text = source(ROUTE);
    expect(text).toContain(
      "import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime'",
    );
    expect(text).toContain('.analytics.kpis');
    expect(text).toContain('countTasksCompletedIn');
    expect(text).not.toMatch(/from\s*['"]@\/db(?:['"/])|import\(\s*['"]@\/db/);
    expect(text).not.toMatch(/drizzle-orm|better-sqlite3|@\/lib\/utils\/sqlite-date/);
    expect(text).not.toMatch(/resolveDatabaseBackend|MC_DATABASE_BACKEND|fallback/i);
  });

});
