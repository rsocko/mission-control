import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const ROUTES = [
  'src/app/api/ai/assign-projects/route.ts',
  'src/app/api/ai/context-tasks/route.ts',
  'src/app/api/ai/context-triage/route.ts',
  'src/app/api/ai/daily-digest/route.ts',
  'src/app/api/ai/infer-tags/route.ts',
  'src/app/api/ai/plan-day/route.ts',
  'src/app/api/ai/smart-priority/route.ts',
  'src/app/api/ai/suggest-energy-tags/route.ts',
  'src/app/api/ai/suggest-focus/route.ts',
  'src/app/api/ai/suggest-micro-status/route.ts',
  'src/app/api/ai/triage-alerts/route.ts',
  'src/app/api/ai/whats-next/route.ts',
  'src/app/api/goals/develop/route.ts',
  'src/app/api/ideation/expand/route.ts',
  'src/app/api/project-phases/ai-refine/route.ts',
  'src/app/api/project-phases/ai-suggest/route.ts',
  'src/app/api/resets/ai-summary/route.ts',
  'src/app/api/tasks/[id]/breakdown/route.ts',
] as const;

const LIBRARIES = [
  'src/lib/ai/context-budget.ts',
  'src/lib/ai/features/daily-digest.ts',
  'src/lib/ai/features/energy-tag-queries.ts',
  'src/lib/ai/features/energy-tag-suggestions.ts',
  'src/lib/ai/features/micro-status-suggestions.ts',
  'src/lib/ai/features/notification-classification.ts',
  'src/lib/ai/features/notification-queries.ts',
  'src/lib/ai/features/project-assignment.ts',
  'src/lib/ai/features/smart-priority.ts',
  'src/lib/ai/features/tag-inference.ts',
  'src/lib/ai/features/whats-next.ts',
  'src/lib/ai/ideation-expand.ts',
] as const;
const CONTRACT = 'src/db/persistence/ai-workflows.ts';
const DAILY_PLANNING_CONTRACT = 'src/db/persistence/daily-planning.ts';
const PROJECT_ORGANIZATION_CONTRACT = 'src/db/persistence/project-organization.ts';
const SQLITE_ADAPTER = 'src/db/persistence/sqlite-ai-workflow-repository.ts';
const POSTGRES_ADAPTER = 'src/db/postgres/repositories/ai-workflow-repository.ts';
const OWNED_TESTS = [
  'tests/contracts/ai-workflow-persistence.contract.ts',
  'tests/db/sqlite-ai-workflow-persistence.contract.test.ts',
  'tests/db/postgres-ai-workflow-persistence.contract.integration.test.ts',
  'tests/api/postgres-ai-workflows-poisoned.test.ts',
  'tests/architecture/ai-workflow-parity-taint-decrement.test.ts',
] as const;
const MIGRATION_UNIT_CEILING = 23;

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

const current = computeWebPersistenceGraph(process.cwd());

