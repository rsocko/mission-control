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
  return {
    target,
    source,
    getConnector: vi.fn((id: string) => {
      if (id === 'target-connector') return target;
      if (id === 'source-connector') return source;
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
