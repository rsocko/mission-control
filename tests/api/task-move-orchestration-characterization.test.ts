import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';

const connectorMocks = vi.hoisted(() => {
  const target = {
    type: 'microsoft-todo',
    createTask: vi.fn(),
    deleteTask: vi.fn(),
  };
  const source = {
    type: 'microsoft-todo',
    deleteTask: vi.fn(),
  };
  const sourceCloseOnly = {
    type: 'github-issues',
    completeTask: vi.fn(),
    addComment: vi.fn(),
  };
  return {
    target,
    source,
    sourceCloseOnly,
    getConnector: vi.fn((id: string) => {
      if (id === 'target-connector') return target;
      if (id === 'source-connector') return source;
      if (id === 'source-close-only') return sourceCloseOnly;
      return undefined;
    }),
  };
});

const loggerMocks = vi.hoisted(() => ({
  dbError: vi.fn(),
  connectorError: vi.fn(),
  connectorInfo: vi.fn(),
  connectorWarn: vi.fn(),
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: connectorMocks.getConnector,
    createConnector: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  default: { error: loggerMocks.connectorError, info: vi.fn(), warn: vi.fn() },
  requestContext: { getStore: vi.fn(() => undefined) },
  dbLogger: { error: loggerMocks.dbError, info: vi.fn(), warn: vi.fn() },
  connectorLogger: {
    error: loggerMocks.connectorError,
    info: loggerMocks.connectorInfo,
    warn: loggerMocks.connectorWarn,
  },
}));

