import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWebPersistenceGraph } from './web-persistence-graph';

const OWNED_ROUTES = [
  'src/app/api/kanban-settings/route.ts',
  'src/app/api/smart-score/route.ts',
  'src/app/api/subtask-templates/route.ts',
  'src/app/api/tags/route.ts',
  'src/app/api/tags/merge/route.ts',
  'src/app/api/tags/push/route.ts',
  'src/app/api/tags/remove-from-source/route.ts',
  'src/app/api/tags/unify/route.ts',
  'src/app/api/tasks/[id]/move-to-list/route.ts',
  'src/app/api/tasks/[id]/relationships/route.ts',
  'src/app/api/tasks/[id]/relationships/[relationshipId]/route.ts',
  'src/app/api/tasks/move/preview/route.ts',
] as const;

const GRAPH_FACADE = 'src/lib/graph/service.ts';
const TASK_CORE_CONTRACT = 'src/lib/tasks/core/contracts.ts';
const SQLITE_ADAPTER = 'src/db/persistence/sqlite-task-core-repositories.ts';
const POSTGRES_ADAPTER = 'src/db/postgres/repositories/task-core-repositories.ts';

const FORBIDDEN_PERSISTENCE =
  /from\s+['"]@\/db(?:\/|['"])|import\(\s*['"]@\/db|better-sqlite3|drizzle-orm/;

/**
 * Type-only imports are erased before the module ever runs, so they evaluate no
 * persistence driver surface. Runtime taint is what this proof is about.
 */
const TYPE_ONLY_IMPORT = /^import\s+type\s[\s\S]*?from\s+['"][^'"]+['"];$/gm;

function source(file: string): string {
  return readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');
}

function runtimeSource(file: string): string {
  return source(file).replace(TYPE_ONLY_IMPORT, '');
}

const graph = computeWebPersistenceGraph(process.cwd());

describe('task organization persistence decrement', () => {
  it('stays at or below the task organization migration-unit ceiling', () => {
    expect(graph.totalMigrationUnits).toBeLessThanOrEqual(90);
  });

  it('owns exactly twelve routes', () => {
    expect(new Set(OWNED_ROUTES).size).toBe(12);
  });

  it.each(OWNED_ROUTES)('%s evaluates no persistence driver surface', (file) => {
    expect(runtimeSource(file)).not.toMatch(FORBIDDEN_PERSISTENCE);
  });

  it.each(OWNED_ROUTES)('%s is clean rather than deferred', (route) => {
    expect(graph.cleanRoutes).toContain(route);
    expect(graph.tierARoutes).not.toContain(route);
    expect(graph.tierBRoutes).not.toContain(route);
    expect(graph.directDbNamespaceRoutes).not.toContain(route);
  });

  it('routes the organization surface through the selected task-core runtime', () => {
    const organizationRoutes = OWNED_ROUTES.filter((route) =>
      !route.includes('/relationships'));
    for (const route of organizationRoutes) {
      const text = source(route);
      const usesTaskCore = text.includes("from '@/lib/tasks/core/runtime'");
      const usesCoreSettings = text.includes("from '@/lib/persistence/runtime'");
      expect(usesTaskCore || usesCoreSettings).toBe(true);
    }
  });

  it('keeps the graph service a driver-free selected-runtime facade', () => {
    const text = runtimeSource(GRAPH_FACADE);
    expect(text).not.toMatch(/better-sqlite3|drizzle-orm/);
    // The only sanctioned `@/db` specifier is the backend-neutral worker seam.
    const dbSpecifiers = [...text.matchAll(/from\s+['"](@\/db[^'"]*)['"]/g)]
      .map((match) => match[1]);
    expect(dbSpecifiers).toEqual(['@/db/persistence/worker-repositories']);
    expect(text).toContain("from '@/lib/persistence/worker-runtime'");
    expect(text).toContain('requireGraphReportingPersistence');
  });

  it('keeps the task-core contract backend neutral', () => {
    const text = source(TASK_CORE_CONTRACT);
    expect(text).not.toMatch(FORBIDDEN_PERSISTENCE);
    // No raw SQL, generic CRUD escape hatches, transactions, or backend handles.
    expect(text).not.toMatch(/\bsql`|\braw\s*\(|executeSql|runTransaction|\bBetterSqlite|\bPool\b/);
    expect(text).toContain('organization: TaskOrganizationRepository');
  });

  it('declares the organization repository as a mandatory persistence member', () => {
    const text = source(TASK_CORE_CONTRACT);
    // A mandatory member cannot be silently skipped by either backend.
    expect(text).not.toMatch(/organization\?\s*:/);
  });

  it('runs SQLite tag consolidation and template application in immediate transactions', () => {
    const adapter = source(SQLITE_ADAPTER);
    const organization = adapter.slice(
      adapter.indexOf('class SqliteTaskOrganizationRepository'),
    );
    expect(organization).not.toBe('');
    for (const method of [
      'createHubTag',
      'mergeTags',
      'unifyTags',
      'ensureBuiltInSubtaskTemplates',
      'applyWorkflowTemplate',
      'applySingleTemplate',
    ]) {
      const start = organization.search(
        new RegExp(`^  (?:async )?${method}\\(`, 'm'),
      );
      expect(start, `${method} is not declared on the organization repository`)
        .toBeGreaterThan(-1);
      const head = organization.slice(start, start + 900);
      expect(head, `${method} must open an immediate transaction`)
        .toMatch(/this\.runTransaction[<(]/);
      // `readOnly` would downgrade the runner to a deferred transaction.
      expect(head).not.toContain('readOnly: true');
    }
    // A single-statement finalize needs no explicit transaction to stay atomic.
    const finalize = organization.slice(
      organization.search(/^  (?:async )?finalizeTaskMoveToList\(/m),
    );
    expect(finalize).toContain('this.database.update(tasks)');
    // `@/db` maps every non-read-only runner call onto an immediate transaction.
    expect(source('src/db/index.ts'))
      .toContain("behavior: options.readOnly ? 'deferred' : 'immediate'");
  });

  it('guards PostgreSQL tag consolidation with a transaction advisory lock', () => {
    const adapter = source(POSTGRES_ADAPTER);
    const organization = adapter.slice(
      adapter.indexOf('class PostgresTaskOrganizationRepository'),
    );
    expect(organization).not.toBe('');
    const consolidationLocks = organization.match(
      /pg_advisory_xact_lock\(hashtext\('tag-consolidation'\)\)/g,
    );
    // Delete, merge, and unify serialize on the same consolidation key.
    expect(consolidationLocks).toHaveLength(3);
    expect(adapter).toContain(
      "pg_advisory_xact_lock_shared(hashtext('tag-consolidation'))",
    );
    expect(organization.match(/\.for\('key share'\)/g)).toHaveLength(2);
    expect(adapter).toContain(".for('update')");
    expect(organization).toContain('`tag-slug:${input.slug}`');
    expect(organization).toContain("hashtext('mission-control:subtask-template-seed')");
    expect(organization).toContain("isolationLevel: 'read committed'");
  });
});
