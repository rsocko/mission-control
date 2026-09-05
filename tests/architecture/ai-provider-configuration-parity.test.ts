import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_PRODUCTION_PATHS = [
  'src/app/api/ai/models/route.ts',
  'src/app/api/ai/provider/route.ts',
  'src/db/persistence/core-repositories.ts',
  'src/db/persistence/sqlite-core-repositories.ts',
  'src/db/postgres/repositories/settings-repository.ts',
  'src/db/runtime.ts',
  'src/lib/ai/config-resolver.ts',
  'src/lib/ai/provider-configuration-service.ts',
  'src/lib/ai/provider-routing-core.ts',
  'src/lib/search/embedding-config-core.ts',
  'src/lib/search/embedding-provider-status.ts',
] as const;

const OWNED_ROUTES = [
  'src/app/api/ai/models/route.ts',
  'src/app/api/ai/provider/route.ts',
] as const;

const current = computeWebPersistenceGraph(process.cwd());

describe('L10 AI provider configuration parity', () => {
  it('keeps the owned production paths present', () => {
    expect(OWNED_PRODUCTION_PATHS).toHaveLength(11);
    for (const path of OWNED_PRODUCTION_PATHS) {
      expect(existsSync(join(process.cwd(), path)), `${path} must exist`).toBe(true);
    }
  });

  it('stays at or below the L10 migration-unit ceiling', () => {
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(204);
  });

  it.each(OWNED_ROUTES)('%s is clean without a deferred database fallback', (route) => {
    expect(current.cleanRoutes).toContain(route);
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    const source = readFileSync(join(process.cwd(), route), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/db(?:['"/])/);
    expect(source).not.toMatch(/import\(\s*['"]@\/db/);
    expect(source).not.toMatch(/config-resolver|provider-factory|search\/semantic/);
  });

  it('keeps new services backend-neutral and hides all driver/schema handles', () => {
    for (const path of [
      'src/lib/ai/provider-configuration-service.ts',
      'src/lib/ai/provider-routing-core.ts',
      'src/lib/search/embedding-config-core.ts',
      'src/lib/search/embedding-provider-status.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      expect(source).not.toMatch(/better-sqlite3|drizzle-orm|@\/db\/(?:schema|runtime)/);
      expect(source).not.toMatch(/import\(\s*['"]@\/db/);
    }
  });
});