describe('AI workflow parity taint decrement', () => {
  it('pins only the owned production and proof paths', () => {
    expect(ROUTES).toHaveLength(18);
    expect(LIBRARIES).toHaveLength(12);
    for (const path of [
      ...ROUTES,
      ...LIBRARIES,
      CONTRACT,
      DAILY_PLANNING_CONTRACT,
      PROJECT_ORGANIZATION_CONTRACT,
      SQLITE_ADAPTER,
      POSTGRES_ADAPTER,
      ...OWNED_TESTS,
    ]) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });

  it.each(ROUTES)('%s is clean', (route) => {
    expect(current.cleanRoutes).toContain(route);
    expect(current.tierARoutes).not.toContain(route);
    expect(current.tierBRoutes).not.toContain(route);
    expect(current.directDbNamespaceRoutes).not.toContain(route);
  });

  it.each(LIBRARIES)('%s is clean and backend-neutral', (path) => {
    expect(current.taintedLibA).not.toContain(path);
    expect(source(path)).not.toMatch(
      /better-sqlite3|\bfrom\s*['"]pg['"]|drizzle-orm|@\/db\/schema|@\/db['"]/,
    );
    expect(source(path)).not.toMatch(/provider-factory|config-resolver/);
  });

  it('keeps the contract typed and free of persistence escape hatches', () => {
    const aiContract = code(CONTRACT);
    const contracts = [
      aiContract,
      code(DAILY_PLANNING_CONTRACT),
      code(PROJECT_ORGANIZATION_CONTRACT),
    ].join('\n');
    expect(aiContract).toContain('export interface AIWorkflowPersistence');
    expect(contracts).not.toMatch(
      /better-sqlite3|\bfrom\s*['"]pg['"]|drizzle-orm|@\/db\/schema|@\/db\/postgres/,
    );
    expect(aiContract).not.toMatch(/\b(?:db|sql|query|table|transaction)\s*[:(]/i);
  });

  it('composes one backend-specific adapter and protects snapshot/write consistency', () => {
    expect(source('src/db/persistence/sqlite-worker-runtime.ts'))
      .toContain('const aiWorkflows = createSqliteAIWorkflowPersistence(sqlite)');
    expect(source('src/db/persistence/sqlite-daily-planning-repository.ts'))
      .toContain('const aiDailyPlanning = createSqliteAIDailyPlanningExtensions(sqlite)');
    expect(source('src/db/persistence/sqlite-project-organization-repositories.ts'))
      .toContain('const aiPlanning = createSqliteAIProjectOrganizationExtensions(sqlite)');
    expect(source('src/db/postgres/repositories/index.ts'))
      .toContain('const aiWorkflows = createPostgresAIWorkflowPersistence(pool)');
    expect(source('src/db/postgres/repositories/daily-planning-repository.ts'))
      .toContain('const aiDailyPlanning = createPostgresAIDailyPlanningExtensions(pool)');
    expect(source('src/db/postgres/repositories/project-organization-repositories.ts'))
      .toContain('const aiPlanning = createPostgresAIProjectOrganizationExtensions(pool)');
    expect(source('src/db/runtime.ts'))
      .toContain("aiWorkflows: new Proxy(");

    const sqlite = source(SQLITE_ADAPTER);
    expect(sqlite).toContain("import type Database from 'better-sqlite3'");
    expect(sqlite).not.toMatch(/\bfrom\s*['"]pg['"]/);
    expect(sqlite).toContain('transaction.immediate()');

    const postgres = source(POSTGRES_ADAPTER);
    expect(postgres).toContain("import type { Pool, PoolClient, QueryResultRow } from 'pg'");
    expect(postgres).not.toMatch(/better-sqlite3|drizzle-orm|@\/db\/schema/);
    expect(postgres).toContain('tag-slug:${definition.slug}');
    expect(postgres).toContain('task-ancillary:${suggestion.taskId}');
    expect(postgres).toContain('pg_advisory_xact_lock(hashtext($1))');
    expect(postgres).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(postgres).toContain('ON CONFLICT DO NOTHING');
  });

  it('reuses the existing planning seams and the atomic AI breakdown projection', () => {
    expect(source('src/app/api/ai/plan-day/route.ts')).toContain(
      'getAIDailyPlanningPersistence',
    );
    expect(source('src/app/api/ai/suggest-focus/route.ts')).toContain(
      'persistence.focus.getSuggestionContext',
    );
    expect(source('src/app/api/project-phases/ai-refine/route.ts')).toContain(
      "from '@/lib/projects/organization-service'",
    );
    expect(source('src/app/api/goals/develop/route.ts')).toContain(
      'getGoalDevelopmentContext',
    );
    expect(source('src/app/api/tasks/[id]/breakdown/route.ts')).toContain(
      'getAIWorkflowPersistence',
    );
    expect(source('src/app/api/tasks/[id]/breakdown/route.ts')).toContain(
      'getTaskBreakdownContext',
    );
  });

  it('only ratchets the migration-unit ceiling and never reads the canonical baseline', () => {
    const self = source('tests/architecture/ai-workflow-parity-taint-decrement.test.ts');
    expect(self).not.toContain(['web-persistence', 'baseline.json'].join('-'));
    expect(self).not.toContain(['postgres', 'route', 'sentinel'].join('-'));
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(MIGRATION_UNIT_CEILING);
  });
});
