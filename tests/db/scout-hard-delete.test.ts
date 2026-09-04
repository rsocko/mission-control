import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

describe('Scout hard delete', () => {
  const dbPath = join(process.cwd(), 'data', `scout-hard-delete-${process.pid}-${Date.now()}.db`);
  const originalDbPath = process.env.MC_DB_PATH;
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;
  let hardDeleteScoutTask: typeof import('@/lib/tasks/scout-hard-delete').hardDeleteScoutTask;

  beforeAll(async () => {
    process.env.MC_DB_PATH = dbPath;
    vi.doUnmock('crypto');
    vi.doUnmock('drizzle-orm');
    vi.resetModules();
    const dbModule = await importInitializedSqliteDatabase();
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    ({ hardDeleteScoutTask } = await import('@/lib/tasks/scout-hard-delete'));
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

  it('rolls back the tombstone if graph deletion fails, then removes the full graph', async () => {
    const now = '2026-08-05T13:00:00.000Z';
    db.insert(schema.tasks).values([
      {
        id: 'scout-root',
        sourceId: 'scout:email:hard-delete',
        connectorType: 'scout',
        connectorInstanceId: 'scout-primary',
        title: 'Root',
        status: 'todo',
        priority: 'medium',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'scout-child',
        sourceId: 'local:scout-child',
        connectorType: 'scout',
        connectorInstanceId: 'scout-primary',
        title: 'Child',
        status: 'todo',
        priority: 'none',
        parentId: 'scout-root',
        depth: 1,
        isChecklistItem: true,
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
    ]).run();
    db.insert(schema.taskTags).values({ taskId: 'scout-root', tagId: 'tag-1' }).run();
    db.insert(schema.taskProjects).values({ taskId: 'scout-root', projectId: 'project-1' }).run();
    db.insert(schema.projectPhases).values({
      id: 'phase-1',
      name: 'Phase 1',
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(schema.projectPhaseItems).values({
      id: 'phase-item-1',
      phaseId: 'phase-1',
      taskId: 'scout-root',
      createdAt: now,
    }).run();
    db.insert(schema.taskSchedules).values({
      taskId: 'scout-root',
      scheduledDate: '2026-08-05',
      isTimeBlocked: false,
    }).run();
    db.insert(schema.taskFieldStates).values({
      taskId: 'scout-root',
      fieldName: 'title',
      sourceValue: '"Root"',
      locallyOverridden: false,
      sourceObservedAt: now,
      updatedAt: now,
    }).run();
    db.insert(schema.taskDependencies).values({
      id: 'dependency-1',
      taskId: 'scout-child',
      dependsOnTaskId: 'scout-root',
      type: 'blocks',
      syncStatus: 'local',
      createdAt: now,
    }).run();
    db.insert(schema.taskAttachments).values({
      id: 'attachment-1',
      taskId: 'scout-root',
      name: 'note.txt',
      contentType: 'text/plain',
      size: 4,
      contentBase64: 'dGVzdA==',
      createdAt: now,
    }).run();
    db.insert(schema.scoutReconciliationRuns).values({
      id: 'run-1',
      scopeKey: 'task:scout-root',
      scopeType: 'task',
      scopeId: 'scout-root',
      lookbackHours: 24,
      dryRun: false,
      source: 'api',
      sourceIdentity: 'test',
      idempotencyKey: 'run-1',
      requestHash: 'request',
      leaseToken: 'lease',
      status: 'completed',
      startedAt: now,
      completedAt: now,
    }).run();
    db.insert(schema.scoutReconciliationEvaluations).values({
      id: 'evaluation-1',
      runId: 'run-1',
      taskId: 'scout-root',
      candidateAction: 'no-change',
      action: 'no-change',
      confidence: 1,
      evidenceHash: 'evidence',
      evidence: [],
      policyDecision: 'not-applicable',
      policyReason: 'test',
      payloadHash: 'payload',
      applied: false,
      createdAt: now,
    }).run();
    db.insert(schema.scoutReconciliationTaskState).values({
      taskId: 'scout-root',
      neverAutoComplete: true,
      reason: 'test',
      updatedAt: now,
      updatedBy: 'test',
    }).run();

    sqlite.exec(`
      CREATE TRIGGER fail_scout_task_delete
      BEFORE DELETE ON tasks
      BEGIN
        SELECT RAISE(ABORT, 'forced delete failure');
      END
    `);
    await expect(hardDeleteScoutTask('scout-root')).rejects.toThrow('forced delete failure');
    expect(sqlite.prepare(
      'SELECT COUNT(*) AS count FROM task_ingest_suppressions',
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE id = 'scout-root'",
    ).get()).toEqual({ count: 1 });

    sqlite.exec('DROP TRIGGER fail_scout_task_delete');
    expect(await hardDeleteScoutTask('scout-root')).toMatchObject({
      kind: 'deleted',
      sourceId: 'scout:email:hard-delete',
      deletedTaskIds: expect.arrayContaining(['scout-root', 'scout-child']),
    });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE id IN ('scout-root', 'scout-child')",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM task_tags WHERE task_id = 'scout-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM task_attachments WHERE task_id = 'scout-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM project_phase_items WHERE task_id = 'scout-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM scout_reconciliation_evaluations WHERE task_id = 'scout-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM scout_reconciliation_task_state WHERE task_id = 'scout-root'",
    ).get()).toEqual({ count: 0 });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM task_history_events WHERE task_id IN ('scout-root', 'scout-child')",
    ).get()).toEqual({ count: 0 });
    sqlite.prepare(`
      INSERT INTO task_history_events (
        task_id, event_type, occurred_at, recorded_at, provenance
      ) VALUES (?, 'baseline', ?, ?, 'local')
    `).run('other', now, now);
    expect(() => sqlite.exec("DELETE FROM task_history_events WHERE task_id = 'other'"))
      .toThrow('task_history_events is append-only');
    expect(sqlite.prepare(`
      SELECT connector_instance_id AS connectorInstanceId, source_id AS sourceId, reason
      FROM task_ingest_suppressions
    `).get()).toEqual({
      connectorInstanceId: 'scout-primary',
      sourceId: 'scout:email:hard-delete',
      reason: 'hard-deleted',
    });
  });

  it('does not apply the Scout hard-delete contract to other sources', async () => {
    const now = '2026-08-05T13:00:00.000Z';
    db.insert(schema.tasks).values({
      id: 'local-task',
      sourceId: 'local:task',
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Local task',
      status: 'todo',
      priority: 'none',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    }).run();

    expect(await hardDeleteScoutTask('local-task')).toEqual({ kind: 'not-scout' });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE id = 'local-task'",
    ).get()).toEqual({ count: 1 });
  });
});
