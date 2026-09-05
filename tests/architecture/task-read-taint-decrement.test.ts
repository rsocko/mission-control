import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const ROUTES = [
  'src/app/api/tasks/[id]/attachments/[attachmentId]/route.ts',
  'src/app/api/tasks/[id]/document-preview/route.ts',
  'src/app/api/tasks/[id]/linked-sources/route.ts',
  'src/app/api/tasks/[id]/relationship-candidates/route.ts',
  'src/app/api/tasks/detect-duplicates/route.ts',
  'src/app/api/tasks/filter-options/route.ts',
  'src/app/api/tasks/group-counts/route.ts',
  'src/app/api/tasks/quick-sort/route.ts',
  'src/app/api/tasks/quick-sort/suggestions/route.ts',
] as const;

const current = computeWebPersistenceGraph(process.cwd());

describe('L05 task-read taint decrement', () => {
  it('makes exactly the nine approved route roots clean', () => {
    for (const route of ROUTES) {
      expect(current.cleanRoutes).toContain(route);
      expect(current.tierARoutes).not.toContain(route);
      expect(current.tierBRoutes).not.toContain(route);
    }
  });

  it('keeps route modules free of database, Drizzle, and mixed graph imports', () => {
    for (const route of ROUTES) {
      const source = readFileSync(join(process.cwd(), route), 'utf8');
      expect(source).not.toMatch(/from\s+['"]@\/db(?:\/|['"])/);
      expect(source).not.toMatch(/from\s+['"]drizzle-orm(?:\/|['"])/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/graph\/service['"]/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/sync(?:\/|['"])/);
      expect(source).not.toMatch(/from\s+['"]@\/lib\/connectors['"]/);
      expect(source).not.toMatch(/import\(\s*['"]@\/db/);
    }
  });

  it('stays at or below the L05 migration-unit ceiling', () => {
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(301);
  });
});
