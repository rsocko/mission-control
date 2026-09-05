import { createHash } from 'node:crypto';
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

const TEST_PATHS = [
  'tests/ai/durable-run-runtime.test.ts',
  'tests/ai/durable-run-completion-notifier.test.ts',
  'tests/ai/durable-runs.test.ts',
  'tests/ai/provider-runtime.test.ts',
  'tests/api/ai-control-plane-postgres-poisoned.test.ts',
  'tests/architecture/ai-execution-memory-parity.test.ts',
  'tests/architecture/final-worker-persistence-boundary.test.ts',
  'tests/db/postgres-houston-memory-repository.integration.test.ts',
  'tests/db/process-wide-runtime-registries.test.ts',
  'tests/db/runtime-core-registration.test.ts',
  'tests/db/sqlite-runtime-composition.test.ts',
  'tests/helpers/process-runtime-registries.ts',
  'tests/houston-memory/summary.test.ts',
  'tests/semantic-index/backend-selection.test.ts',
  'tests/sync/postgres-web-composition-poisoned.test.ts',
  'tests/contracts/finance-assistant-persistence.contract.ts',
  'tests/architecture/ai-provider-configuration-parity.test.ts',
  'tests/architecture/analytics-taint-decrement.test.ts',
  'tests/architecture/external-agent-taint-decrement.test.ts',
  'tests/architecture/finance-connector-web-parity.test.ts',
  'tests/architecture/finance-web-parity.test.ts',
  'tests/architecture/ideation-workspace-taint-decrement.test.ts',
  'tests/architecture/l11-connector-core-parity.test.ts',
  'tests/architecture/l12a-connector-domains-parity.test.ts',
  'tests/architecture/notification-web-taint-decrement.test.ts',
  'tests/architecture/project-hierarchy-taint-decrement.test.ts',
  'tests/architecture/runtime-observability-parity.test.ts',
  'tests/architecture/task-core-taint-decrement.test.ts',
  'tests/architecture/task-read-taint-decrement.test.ts',
  'tests/architecture/task-write-taint-decrement.test.ts',
  'tests/architecture/triage-native-web-persistence-boundary.test.ts',
  'tests/architecture/transfer-identity-taint-decrement.test.ts',
] as const;

const ARCHITECTURE_PATHS = [
  'docs/architecture/persistence-boundaries.md',
  'tests/architecture/web-persistence-baseline.json',
] as const;

const ROUTE_HASHES = {
  'src/app/api/ai/intake-document/route.ts':
    'd782c784e63b5ea3028689b039e2a23c1e0f79a3a666cd70cc68909d9def21f2',
  'src/app/api/ai/memories/[id]/route.ts':
    '6b54fb907e450a84f6a891aecc640852f085e28256efe27fff38a985d6490be2',
  'src/app/api/ai/memories/route.ts':
    '3174343b37b3a99db51f1a588f54cb5deb6b66b327c8a9cdd47a44d2373c46a2',
  'src/app/api/ai/runs/[runId]/cancel/route.ts':
    'e8e2e1d152532da59b3a6b3941bf92a3beb255ac34e7cefca6c047258b7dacc6',
  'src/app/api/ai/runs/[runId]/events/route.ts':
    'dcda430db1ff1f70a83c7621edaf26067a805af24e3b865907ce7eb406e5b62d',
  'src/app/api/ai/runs/[runId]/retry/route.ts':
    '305ca4fa7ab0d52f8616c4187f07020dd60b3d9b8f2bc172566ed9fa5c380ef8',
  'src/app/api/ai/runs/[runId]/route.ts':
    '113582fc98b9302e6393cb23a1102a1b2c69440023462c6717bea273ddf6a94e',
  'src/app/api/ai/runs/route.ts':
    '32ad042311fbf1104ae9b7327a9ae4620bf93acef9550cb454e72e08e48316c8',
} as const;

const REMOVED_TAINTED_LIBRARIES = [
  'src/lib/ai/tools/intake-tools.ts',
  'src/lib/intake/ai-parser.ts',
  'src/lib/intake/index.ts',
] as const;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const baseline = JSON.parse(
  source('tests/architecture/web-persistence-baseline.json'),
) as {
  decrementHistory: Array<{
    layer: string;
    totalMigrationUnits: { from: number; to: number; delta: number };
    removedTaintedLibA: string[];
    removedTierBRoutes: string[];
    newlyCleanRoutes: string[];
    notMigratedFromTheOwnedFileSet: string[];
  }>;
};
const current = computeWebPersistenceGraph(process.cwd());

describe('L18 AI execution and memory control-plane parity', () => {
  it('pins the CI-proven 43-path cap', () => {
    expect(PRODUCTION_PATHS).toHaveLength(9);
    expect(TEST_PATHS).toHaveLength(32);
    expect(ARCHITECTURE_PATHS).toHaveLength(2);
    for (const path of [...PRODUCTION_PATHS, ...TEST_PATHS, ...ARCHITECTURE_PATHS]) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });

  it('keeps every owned route byte-identical to the #1785 baseline', () => {
    for (const [path, hash] of Object.entries(ROUTE_HASHES)) {
      const text = source(path);
      const checkoutHashes = [
        createHash('sha256').update(text).digest('hex'),
        createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'),
      ];
      expect(checkoutHashes, path).toContain(hash);
    }
  });

  it('records the exact Tier B and library decrement', () => {
    const entry = baseline.decrementHistory.find(({ layer }) => layer === 'L18');
    expect(entry?.totalMigrationUnits).toEqual({ from: 182, to: 179, delta: -3 });
    expect(entry?.removedTierBRoutes).toEqual(Object.keys(ROUTE_HASHES));
    expect(entry?.newlyCleanRoutes).toEqual(Object.keys(ROUTE_HASHES));
    expect(entry?.removedTaintedLibA).toEqual([...REMOVED_TAINTED_LIBRARIES]);
    expect(entry?.notMigratedFromTheOwnedFileSet).toEqual([]);
  });

  it.each(Object.keys(ROUTE_HASHES))('%s is clean with no deferred fallback', (route) => {
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

  it('holds the exact composed graph', () => {
    expect({
      apiRoutes: current.apiRoutes.length,
      tierARoutes: current.tierARoutes.length,
      tierBRoutes: current.tierBRoutes.length,
      cleanRoutes: current.cleanRoutes.length,
      directTaintSourceRoutes: current.directTaintSourceRoutes.length,
      transitiveOnlyTaintSourceRoutes: current.transitiveOnlyTaintSourceRoutes.length,
      directDbNamespaceRoutes: current.directDbNamespaceRoutes.length,
      taintedLibA: current.taintedLibA.length,
      taintedApiHelpers: current.taintedApiHelpers.length,
      totalMigrationUnits: current.totalMigrationUnits,
    }).toEqual({
      apiRoutes: 266,
      tierARoutes: 113,
      tierBRoutes: 5,
      cleanRoutes: 148,
      directTaintSourceRoutes: 83,
      transitiveOnlyTaintSourceRoutes: 30,
      directDbNamespaceRoutes: 84,
      taintedLibA: 58,
      taintedApiHelpers: 0,
      totalMigrationUnits: 171,
    });
  });
});
