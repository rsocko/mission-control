import { beforeAll, describe, expect, it, vi } from 'vitest';

describe('local task dependency deletion', () => {
  beforeAll(() => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
  });

  it('does not infer connector provenance from the linked tasks', async () => {
    const [{ default: db }, schema, manager, { eq }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/sync/task-dependency-manager'),
      import('drizzle-orm'),
    ]);
    const now = '2026-07-29T00:00:00.000Z';
    const taskRows = ['blocker', 'blocked'].map((id) => ({
      id,
      sourceId: `source-${id}`,
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'microsoft-1',
      title: id,
      isChecklistItem: false,
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    }));
    await db.insert(schema.tasks).values(taskRows);
    await db.insert(schema.taskDependencies).values({
      id: 'local-delete',
      taskId: 'blocked',
      dependsOnTaskId: 'blocker',
      type: 'blocks',
      syncStatus: 'local',
      createdAt: now,
    });
    const [dependency] = await db.select().from(schema.taskDependencies).where(
      eq(schema.taskDependencies.id, 'local-delete'),
    );

    expect(await manager.removeTaskDependencyFromSource(
      dependency,
      taskRows[0],
      taskRows[1],
    )).toEqual({ deleted: true });
    expect(await db.select().from(schema.taskDependencies).where(
      eq(schema.taskDependencies.id, 'local-delete'),
    )).toHaveLength(0);
  });
});