describe('task move orchestration characterization', () => {
  const dbPath = join(process.cwd(), 'data', `task-move-characterization-${process.pid}-${Date.now()}.db`);
  const originalDbPath = process.env.MC_DB_PATH;
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;
  let executeMove: typeof import('@/app/api/tasks/move/execute/route').POST;
  let legacyMove: typeof import('@/app/api/tasks/[id]/move/route').POST;

  beforeAll(async () => {
    process.env.MC_DB_PATH = dbPath;
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();

    const [dbModule, executeRoute, legacyRoute] = await Promise.all([
      import('@/db'),
      import('@/app/api/tasks/move/execute/route'),
      import('@/app/api/tasks/[id]/move/route'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    executeMove = executeRoute.POST;
    legacyMove = legacyRoute.POST;

    const now = '2026-08-14T12:00:00.000Z';
    await db.insert(schema.connectorConfigs).values({
      id: 'target-connector',
      type: 'microsoft-todo',
      name: 'Target',
      capabilities: { read: true, write: true, taskCreate: true },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.sourceLists).values({
      id: 'target-list-row',
      connectorInstanceId: 'target-connector',
      sourceId: 'target-list',
      name: 'Target list',
      type: 'list',
    });
  });

  beforeEach(() => {
    connectorMocks.target.createTask.mockReset();
    connectorMocks.target.deleteTask.mockReset();
    connectorMocks.source.deleteTask.mockReset();
    connectorMocks.sourceCloseOnly.completeTask.mockReset();
    connectorMocks.sourceCloseOnly.addComment.mockReset();
    loggerMocks.dbError.mockReset();
    loggerMocks.connectorError.mockReset();
    loggerMocks.connectorInfo.mockReset();
    loggerMocks.connectorWarn.mockReset();
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

  it('rolls back every legacy local change and surfaces a generic error when persistence fails', async () => {
    const taskId = 'legacy-rollback-source';
    await insertTask(taskId);
    await db.insert(schema.myDayItems).values({
      id: 'legacy-rollback-my-day',
      taskId,
      date: '2026-08-14',
      addedAt: '2026-08-14T12:00:00.000Z',
    });
    sqlite.exec(`
      CREATE TEMP TRIGGER fail_legacy_move
      BEFORE INSERT ON tasks
      WHEN NEW.sync_status = 'pending_push'
      BEGIN
        SELECT RAISE(ABORT, 'forced legacy move failure');
      END;
    `);

    try {
      const response = await legacyMove(legacyRequest(taskId), {
        params: Promise.resolve({ id: taskId }),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual(expect.objectContaining({
        error: 'Failed to move task',
      }));
      expect(queryCount('tasks', 'id', taskId)).toBe(1);
      expect(queryCount('my_day_items', 'task_id', taskId)).toBe(1);
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS count FROM tasks WHERE sync_status = 'pending_push' AND title = ?",
      ).get(`Task ${taskId}`)).toEqual({ count: 0 });
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS fail_legacy_move');
    }
  });

  it('compensates a created destination and preserves source state when local persistence fails', async () => {
    const taskId = 'execute-compensation-source';
    await insertTask(taskId);
    await db.insert(schema.focusItems).values({
      id: 'execute-compensation-focus',
      taskId,
      scope: 'today',
      date: '2026-08-14',
      slot: 1,
      addedAt: '2026-08-14T12:00:00.000Z',
    });
    await insertTask('execute-collision', {
      sourceId: 'remote:collision',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'target-connector',
    });
    connectorMocks.target.createTask.mockResolvedValue({
      sourceId: 'remote:collision',
      title: 'Collision',
    });
    connectorMocks.target.deleteTask.mockResolvedValue(undefined);

    const response = await executeMove(executeRequest(taskId));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: 'Failed to execute task move',
    }));
    expect(connectorMocks.target.deleteTask).toHaveBeenCalledWith('remote:collision');
    expect(queryCount('tasks', 'id', taskId)).toBe(1);
    expect(queryCount('focus_items', 'task_id', taskId)).toBe(1);
    expect(queryCount('tasks', 'source_id', 'remote:collision')).toBe(1);
  });

  it('compensates remote and local destination state when reference finalization fails', async () => {
    const taskId = 'execute-reference-compensation-source';
    await insertTask(taskId);
    await db.insert(schema.notifications).values({
      id: 'execute-reference-compensation-notification',
      sourceId: 'execute-reference-compensation-notification-source',
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Reference failure',
      receivedAt: '2026-08-14T12:00:00.000Z',
      sortAt: '2026-08-14T12:00:00.000Z',
      relatedTaskId: taskId,
    });
    connectorMocks.target.createTask.mockResolvedValue({
      sourceId: 'remote:reference-compensation',
      title: 'Successor',
    });
    connectorMocks.target.deleteTask.mockResolvedValue(undefined);
    sqlite.exec(`
      CREATE TEMP TRIGGER fail_move_reference_finalization
      BEFORE UPDATE OF related_task_id ON notifications
      WHEN OLD.related_task_id = '${taskId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced move reference failure');
      END;
    `);

    try {
      const response = await executeMove(executeRequest(taskId));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual(expect.objectContaining({
        error: 'Failed to execute task move',
      }));
      expect(connectorMocks.target.deleteTask).toHaveBeenCalledWith(
        'remote:reference-compensation',
      );
      expect(queryCount('tasks', 'id', taskId)).toBe(1);
      expect(queryCount('notifications', 'related_task_id', taskId)).toBe(1);
      expect(queryCount('tasks', 'source_id', 'remote:reference-compensation')).toBe(0);
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS fail_move_reference_finalization');
    }
  });

  it('rejects and compensates when attachments change after the move snapshot', async () => {
    const taskId = 'execute-attachment-race-source';
    await insertTask(taskId);
    connectorMocks.target.createTask.mockImplementation(async () => {
      await db.insert(schema.taskAttachments).values({
        id: 'execute-late-attachment',
        taskId,
        name: 'late.txt',
        contentType: 'text/plain',
        size: 4,
        contentBase64: Buffer.from('late').toString('base64'),
        createdAt: '2026-08-14T12:00:00.000Z',
      });
      return {
        sourceId: 'remote:attachment-race-successor',
        title: 'Successor',
      };
    });
    connectorMocks.target.deleteTask.mockResolvedValue(undefined);

    const response = await executeMove(executeRequest(taskId));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      code: 'TASK_MOVE_SOURCE_CHANGED',
    }));
    expect(connectorMocks.target.deleteTask).toHaveBeenCalledWith(
      'remote:attachment-race-successor',
    );
    expect(queryCount('tasks', 'id', taskId)).toBe(1);
    expect(queryCount('task_attachments', 'task_id', taskId)).toBe(1);
    expect(queryCount('tasks', 'source_id', 'remote:attachment-race-successor')).toBe(0);
  });

  it('surfaces compensation failure without mutating source state or reporting success', async () => {
    const taskId = 'execute-compensation-failure-source';
    await insertTask(taskId);
    await insertTask('execute-compensation-failure-collision', {
      sourceId: 'remote:compensation-failure',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'target-connector',
    });
    connectorMocks.target.createTask.mockResolvedValue({
      sourceId: 'remote:compensation-failure',
      title: 'Collision',
    });
    connectorMocks.target.deleteTask.mockRejectedValue(new Error('cleanup failed'));

    const response = await executeMove(executeRequest(taskId));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: 'Failed to execute task move',
    }));
    expect(queryCount('tasks', 'id', taskId)).toBe(1);
    expect(loggerMocks.connectorError).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'compensation',
        compensationStatus: 'failure',
      }),
      'Task move compensation failed',
    );
    expect(loggerMocks.connectorError).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: 'internal_error_compensation_failed' }),
      'Task move failed',
    );
  });

  it('commits the destination and surfaces cleanup state when source disposal fails', async () => {
    const taskId = 'execute-source-cleanup-failure';
    await insertTask(taskId, {
      sourceId: 'remote:source-cleanup-failure',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'source-connector',
      sourceListId: 'source-list',
    });
    await db.insert(schema.myDayItems).values({
      id: 'execute-source-cleanup-my-day',
      taskId,
      date: '2026-08-14',
      addedAt: '2026-08-14T12:00:00.000Z',
    });
    connectorMocks.target.createTask.mockResolvedValue({
      sourceId: 'remote:cleanup-successor',
      title: 'Successor',
    });
    connectorMocks.source.deleteTask.mockRejectedValue(new Error('source unavailable'));

    const response = await executeMove(executeRequest(taskId));
    const body = await response.json() as { newTaskId: string; warnings: string[] };

    expect(response.status).toBe(201);
    expect(body.warnings).toContain(
      'Source task could not be deleted. It has been marked for cleanup on next sync.',
    );
    expect(sqlite.prepare(
      'SELECT status, sync_status AS syncStatus FROM tasks WHERE id = ?',
    ).get(taskId)).toEqual({ status: 'cancelled', syncStatus: 'pending_push' });
    expect(queryCount('my_day_items', 'task_id', taskId)).toBe(0);
    expect(queryCount('my_day_items', 'task_id', body.newTaskId)).toBe(1);
  });

  it('keeps close-only cleanup failures pending for retry', async () => {
    const taskId = 'execute-source-close-failure';
    await insertTask(taskId, {
      sourceId: 'remote:source-close-failure',
      connectorType: 'github-issues',
      connectorInstanceId: 'source-close-only',
      sourceListId: 'source-list',
    });
    connectorMocks.target.createTask.mockResolvedValue({
      sourceId: 'remote:close-successor',
      title: 'Successor',
    });
    connectorMocks.sourceCloseOnly.completeTask.mockRejectedValue(
      new Error('close unavailable'),
    );

    const response = await executeMove(executeRequest(taskId));
    const body = await response.json() as { warnings: string[] };
    const tombstone = sqlite.prepare(
      'SELECT status, sync_status AS syncStatus, metadata FROM tasks WHERE id = ?',
    ).get(taskId) as { status: string; syncStatus: string; metadata: string };

    expect(response.status).toBe(201);
    expect(body.warnings).toContain(
      'Source task could not be closed automatically. It has been marked for cleanup on next sync.',
    );
    expect(tombstone.status).toBe('done');
    expect(tombstone.syncStatus).toBe('pending_push');
    const decodedMetadata = JSON.parse(tombstone.metadata) as string | Record<string, unknown>;
    const metadata = typeof decodedMetadata === 'string'
      ? JSON.parse(decodedMetadata) as Record<string, unknown>
      : decodedMetadata;
    expect(metadata).toEqual(expect.objectContaining({
      pendingCleanup: true,
    }));
  });

  it('prevents duplicate successors when a successful modern move is replayed', async () => {
    const taskId = 'execute-idempotent-source';
    await insertTask(taskId);
    connectorMocks.target.createTask.mockResolvedValue({
      sourceId: 'remote:idempotent-successor',
      title: 'Successor',
    });

    const first = await executeMove(executeRequest(taskId));
    const second = await executeMove(executeRequest(taskId));

    expect(first.status).toBe(201);
    expect(second.status).toBe(404);
    expect(connectorMocks.target.createTask).toHaveBeenCalledTimes(1);
    expect(queryCount('tasks', 'source_id', 'remote:idempotent-successor')).toBe(1);
  });

  it('serializes concurrent modern moves before destination creation', async () => {
    const taskId = 'execute-concurrent-source';
    await insertTask(taskId);
    connectorMocks.target.createTask.mockResolvedValue({
      sourceId: 'remote:concurrent-successor',
      title: 'Successor',
    });

    const responses = await Promise.all([
      executeMove(executeRequest(taskId)),
      executeMove(executeRequest(taskId)),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(connectorMocks.target.createTask).toHaveBeenCalledTimes(1);
    expect(queryCount('tasks', 'source_id', 'remote:concurrent-successor')).toBe(1);
  });

  it('prevents duplicate successors when a remote-source tombstone is replayed', async () => {
    const taskId = 'execute-remote-idempotent-source';
    await insertTask(taskId, {
      sourceId: 'remote:source-idempotent',
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'source-connector',
      sourceListId: 'source-list',
    });
    connectorMocks.target.createTask.mockResolvedValue({
      sourceId: 'remote:remote-idempotent-successor',
      title: 'Successor',
    });
    connectorMocks.source.deleteTask.mockResolvedValue(undefined);

    const first = await executeMove(executeRequest(taskId));
    const second = await executeMove(executeRequest(taskId));

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual(expect.objectContaining({
      code: 'TASK_ALREADY_MOVED',
    }));
    expect(connectorMocks.target.createTask).toHaveBeenCalledTimes(1);
    expect(connectorMocks.source.deleteTask).toHaveBeenCalledTimes(1);
    expect(queryCount('tasks', 'source_id', 'remote:remote-idempotent-successor')).toBe(1);
  });

  it('prevents duplicate successors when a successful legacy move is replayed', async () => {
    const taskId = 'legacy-idempotent-source';
    await insertTask(taskId);

    const first = await legacyMove(legacyRequest(taskId), {
      params: Promise.resolve({ id: taskId }),
    });
    const second = await legacyMove(legacyRequest(taskId), {
      params: Promise.resolve({ id: taskId }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE connector_instance_id = 'target-connector' AND title = ?",
    ).get(`Task ${taskId}`)).toEqual({ count: 1 });
  });

  it('serializes concurrent pending-sync moves at local commit', async () => {
    const taskId = 'legacy-concurrent-source';
    await insertTask(taskId);

    const responses = await Promise.all([
      legacyMove(legacyRequest(taskId), { params: Promise.resolve({ id: taskId }) }),
      legacyMove(legacyRequest(taskId), { params: Promise.resolve({ id: taskId }) }),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 404]);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE connector_instance_id = 'target-connector' AND title = ?",
    ).get(`Task ${taskId}`)).toEqual({ count: 1 });
  });

  it('rebuilds materialized attachments for a pending-sync successor', async () => {
    const taskId = 'legacy-attachment-source';
    await insertTask(taskId);
    await db.insert(schema.taskAttachments).values({
      id: 'legacy-attachment',
      taskId,
      name: 'evidence.txt',
      contentType: 'text/plain',
      size: 3,
      contentBase64: Buffer.from('abc').toString('base64'),
      sourceAttachmentId: 'source-attachment',
      createdAt: '2026-08-14T12:00:00.000Z',
    });

    const response = await legacyMove(legacyRequest(taskId), {
      params: Promise.resolve({ id: taskId }),
    });
    const body = await response.json() as { id: string };

    expect(response.status).toBe(200);
    expect(queryCount('task_attachments', 'task_id', taskId)).toBe(0);
    expect(sqlite.prepare(
      `SELECT name, content_base64 AS contentBase64, source_attachment_id AS sourceAttachmentId
       FROM task_attachments
       WHERE task_id = ?`,
    ).get(body.id)).toEqual({
      name: 'evidence.txt',
      contentBase64: Buffer.from('abc').toString('base64'),
      sourceAttachmentId: null,
    });
  });

  it('rejects over-budget pending-sync attachments before mutation', async () => {
    const taskId = 'legacy-attachment-budget-source';
    await insertTask(taskId);
    await db.insert(schema.taskAttachments).values({
      id: 'legacy-attachment-over-budget',
      taskId,
      name: 'oversized.bin',
      contentType: 'application/octet-stream',
      size: 10 * 1024 * 1024 + 1,
      contentBase64: 'AA==',
      createdAt: '2026-08-14T12:00:00.000Z',
    });

    const response = await legacyMove(legacyRequest(taskId), {
      params: Promise.resolve({ id: taskId }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(expect.objectContaining({
      code: 'TASK_MOVE_BUDGET_EXCEEDED',
    }));
    expect(queryCount('tasks', 'id', taskId)).toBe(1);
    expect(queryCount('task_attachments', 'task_id', taskId)).toBe(1);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE sync_status = 'pending_push' AND title = ?",
    ).get(`Task ${taskId}`)).toEqual({ count: 0 });
  });

  it('rejects unreadable pending-sync attachments without orphaning them', async () => {
    const taskId = 'legacy-unreadable-attachment-source';
    await insertTask(taskId);
    await db.insert(schema.taskAttachments).values({
      id: 'legacy-unreadable-attachment',
      taskId,
      name: 'remote-only.bin',
      contentType: 'application/octet-stream',
      size: 2,
      contentBase64: null,
      sourceAttachmentId: 'remote-attachment',
      createdAt: '2026-08-14T12:00:00.000Z',
    });

    const response = await legacyMove(legacyRequest(taskId), {
      params: Promise.resolve({ id: taskId }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expect.objectContaining({
      code: 'ATTACHMENT_CONTENT_UNAVAILABLE',
    }));
    expect(queryCount('tasks', 'id', taskId)).toBe(1);
    expect(queryCount('task_attachments', 'task_id', taskId)).toBe(1);
  });

  it.each([
    { route: 'write-through' as const, expectedStatus: 201 },
    { route: 'pending-sync' as const, expectedStatus: 200 },
  ])('repoints active notification, Scout, and linked-source references through $route', async ({
    route,
    expectedStatus,
  }) => {
    const taskId = `${route}-reference-source`;
    await insertTask(taskId);
    const { projectId, hierarchyRevision } = await insertActiveReferences(taskId, route);

    let response: Response;
    if (route === 'write-through') {
      connectorMocks.target.createTask.mockResolvedValue({
        sourceId: `remote:${route}-reference-successor`,
        title: 'Successor',
      });
      response = await executeMove(executeRequest(taskId));
    } else {
      response = await legacyMove(legacyRequest(taskId), {
        params: Promise.resolve({ id: taskId }),
      });
    }
    const body = await response.json() as { id?: string; newTaskId?: string };
    const successorTaskId = body.newTaskId ?? body.id;

    expect(response.status).toBe(expectedStatus);
    expect(successorTaskId).toEqual(expect.any(String));
    for (const [table, column] of [
      ['notifications', 'related_task_id'],
      ['task_linked_sources', 'task_id'],
      ['scout_reconciliation_suggestions', 'task_id'],
      ['scout_reconciliation_task_state', 'task_id'],
    ]) {
      expect(queryCount(table, column, taskId), `${table}.${column} source count`).toBe(0);
      expect(
        queryCount(table, column, successorTaskId!),
        `${table}.${column} successor count`,
      ).toBe(1);
    }
    expect(queryCount('task_projects', 'task_id', taskId)).toBe(0);
    expect(queryCount('task_projects', 'task_id', successorTaskId!)).toBe(1);
    expect(sqlite.prepare(
      'SELECT task_id AS taskId, sort_order AS sortOrder FROM project_phase_items WHERE id = ?',
    ).get(`${route}-reference-phase-item`)).toEqual({
      taskId: successorTaskId,
      sortOrder: 17,
    });
    expect(sqlite.prepare(
      'SELECT hierarchy_revision AS hierarchyRevision FROM hub_projects WHERE id = ?',
    ).get(projectId)).toEqual({ hierarchyRevision });
  });

  async function insertActiveReferences(taskId: string, prefix: string) {
    const now = '2026-08-14T12:00:00.000Z';
    const runId = `${prefix}-reference-run`;
    const evaluationId = `${prefix}-reference-evaluation`;
    const projectId = `${prefix}-reference-project`;
    await db.insert(schema.hubProjects).values({
      id: projectId,
      name: 'Reference project',
      hierarchyRevision: 4,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.taskProjects).values({ taskId, projectId });
    await db.insert(schema.projectPhases).values({
      id: `${prefix}-reference-phase`,
      projectId,
      name: 'Reference phase',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.projectPhaseItems).values({
      id: `${prefix}-reference-phase-item`,
      phaseId: `${prefix}-reference-phase`,
      taskId,
      sortOrder: 17,
      createdAt: now,
    });
    await db.insert(schema.notifications).values({
      id: `${prefix}-reference-notification`,
      sourceId: `${prefix}-reference-notification-source`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: 'Reference notification',
      receivedAt: now,
      sortAt: now,
      relatedTaskId: taskId,
    });
    await db.insert(schema.taskLinkedSources).values({
      id: `${prefix}-reference-linked-source`,
      taskId,
      connectorType: 'github-issues',
      connectorInstanceId: 'github',
      sourceId: `${prefix}-linked-source`,
      title: 'Linked source',
      linkedAt: now,
    });
    await db.insert(schema.scoutReconciliationRuns).values({
      id: runId,
      scopeKey: `task:${taskId}`,
      scopeType: 'task',
      scopeId: taskId,
      lookbackHours: 24,
      source: 'api',
      sourceIdentity: 'test',
      idempotencyKey: `${prefix}-reference-key`,
      requestHash: `${prefix}-reference-request`,
      leaseToken: `${prefix}-reference-lease`,
      status: 'completed',
      startedAt: now,
      completedAt: now,
    });
    await db.insert(schema.scoutReconciliationEvaluations).values({
      id: evaluationId,
      runId,
      taskId,
      candidateAction: 'suggest-complete',
      action: 'suggest-complete',
      confidence: 0.8,
      evidenceHash: `${prefix}-reference-evidence`,
      evidence: [],
      policyDecision: 'require-confirmation',
      policyReason: 'test',
      payloadHash: `${prefix}-reference-payload`,
      createdAt: now,
    });
    await db.insert(schema.scoutReconciliationSuggestions).values({
      id: `${prefix}-reference-suggestion`,
      taskId,
      runId,
      evaluationId,
      action: 'suggest-complete',
      status: 'pending',
      confidence: 0.8,
      evidenceHash: `${prefix}-reference-evidence`,
      evidence: [],
      policyDecision: 'require-confirmation',
      policyReason: 'test',
      payloadHash: `${prefix}-reference-payload`,
      proposedEffect: {},
      createdAt: now,
      updatedAt: now,
      expiresAt: '2026-08-15T12:00:00.000Z',
    });
    await db.insert(schema.scoutReconciliationTaskState).values({
      taskId,
      neverAutoComplete: true,
      reason: 'test',
      updatedAt: now,
      updatedBy: 'test',
    });
    const { hierarchyRevision } = sqlite.prepare(
      'SELECT hierarchy_revision AS hierarchyRevision FROM hub_projects WHERE id = ?',
    ).get(projectId) as { hierarchyRevision: number };
    return { projectId, hierarchyRevision };
  }

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
      title: `Task ${id}`,
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
      ...overrides,
    });
  }

  function queryCount(table: string, column: string, value: string): number {
    const row = sqlite.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
    ).get(value) as { count: number };
    return row.count;
  }
});

function executeRequest(taskId: string): Request {
  return new Request('http://localhost/api/tasks/move/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskId,
      targetConnectorInstanceId: 'target-connector',
      targetSourceListId: 'target-list',
      sourceAction: 'move',
    }),
  });
}

function legacyRequest(taskId: string): Request {
  return new Request(`http://localhost/api/tasks/${taskId}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetConnectorInstanceId: 'target-connector',
      targetListId: 'target-list',
    }),
  });
}
