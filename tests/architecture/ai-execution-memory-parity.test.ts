import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const PRODUCTION_PATHS = [
  'src/db/runtime.ts',
  'src/lib/ai/durable-runs/runtime.ts',
  'src/lib/ai/provider-client.ts',
  'src/lib/ai/provider-factory.ts',
  'src/lib/ai/provider-runtime.ts',
  'src/lib/houston-memory/service.ts',
  'src/lib/houston-memory/summary.ts',
  'src/lib/intake/ai-parser.ts',
  'src/lib/semantic-index/source/facade.ts',
] as const;

const OWNED_ROUTES = [
  'src/app/api/ai/intake-document/route.ts',
  'src/app/api/ai/memories/[id]/route.ts',
  'src/app/api/ai/memories/route.ts',
  'src/app/api/ai/runs/[runId]/cancel/route.ts',
  'src/app/api/ai/runs/[runId]/events/route.ts',
  'src/app/api/ai/runs/[runId]/retry/route.ts',
  'src/app/api/ai/runs/[runId]/route.ts',
  'src/app/api/ai/runs/route.ts',
] as const;

const REMOVED_TAINTED_LIBRARIES = [
  'src/lib/ai/tools/intake-tools.ts',
  'src/lib/intake/ai-parser.ts',
  'src/lib/intake/index.ts',
] as const;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const current = computeWebPersistenceGraph(process.cwd());

describe('L18 AI execution and memory control-plane parity', () => {
  it('keeps the owned production paths present', () => {
    expect(PRODUCTION_PATHS).toHaveLength(9);
    for (const path of PRODUCTION_PATHS) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });

  it('stays at or below the L18 migration-unit ceiling', () => {
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(179);
  });

  it.each(OWNED_ROUTES)('%s is clean with no deferred fallback', (route) => {
    expect(current.cleanRoutes).toContain(route);
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
  });

  it('keeps the application-side contracts free of backend selection and drivers', () => {
    for (const path of [
      'src/lib/ai/durable-runs/runtime.ts',
      'src/lib/ai/provider-client.ts',
      'src/lib/ai/provider-runtime.ts',
      'src/lib/houston-memory/service.ts',
      'src/lib/houston-memory/summary.ts',
      'src/lib/intake/ai-parser.ts',
      'src/lib/semantic-index/source/facade.ts',
    ]) {
      const text = source(path);
      expect(text, path).not.toMatch(/better-sqlite3|drizzle-orm|@\/db(?:['"/])/);
      expect(text, path).not.toMatch(/resolveDatabaseBackend|MC_DATABASE_BACKEND/);
    }
    const providerClient = source('src/lib/ai/provider-client.ts');
    expect(providerClient).not.toMatch(
      /getCorePersistenceRepositories|getWorkerPersistenceRepositories|getProcessRuntimeSlot/,
    );
    expect(source('src/lib/ai/durable-runs/runtime.ts'))
      .not.toMatch(/import\(|sqlite-adapter/);
    expect(source('src/lib/semantic-index/source/facade.ts'))
      .not.toMatch(/import\(|sqlite-source-port|@\/db\/runtime/);
  });

  it('confines concrete adapter construction to the database composition root', () => {
    const runtime = source('src/db/runtime.ts');
    expect(runtime).toContain("import('@/lib/ai/durable-runs/sqlite-adapter')");
    expect(runtime).toContain("import('@/lib/semantic-index/source/sqlite-source-port')");
    expect(runtime).toContain('new PostgresDurableAiRunRepository(pool)');
    expect(runtime).toContain('createPostgresSemanticSourcePort(pool)');
    expect(runtime).toContain('registerDurableAiRunRepository(');
    expect(runtime).toContain('registerSemanticSourcePort(');
  });

  it('attributes all three library removals to the frozen production changes', () => {
    for (const path of REMOVED_TAINTED_LIBRARIES) {
      expect(current.taintedLibA).not.toContain(path);
    }
    expect(source('src/lib/intake/ai-parser.ts'))
      .toContain("from '@/lib/ai/provider-runtime'");
    expect(source('src/lib/intake/ai-parser.ts')).not.toMatch(
      /provider-factory|config-resolver|import\(/,
    );
  });
});
