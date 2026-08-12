import { beforeAll, describe, expect, it, vi } from 'vitest';

const { createTask } = vi.hoisted(() => ({
  createTask: vi.fn(),
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: vi.fn((id: string) => id === 'target-connector'
      ? { createTask }
      : undefined),
  },
}));

vi.mock('@/lib/logger', () => ({
  dbLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  connectorLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

describe('task move relationship persistence', () => {
  beforeAll(() => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
  });

  it('repoints both dependency endpoints on move and leaves them unchanged on copy', async () => {
    const [{ POST }, { default: db }, schema, { eq, or }] = await Promise.all([
      import('@/app/api/tasks/move/execute/route'),
      import('@/db'),
      import('@/db/schema'),
      import('drizzle-orm'),
    ]);
    const { connectorConfigs, sourceLists, taskDependencies, tasks } = schema;
    const now = '2026-08-06T12:00:00.000Z';

    await db.insert(connectorConfigs).values({
      id: 'target-connector',
      type: 'microsoft-todo',
      name: 'Microsoft To Do',
      capabilities: { read: true, write: true, taskCreate: true },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sourceLists).values({
      id: 'target-list-row',
      connectorInstanceId: 'target-connector',
      sourceId: 'target-list',
      name: 'Tasks',
      type: 'list',
    });
    await db.insert(tasks).values([
      {
        id: 'upstream',
        sourceId: 'local:upstream',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Upstream',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'move-source',
        sourceId: 'local:move-source',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Move source',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'downstream',
        sourceId: 'local:downstream',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Downstream',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'copy-source',
        sourceId: 'local:copy-source',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Copy source',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
    ]);
    await db.insert(taskDependencies).values([
      {
        id: 'move-incoming',
        taskId: 'move-source',
        dependsOnTaskId: 'upstream',
        type: 'blocks',
        createdAt: now,
      },
      {
        id: 'move-outgoing',
        taskId: 'downstream',
        dependsOnTaskId: 'move-source',
        type: 'blocks',
        createdAt: now,
      },
      {
        id: 'copy-relationship',
        taskId: 'copy-source',
        dependsOnTaskId: 'upstream',
        type: 'blocks',
        createdAt: now,
      },
    ]);

    createTask
      .mockResolvedValueOnce({ sourceId: 'remote:moved', title: 'Move source' })
      .mockResolvedValueOnce({ sourceId: 'remote:copied', title: 'Copy source' });

    const moveResponse = await POST(createRequest('move-source', 'move'));
    expect(moveResponse.status).toBe(201);
    const movedTaskId = (await moveResponse.json()).newTaskId as string;

    expect(await db.select().from(taskDependencies).where(eq(taskDependencies.id, 'move-incoming')))
      .toEqual([expect.objectContaining({
        taskId: movedTaskId,
        dependsOnTaskId: 'upstream',
      })]);
    expect(await db.select().from(taskDependencies).where(eq(taskDependencies.id, 'move-outgoing')))
      .toEqual([expect.objectContaining({
        taskId: 'downstream',
        dependsOnTaskId: movedTaskId,
      })]);
    expect(await db.select().from(taskDependencies).where(
      or(
        eq(taskDependencies.taskId, 'move-source'),
        eq(taskDependencies.dependsOnTaskId, 'move-source'),
      ),
    )).toHaveLength(0);

    const copyResponse = await POST(createRequest('copy-source', 'copy'));
    expect(copyResponse.status).toBe(201);
    const copiedTaskId = (await copyResponse.json()).newTaskId as string;

    expect(await db.select().from(taskDependencies).where(eq(taskDependencies.id, 'copy-relationship')))
      .toEqual([expect.objectContaining({
        taskId: 'copy-source',
        dependsOnTaskId: 'upstream',
      })]);
    expect(await db.select().from(taskDependencies).where(
      or(
        eq(taskDependencies.taskId, copiedTaskId),
        eq(taskDependencies.dependsOnTaskId, copiedTaskId),
      ),
    )).toHaveLength(0);
  });
});

function createRequest(taskId: string, sourceAction: 'move' | 'copy') {
  return new Request('http://localhost/api/tasks/move/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskId,
      targetConnectorInstanceId: 'target-connector',
      targetSourceListId: 'target-list',
      sourceAction,
    }),
  });
}
