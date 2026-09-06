import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const ROUTES = [
  'src/app/api/ai/dispatch/route.ts',
  'src/app/api/ai/route.ts',
  'src/app/api/goals/promote/route.ts',
  'src/app/api/goals/route.ts',
  'src/app/api/ideation/convert/route.ts',
  'src/app/api/resets/route.ts',
  'src/app/api/resets/stats/route.ts',
] as const;

const LIBRARIES = [
  'src/lib/ai/agents/index.ts',
  'src/lib/ai/agents/maintenance.ts',
  'src/lib/ai/features/chat.ts',
  'src/lib/ai/tools/index.ts',
  'src/lib/ai/tools/notification-tools.ts',
  'src/lib/ai/tools/reasoning-tools.ts',
  'src/lib/ai/tools/task-tools.ts',
  'src/lib/ai/tools/triage-tools.ts',
] as const;

const CONTRACT = 'src/db/persistence/ai-workflows.ts';
const SQLITE_ADAPTER = 'src/db/persistence/sqlite-ai-workflow-repository.ts';
const POSTGRES_ADAPTER = 'src/db/postgres/repositories/ai-workflow-repository.ts';
const HOUSTON_MEMORY_TOOLS = 'src/lib/ai/tools/houston-memory-tools.ts';
const HOUSTON_MEMORY_RETRIEVAL_CORE = 'src/lib/houston-memory/retrieval-core.ts';
const HOUSTON_MEMORY_LEGACY_RETRIEVAL = 'src/lib/houston-memory/retrieval.ts';

const OWNED_TESTS = [
  'tests/contracts/ai-workflow-persistence.contract.ts',
  'tests/db/sqlite-ai-workflow-persistence.contract.test.ts',
  'tests/db/postgres-ai-workflow-persistence.contract.integration.test.ts',
  'tests/api/postgres-ai-workflows-poisoned.test.ts',
  'tests/ai/maintenance-agents.test.ts',
  'tests/api/goals.test.ts',
  'tests/api/ideation-convert.test.ts',
  'tests/api/ideation-convert-integration.test.ts',
  'tests/api/reset-stats-timezone.test.ts',
  'tests/api/routes.test.ts',
  'tests/lib/triage-ai-tools.test.ts',
  'tests/api/ai-application-workflows.test.ts',
  'tests/lib/ai-application-tools.test.ts',
  'tests/architecture/ai-application-workflow-parity-taint-decrement.test.ts',
] as const;

// The merged parent now owns the canonical exact-current baseline. This layer
// only ratchets the remaining migration-unit ceiling after cleaning its seven
// routes and eight libraries.
const MIGRATION_UNIT_CEILING = 9;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

const current = computeWebPersistenceGraph(process.cwd());

