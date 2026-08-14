import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';

describe('repointTaskReferences', () => {
  const dbPath = join(process.cwd(), 'data', `task-reference-repoint-${process.pid}-${Date.now()}.db`);
  const originalDbPath = process.env.MC_DB_PATH;
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;
  let runTransaction: typeof import('@/db').runTransaction;
  let repointTaskReferences: typeof import('@/lib/tasks/task-reference-repoint').repointTaskReferences;

  beforeAll(async () => {
    process.env.MC_DB_PATH = dbPath;
    vi.doUnmock('drizzle-orm');
    vi.resetModules();
    const dbModule = await import('@/db');
    const references = await import('@/lib/tasks/task-reference-repoint');
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    runTransaction = dbModule.runTransaction;
    repointTaskReferences = references.repointTaskReferences;
  });

  afterAll(() => {
    sqlite.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${dbPath}${suffix}`;
      if (existsSync(file)) rmSync(file);
    }
    if (originalDbPath === undefined) delete process.env.MC_DB_PATH;
    else process.env.MC_DB_PATH = originalDbPath;
  });

  it('repoints every current logical-task reference and preserves placement identity', async () => {
    const sourceTaskId = 'inventory-source';
    const successorTaskId = 'inventory-successor';
    const now = '2026-08-14T12:00:00.000Z';
    await insertTask(sourceTaskId);
    await insertTask(successorTaskId);
    await insertTask('inventory-child', { parentId: sourceTaskId, depth: 1 });
    await insertTask('inventory-upstream');
    await insertTask('inventory-downstream');

    await db.insert(schema.myDayItems).values({
      id: 'inventory-my-day', taskId: sourceTaskId, date: '2026-08-14', addedAt: now,
    });
    await db.insert(schema.myDayExclusions).values({
      id: 'inventory-my-day-exclusion', taskId: sourceTaskId, date: '2026-08-14', removedAt: now,
    });
    await db.insert(schema.focusItems).values({
      id: 'inventory-focus', taskId: sourceTaskId, scope: 'today', date: '2026-08-14', slot: 1, addedAt: now,
    });
    await db.insert(schema.weeklyOneThing).values({
      id: 'inventory-weekly', taskId: sourceTaskId, weekMonday: '2026-08-10', createdAt: now,
    });
    await db.insert(schema.prioritySyncLog).values({
      id: 'inventory-priority',
      taskId: sourceTaskId,
      connectorType: 'local',
      connectorInstanceId: 'local',
      previousPriority: 'low',
      newPriority: 'high',
      direction: 'outbound',
      timestamp: now,
    });
    await db.insert(schema.quickSortLog).values({
      id: 'inventory-quick-sort',
      taskId: sourceTaskId,
      mode: 'no_priority',
      action: 'applied',
      triagedAt: now,
    });
    await db.insert(schema.projectAutoIncludeExclusions).values({
      projectId: 'inventory-project',
      taskId: sourceTaskId,
      excludedAt: now,
    });
    await db.insert(schema.hubProjects).values({
      id: 'inventory-project',
      name: 'Inventory project',
      hierarchyRevision: 7,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.taskProjects).values([
      { taskId: sourceTaskId, projectId: 'inventory-project' },
    ]);
    await db.insert(schema.projectPhases).values({
      id: 'inventory-phase',
      projectId: 'inventory-project',
      name: 'Inventory phase',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.projectPhaseItems).values({
      id: 'inventory-phase-item',
      phaseId: 'inventory-phase',
      taskId: sourceTaskId,
      sortOrder: 42.5,
      estimatedEffortHours: 3,
      isProposed: true,
      proposalType: 'split',
      createdAt: now,
    });
    await db.insert(schema.taskLinkedSources).values({
      id: 'inventory-linked-source',
      taskId: sourceTaskId,
      connectorType: 'github-issues',
      connectorInstanceId: 'github',
      sourceId: 'owner/repo#1',
      title: 'Linked',
      linkedAt: now,
    });
    await db.insert(schema.notifications).values({
      id: 'inventory-notification',
      sourceId: 'inventory-notification-source',
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Notification',
      receivedAt: now,
      sortAt: now,
      relatedTaskId: sourceTaskId,
    });
    await db.insert(schema.scoutReconciliationRuns).values({
      id: 'inventory-scout-run',
      scopeKey: 'task:inventory-source',
      scopeType: 'task',
      scopeId: sourceTaskId,
      lookbackHours: 24,
      source: 'api',
      sourceIdentity: 'test',
      idempotencyKey: 'inventory-scout-key',
      requestHash: 'inventory-request-hash',
      leaseToken: 'inventory-lease',
      status: 'completed',
      startedAt: now,
      completedAt: now,
    });
    await db.insert(schema.scoutReconciliationEvaluations).values({
      id: 'inventory-scout-evaluation',
      runId: 'inventory-scout-run',
      taskId: sourceTaskId,
      candidateAction: 'suggest-complete',
      action: 'suggest-complete',
      confidence: 0.8,
      evidenceHash: 'inventory-evidence',
      evidence: [],
      policyDecision: 'require-confirmation',
      policyReason: 'test',
      payloadHash: 'inventory-payload',
      createdAt: now,
    });
    await db.insert(schema.scoutReconciliationSuggestions).values({
      id: 'inventory-scout-suggestion',
      taskId: sourceTaskId,
      runId: 'inventory-scout-run',
      evaluationId: 'inventory-scout-evaluation',
      action: 'suggest-complete',
      status: 'pending',
      confidence: 0.8,
      evidenceHash: 'inventory-evidence',
      evidence: [],
      policyDecision: 'require-confirmation',
      policyReason: 'test',
      payloadHash: 'inventory-payload',
      proposedEffect: {},
      createdAt: now,
      updatedAt: now,
      expiresAt: '2026-08-15T12:00:00.000Z',
    });
    await db.insert(schema.scoutReconciliationTaskState).values({
      taskId: sourceTaskId,
      neverAutoComplete: true,
      reason: 'test',
      updatedAt: now,
      updatedBy: 'test',
    });
    await db.insert(schema.taskDependencies).values([
      {
        id: 'inventory-incoming',
        taskId: sourceTaskId,
        dependsOnTaskId: 'inventory-upstream',
        type: 'blocks',
        createdAt: now,
      },
      {
        id: 'inventory-outgoing',
        taskId: 'inventory-downstream',
        dependsOnTaskId: sourceTaskId,
        type: 'blocks',
        createdAt: now,
      },
    ]);
    const hierarchyRevisionBefore = sqlite.prepare(
      'SELECT hierarchy_revision AS hierarchyRevision FROM hub_projects WHERE id = ?',
    ).get('inventory-project');

    runTransaction((tx) => {
      repointTaskReferences(tx, sourceTaskId, successorTaskId);
    });

    for (const [table, column] of [
      ['my_day_items', 'task_id'],
      ['my_day_exclusions', 'task_id'],
      ['focus_items', 'task_id'],
      ['weekly_one_thing', 'task_id'],
      ['priority_sync_log', 'task_id'],
      ['task_triage_log', 'task_id'],
      ['project_auto_include_exclusions', 'task_id'],
      ['project_phase_items', 'task_id'],
      ['task_linked_sources', 'task_id'],
      ['task_projects', 'task_id'],
      ['scout_reconciliation_suggestions', 'task_id'],
      ['scout_reconciliation_task_state', 'task_id'],
    ]) {
      expect(count(table, column, sourceTaskId), `${table}.${column} source count`).toBe(0);
      expect(count(table, column, successorTaskId), `${table}.${column} successor count`).toBe(1);
    }
    expect(sqlite.prepare(
      `SELECT
         phase_id AS phaseId,
         task_id AS taskId,
         sort_order AS sortOrder,
         estimated_effort_hours AS estimatedEffortHours,
         is_proposed AS isProposed,
         proposal_type AS proposalType
       FROM project_phase_items
       WHERE id = ?`,
    ).get('inventory-phase-item')).toEqual({
      phaseId: 'inventory-phase',
      taskId: successorTaskId,
      sortOrder: 42.5,
      estimatedEffortHours: 3,
      isProposed: 1,
      proposalType: 'split',
    });
    expect(sqlite.prepare(
      'SELECT hierarchy_revision AS hierarchyRevision FROM hub_projects WHERE id = ?',
    ).get('inventory-project')).toEqual(hierarchyRevisionBefore);
    expect(queryCount('project_hierarchy_commands')).toBe(0);
    expect(queryCount('project_hierarchy_mutation_context')).toBe(0);
    expect(sqlite.prepare(
      'SELECT parent_id AS parentId FROM tasks WHERE id = ?',
    ).get('inventory-child')).toEqual({ parentId: successorTaskId });
    expect(sqlite.prepare(
      'SELECT related_task_id AS relatedTaskId FROM notifications WHERE id = ?',
    ).get('inventory-notification')).toEqual({ relatedTaskId: successorTaskId });
    expect(count('task_dependencies', 'task_id', sourceTaskId)).toBe(0);
    expect(count('task_dependencies', 'depends_on_task_id', sourceTaskId)).toBe(0);
    expect(count('task_dependencies', 'task_id', successorTaskId)).toBe(1);
    expect(count('task_dependencies', 'depends_on_task_id', successorTaskId)).toBe(1);
    expect(count('scout_reconciliation_evaluations', 'task_id', sourceTaskId)).toBe(1);
  });

  it('rolls back all prior repoints when any reference update fails', async () => {
    const sourceTaskId = 'rollback-source';
    const successorTaskId = 'rollback-successor';
    const now = '2026-08-14T12:00:00.000Z';
    await insertTask(sourceTaskId);
    await insertTask(successorTaskId);
    await insertTask('rollback-child', { parentId: sourceTaskId, depth: 1 });
    await db.insert(schema.myDayItems).values({
      id: 'rollback-my-day', taskId: sourceTaskId, date: '2026-08-14', addedAt: now,
    });
    await db.insert(schema.notifications).values({
      id: 'rollback-notification',
      sourceId: 'rollback-notification-source',
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Rollback notification',
      receivedAt: now,
      sortAt: now,
      relatedTaskId: sourceTaskId,
    });
    sqlite.exec(`
      CREATE TEMP TRIGGER fail_reference_repoint
      BEFORE UPDATE OF related_task_id ON notifications
      WHEN NEW.related_task_id = 'rollback-successor'
      BEGIN
        SELECT RAISE(ABORT, 'forced reference failure');
      END;
    `);

    try {
      let thrown: unknown;
      try {
        runTransaction((tx) => {
          repointTaskReferences(tx, sourceTaskId, successorTaskId);
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(
        'Failed to run the query',
      );
      expect((thrown as Error & { cause?: Error }).cause?.message).toContain(
        'forced reference failure',
      );
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS fail_reference_repoint');
    }

    expect(count('my_day_items', 'task_id', sourceTaskId)).toBe(1);
    expect(count('my_day_items', 'task_id', successorTaskId)).toBe(0);
    expect(sqlite.prepare(
      'SELECT parent_id AS parentId FROM tasks WHERE id = ?',
    ).get('rollback-child')).toEqual({ parentId: sourceTaskId });
    expect(sqlite.prepare(
      'SELECT related_task_id AS relatedTaskId FROM notifications WHERE id = ?',
    ).get('rollback-notification')).toEqual({ relatedTaskId: sourceTaskId });
  });

  async function insertTask(
    id: string,
    overrides: Partial<typeof schema.tasks.$inferInsert> = {},
  ) {
    const now = '2026-08-14T12:00:00.000Z';
    await db.insert(schema.tasks).values({
      id,
      sourceId: `local:${id}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: id,
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
      ...overrides,
    });
  }

  function count(table: string, column: string, value: string): number {
    const row = sqlite.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
    ).get(value) as { count: number };
    return row.count;
  }

  function queryCount(table: string): number {
    const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }
});
