import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

describe('Work To Do bridge runtime', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let service: typeof import('@/lib/connectors/work-todo/service');

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
    const [dbModule, schemaModule, serviceModule] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/db/schema'),
      import('@/lib/connectors/work-todo/service'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    service = serviceModule;
  });

  beforeEach(async () => {
    await db.delete(schema.workTodoOutboundChanges);
    await db.delete(schema.workTodoListDeltaState);
    await db.delete(schema.workTodoBridgeState);
    await db.delete(schema.projectAutoIncludeExclusions);
    await db.delete(schema.taskTags);
    await db.delete(schema.tags);
    await db.delete(schema.tasks);
    await db.delete(schema.sourceLists);
    await db.delete(schema.connectorConfigs);

    const now = '2026-08-07T18:00:00.000Z';
    await db.insert(schema.connectorConfigs).values({
      id: 'work-todo',
      type: 'microsoft-todo-work',
      name: 'Microsoft To Do - Work',
      enabled: true,
      syncMode: 'manual',
      capabilities: {
        read: true,
        write: true,
        delete: false,
        sync: true,
        subtasks: false,
        lists: true,
        tags: true,
        tagWriteBack: false,
      },
      credentials: {},
      settings: {
        transport: 'power-automate-standard',
        capabilityProfile: 'standard-v1',
      },
      syncedLists: [],
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.workTodoBridgeState).values({
      connectorId: 'work-todo',
      transport: 'power-automate-standard',
      capabilityProfile: 'standard-v1',
      resetRequired: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  function snapshot(title = 'Review report #work') {
    return {
      schemaVersion: '1.0' as const,
      connectorInstanceId: 'work-todo',
      syncTimestamp: '2026-08-07T18:05:00.000Z',
      isFullSnapshot: true as const,
      lists: [{
        id: 'list-1',
        displayName: 'Tasks',
        tasks: [{
          id: 'task-1',
          title,
          status: 'notStarted' as const,
          importance: 'high' as const,
          body: { content: 'Prepare the report', contentType: 'text' as const },
          createdDateTime: '2026-08-07T17:00:00.000Z',
          lastModifiedDateTime: '2026-08-07T18:00:00.000Z',
          completedDateTime: null,
          dueDateTime: { dateTime: '2026-08-10T00:00:00', timeZone: 'UTC' },
          isReminderOn: false,
          reminderDateTime: null,
        }],
      }],
    };
  }

  it('ingests lists and tasks under the Work connector identity', async () => {
    const result = await service.ingestWorkTodo(snapshot());
    const [task] = await db.select().from(schema.tasks);
    const [list] = await db.select().from(schema.sourceLists);
    const taskTags = await db.select().from(schema.taskTags);

    expect(result).toMatchObject({ created: 1, mode: 'snapshot' });
    expect(task).toMatchObject({
      connectorType: 'microsoft-todo-work',
      connectorInstanceId: 'work-todo',
      sourceId: 'list-1:task-1',
      sourceListId: 'list-1',
      priority: 'high',
      dueDate: '2026-08-10',
    });
    expect(list).toMatchObject({ sourceId: 'list-1', name: 'Tasks' });
    expect(taskTags).toHaveLength(1);
  });

  it('protects a local edit, leases it idempotently, and settles its acknowledgement', async () => {
    await service.ingestWorkTodo(snapshot());
    const [task] = await db.select().from(schema.tasks);
    await db.update(schema.tasks).set({
      title: 'Local revised title',
      syncStatus: 'pending_push',
      updatedAt: '2026-08-07T18:10:00.000Z',
      metadata: {
        ...(task.metadata as Record<string, unknown>),
        workTodoDirtyFields: ['title'],
      },
    });

    await service.ingestWorkTodo(snapshot('Stale remote title'));
    const [protectedTask] = await db.select().from(schema.tasks);
    expect(protectedTask.title).toBe('Local revised title');
    expect(protectedTask.syncStatus).toBe('pending_push');

    const firstLease = await service.leaseWorkTodoChanges({
      connectorInstanceId: 'work-todo',
    });
    const retryLease = await service.leaseWorkTodoChanges({
      connectorInstanceId: 'work-todo',
    });
    expect(firstLease.changes).toHaveLength(1);
    expect(retryLease.changes[0].idempotencyKey)
      .toBe(firstLease.changes[0].idempotencyKey);
    expect(firstLease.changes[0]).toMatchObject({
      sourceId: 'list-1:task-1',
      listId: 'list-1',
      taskId: 'task-1',
      operation: 'update',
      fields: { title: 'Local revised title' },
    });

    const acknowledgement = await service.acknowledgeWorkTodoChanges({
      connectorInstanceId: 'work-todo',
      leaseId: firstLease.leaseId,
      processedAt: '2026-08-07T18:12:00.000Z',
      results: [{
        idempotencyKey: firstLease.changes[0].idempotencyKey,
        sourceId: firstLease.changes[0].sourceId,
        status: 'succeeded',
      }],
    });
    const [settledTask] = await db.select().from(schema.tasks);
    expect(acknowledgement).toMatchObject({ succeeded: 1, stale: 0 });
    expect(settledTask.id).toBe(task.id);
    expect(settledTask.syncStatus).toBe('synced');
  });

  it('fails safely when a standard list reaches the ambiguous connector limit', async () => {
    const task = snapshot().lists[0].tasks[0];
    const payload = snapshot();
    payload.lists[0].tasks = Array.from({ length: 999 }, (_, index) => ({
      ...task,
      id: `task-${index}`,
    }));

    await expect(service.ingestWorkTodo(payload)).rejects.toMatchObject({
      code: 'SNAPSHOT_MAY_BE_TRUNCATED',
      status: 409,
    });
    expect(await db.select().from(schema.tasks)).toEqual([]);
  });

  it('removes stale lists when an authoritative snapshot becomes empty', async () => {
    await service.ingestWorkTodo(snapshot());
    const [task] = await db.select().from(schema.tasks);
    await db.insert(schema.projectAutoIncludeExclusions).values({
      projectId: 'project-1',
      taskId: task.id,
      excludedAt: '2026-08-07T18:30:00.000Z',
    });

    await service.ingestWorkTodo({
      ...snapshot(),
      syncTimestamp: '2026-08-07T19:00:00.000Z',
      lists: [],
    });

    expect(await db.select().from(schema.tasks)).toEqual([]);
    expect(await db.select().from(schema.projectAutoIncludeExclusions)).toEqual([]);
    expect(await db.select().from(schema.sourceLists)).toEqual([]);
  });

  it('keeps completion and simultaneous field edits in one update', async () => {
    await service.ingestWorkTodo(snapshot());
    const [task] = await db.select().from(schema.tasks);
    await db.update(schema.tasks).set({
      title: 'Finish revised task',
      status: 'done',
      syncStatus: 'pending_push',
      updatedAt: '2026-08-07T18:20:00.000Z',
      metadata: {
        ...(task.metadata as Record<string, unknown>),
        workTodoDirtyFields: ['title', 'status'],
      },
    });

    const lease = await service.leaseWorkTodoChanges({
      connectorInstanceId: 'work-todo',
    });

    expect(lease.changes).toEqual([
      expect.objectContaining({
        operation: 'update',
        fields: {
          title: 'Finish revised task',
          status: 'completed',
        },
      }),
    ]);
  });

  it('does not let a delayed failure regress a newer local edit', async () => {
    await service.ingestWorkTodo(snapshot());
    const [task] = await db.select().from(schema.tasks);
    await db.update(schema.tasks).set({
      title: 'First local edit',
      syncStatus: 'pending_push',
      updatedAt: '2026-08-07T18:20:00.000Z',
      metadata: {
        ...(task.metadata as Record<string, unknown>),
        workTodoDirtyFields: ['title'],
      },
    });
    const lease = await service.leaseWorkTodoChanges({ connectorInstanceId: 'work-todo' });
    await db.update(schema.tasks).set({
      title: 'Newer local edit',
      syncStatus: 'pending_push',
      updatedAt: '2026-08-07T18:21:00.000Z',
    });

    const result = await service.acknowledgeWorkTodoChanges({
      connectorInstanceId: 'work-todo',
      leaseId: lease.leaseId,
      processedAt: '2026-08-07T18:22:00.000Z',
      results: [{
        idempotencyKey: lease.changes[0].idempotencyKey,
        sourceId: lease.changes[0].sourceId,
        status: 'failed',
        errorCode: 'REMOTE_CONFLICT',
      }],
    });
    const [currentTask] = await db.select().from(schema.tasks);
    const [oldChange] = await db.select().from(schema.workTodoOutboundChanges);

    expect(result.stale).toBe(1);
    expect(currentTask).toMatchObject({
      title: 'Newer local edit',
      syncStatus: 'pending_push',
    });
    expect(oldChange.status).toBe('superseded');
  });

  it('returns opaque extended checkpoints only in the pull envelope', async () => {
    await db.update(schema.workTodoBridgeState).set({
      transport: 'power-automate-graph',
      capabilityProfile: 'extended-v1',
      listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=secret',
    });
    await db.insert(schema.workTodoListDeltaState).values({
      connectorId: 'work-todo',
      listSourceId: 'list-1',
      deltaLink: 'https://graph.example/tasks/delta?$deltatoken=task-secret',
      updatedAt: '2026-08-07T18:00:00.000Z',
    });

    const pullRequest = await service.createWorkTodoPullRequest('work-todo');
    const status = await service.getWorkTodoBridgeStatus('work-todo');

    expect(pullRequest).toMatchObject({
      schemaVersion: '1.1',
      listDeltaLink: expect.stringContaining('secret'),
      taskDeltaLinks: {
        'list-1': expect.stringContaining('task-secret'),
      },
    });
    expect(status).not.toHaveProperty('listDeltaLink');
    expect(status).not.toHaveProperty('taskDeltaLinks');
    expect(JSON.stringify(status)).not.toContain('task-secret');
  });
});