describe('AI application workflow parity taint decrement', () => {
  it('pins only the owned production and proof paths', () => {
    expect(ROUTES).toHaveLength(7);
    expect(LIBRARIES).toHaveLength(8);
    for (const path of [
      ...ROUTES,
      ...LIBRARIES,
      CONTRACT,
      SQLITE_ADAPTER,
      POSTGRES_ADAPTER,
      HOUSTON_MEMORY_TOOLS,
      HOUSTON_MEMORY_RETRIEVAL_CORE,
      ...OWNED_TESTS,
    ]) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });

  it.each(ROUTES)('%s is clean', (route) => {
    expect(current.cleanRoutes).toContain(route);
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
  });

  it.each(LIBRARIES)('%s is clean and backend-neutral', (path) => {
    expect(current.taintedLibA).not.toContain(path);
    expect(source(path)).not.toMatch(
      /better-sqlite3|\bfrom\s*['"]pg['"]|drizzle-orm|@\/db\/schema|@\/db['"]/,
    );
    expect(source(path)).not.toMatch(/provider-factory|config-resolver/);
    expect(source(path)).not.toMatch(/@\/lib\/ai\/index['"]/);
  });

  it('keeps the extended contract typed and free of persistence escape hatches', () => {
    const contract = code(CONTRACT);
    expect(contract).toContain('export interface AIWorkflowPersistence');
    expect(contract).toContain('taskTools: AITaskToolsPersistence');
    expect(contract).toContain('dispatch: AIDispatchPersistence');
    expect(contract).toContain('maintenance: AIMaintenancePersistence');
    expect(contract).toContain('goalsBoard: AIGoalsBoardPersistence');
    expect(contract).toContain('ideation: AIIdeationPersistence');
    expect(contract).toContain('resets: AIResetsPersistence');
    expect(contract).not.toMatch(
      /better-sqlite3|\bfrom\s*['"]pg['"]|drizzle-orm|@\/db\/schema|@\/db\/postgres/,
    );
    expect(contract).not.toMatch(/\b(?:db|sql|query|table|transaction)\s*[:(]/i);
  });

  it('composes the same backend-specific adapters extended with typed application-workflow methods', () => {
    const sqlite = source(SQLITE_ADAPTER);
    expect(sqlite).toContain("import type Database from 'better-sqlite3'");
    expect(sqlite).not.toMatch(/\bfrom\s*['"]pg['"]/);
    expect(sqlite).toContain('createSqliteMaintenancePersistence');
    expect(sqlite).toContain('createSqliteGoalsBoardPersistence');
    expect(sqlite).toContain('createSqliteIdeationPersistence');
    expect(sqlite).toContain('createSqliteResetsPersistence');
    expect(sqlite).toContain('transaction.immediate()');

    const postgres = source(POSTGRES_ADAPTER);
    expect(postgres).toContain("import type { Pool, PoolClient, QueryResultRow } from 'pg'");
    expect(postgres).not.toMatch(/better-sqlite3|drizzle-orm|@\/db\/schema/);
    expect(postgres).toContain('createPostgresMaintenancePersistence');
    expect(postgres).toContain('createPostgresGoalsBoardPersistence');
    expect(postgres).toContain('createPostgresIdeationPersistence');
    expect(postgres).toContain('createPostgresResetsPersistence');
    // Deterministic advisory locks guard the non-unique keys this layer serializes on.
    expect(postgres).toContain("pg_advisory_xact_lock(hashtext($1))");
    expect(postgres).toContain('`maintenance-agent:${agentType}`');
    expect(postgres).toContain('`project:${projectId}`');
    expect(postgres).toContain('`project:${project.id}`');
    expect(postgres).toContain('`tag-slug:${slug}`');
    expect(postgres).toContain('`reset:${type}:${periodStart}`');
  });

  it('keeps maintenance-agent budgets, external I/O ordering, and the dispatch context bounded', () => {
    expect(source('src/lib/ai/agents/maintenance.ts')).toContain(
      'scanLimit: 101',
    );
    expect(source('src/lib/ai/agents/maintenance.ts')).toContain(
      'mutationLimit: 100',
    );
    expect(source('src/lib/ai/agents/maintenance.ts')).toContain(
      'detailLimit: 20',
    );
    expect(source('src/lib/ai/agents/maintenance.ts')).toContain(
      'durationMs: 5_000',
    );
    expect(source('src/lib/ai/agents/index.ts')).toContain(
      'taskLimit: 20',
    );
    expect(source('src/lib/ai/agents/index.ts')).toContain(
      'notificationLimit: 10',
    );
    expect(source('src/lib/ai/agents/index.ts')).toContain('getAsyncAIModel');
  });

  it('validates the ideation graph before the adapter-owned atomic conversion', () => {
    const route = source('src/app/api/ideation/convert/route.ts');
    expect(route).toContain('validateHierarchy(');
    expect(route).toContain('wouldCreateBlockingCycle(');
    expect(route).toContain('persistence.ideation.convertDraft(');
    // The validation calls must appear before the adapter command is reached.
    expect(route.indexOf('validateHierarchy(')).toBeLessThan(
      route.indexOf('persistence.ideation.convertDraft('),
    );
  });

  it('routes task-tool mutations through the clean task-core write seam', () => {
    const taskTools = source('src/lib/ai/tools/task-tools.ts');
    expect(taskTools).toContain("from '@/lib/tasks/core/runtime'");
    expect(taskTools).toContain('getTaskWriteContext');
    expect(taskTools).toContain('mutateTask');
    expect(taskTools).not.toMatch(/@\/db(?:['"/])|better-sqlite3|drizzle-orm/);
  });

  it('routes notification reads only through notification-web-service', () => {
    const notificationTools = source('src/lib/ai/tools/notification-tools.ts');
    expect(notificationTools).toContain(
      "from '@/lib/notifications/notification-web-service'",
    );
    expect(notificationTools).toContain('queryNotifications');
    expect(notificationTools).not.toMatch(/@\/db(?:['"/])|better-sqlite3|drizzle-orm/);
  });

  it('imports the portable triage queue-query module, never the legacy one', () => {
    const triageTools = source('src/lib/ai/tools/triage-tools.ts');
    expect(triageTools).toContain("from '@/lib/triage/queue-query'");
    expect(triageTools).not.toContain("from '@/lib/triage/query'");
  });

  it('keeps Houston memory retrieval sharing one algorithm without a 16th tainted-lib decrement', () => {
    expect(current.taintedLibA).toContain(HOUSTON_MEMORY_LEGACY_RETRIEVAL);
    expect(current.taintedLibA).not.toContain(HOUSTON_MEMORY_RETRIEVAL_CORE);
    expect(current.taintedLibA).not.toContain(HOUSTON_MEMORY_TOOLS);

    const legacy = source(HOUSTON_MEMORY_LEGACY_RETRIEVAL);
    expect(legacy).toContain(
      "from '@/lib/semantic-index/runtime'",
    );

    const tools = source(HOUSTON_MEMORY_TOOLS);
    expect(tools).not.toContain("import('@/lib/houston-memory/retrieval')");
    expect(tools).not.toContain("from '@/lib/houston-memory/retrieval'");
    expect(tools).toContain("from '@/lib/houston-memory/retrieval-core'");

    const core = source(HOUSTON_MEMORY_RETRIEVAL_CORE);
    expect(core).toContain("from '@/lib/search/semantic'");
    expect(core).not.toContain("from '@/lib/semantic-index/runtime'");
    expect(core).not.toContain("import('@/lib/semantic-index/runtime')");
  });

  it('only ratchets the migration-unit ceiling and never reads the canonical baseline', () => {
    const self = source('tests/architecture/ai-application-workflow-parity-taint-decrement.test.ts');
    expect(self).not.toContain(['web-persistence', 'baseline.json'].join('-'));
    expect(self).not.toContain(['postgres', 'route', 'sentinel'].join('-'));
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(MIGRATION_UNIT_CEILING);
    expect(current.taintedApiHelpers).toHaveLength(0);
  });
});
