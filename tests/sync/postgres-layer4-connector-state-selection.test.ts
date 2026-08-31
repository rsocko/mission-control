import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Layer 4 PostgreSQL reachability trap.
 *
 * Every migrated non-finance connector surface — the whole Work To Do bridge
 * plus Microsoft To Do hidden-list discovery and its authenticated-user
 * settings write — must resolve through the registered worker persistence
 * composition. `@/db`'s `sqlite`/`db` exports throw on any access, so a path
 * that still reached the SQLite compatibility layer fails here instead of
 * silently working.
 */

const sqliteTouch = vi.fn();

vi.mock('@/db', () => ({
  get sqlite() {
    sqliteTouch();
    throw new Error('SQLite must not be touched while the PostgreSQL backend is selected');
  },
  get db() {
    sqliteTouch();
    throw new Error('SQLite must not be touched while the PostgreSQL backend is selected');
  },
  get default() {
    sqliteTouch();
    throw new Error('SQLite must not be touched while the PostgreSQL backend is selected');
  },
  runTransaction() {
    sqliteTouch();
    throw new Error('SQLite must not be touched while the PostgreSQL backend is selected');
  },
}));

const mocks = vi.hoisted(() => ({
  workTodo: {
    ingest: vi.fn(async () => ({
      mode: 'snapshot' as const,
      created: 1,
      updated: 0,
      removed: 1,
      protectedPending: 0,
      indexedTasks: [{
        id: 'task-1',
        title: 'Portable task',
        description: null,
        sourceListName: 'Tasks',
        connectorType: 'microsoft-todo-work',
        status: 'todo',
        priority: 'none',
        updatedAt: '2026-08-07T18:00:00.000Z',
      }],
      removedTaskIds: ['task-removed'],
    })),
    lease: vi.fn(async () => ({
      leaseId: '11111111-1111-4111-8111-111111111111',
      leaseExpiresAt: '2026-08-07T18:20:00.000Z',
      changes: [{
        idempotencyKey: 'key-1',
        sourceId: 'list-1:task-1',
        listSourceId: 'list-1',
        remoteTaskId: 'task-1',
        operation: 'update' as const,
        fields: { title: 'Portable task' },
      }],
    })),
    readPullState: vi.fn(async () => ({
      capabilityProfile: 'extended-v1' as const,
      resetRequired: false,
      listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=v1',
      selectedListIds: ['list-1'],
      taskDeltaLinks: [{
        listSourceId: 'list-1',
        deltaLink: 'https://graph.example/tasks/delta?$deltatoken=t1',
      }],
    })),
    acknowledge: vi.fn(async () => ({
      succeeded: 1,
      failed: 0,
      skipped: 0,
      stale: 0,
      removedTaskIds: ['task-removed'],
    })),
    readStatus: vi.fn(async () => ({
      enabled: true,
      initialized: true,
      transport: 'power-automate-graph' as const,
      capabilityProfile: 'extended-v1' as const,
      resetRequired: false,
      lastIngestAt: '2026-08-07T18:05:00.000Z',
      lastIngestMode: 'delta' as const,
      lastError: null,
      deltaCheckpointStored: true,
      pendingWriteBackCount: 2,
    })),
    resetDelta: vi.fn(async () => ({
      resetRequired: true as const,
      updatedAt: '2026-08-07T19:00:00.000Z',
    })),
  },
  listSourceLists: vi.fn(async () => [{
    id: 'pg-todo:hidden-list',
    connectorInstanceId: 'pg-todo',
    sourceId: 'hidden-list',
    name: 'Hidden',
    type: 'list',
    taskCount: 0,
    lastSyncedAt: null,
    wellKnownListName: null,
    groupId: null,
    sortOrder: 0,
    hidden: false,
    lastKnownRemoteName: 'Hidden',
    userDisplayName: null,
    icon: null,
    iconColor: null,
  }]),
  mergeSettings: vi.fn(async (
    _id: string,
    settings: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) => ({ ...settings, ...patch })),
  searchRepository: {
    indexTask: vi.fn(async () => undefined),
    removeTask: vi.fn(async () => undefined),
    indexNotification: vi.fn(async () => undefined),
    removeNotification: vi.fn(async () => undefined),
    warmUp: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    rebuild: vi.fn(async () => undefined),
  },
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    connectors: { mergeSettings: mocks.mergeSettings },
    syncRuns: {},
    execution: {
      lists: { list: mocks.listSourceLists },
      support: { allowsLegacyWorkflow: () => false },
    },
    github: {},
    connectorState: { workTodo: mocks.workTodo },
  }),
}));

vi.mock('@/db/runtime', () => ({
  getPostgresKeywordSearchRepository: () => mocks.searchRepository,
}));

const ORIGINAL_BACKEND = process.env.MC_DATABASE_BACKEND;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MC_DATABASE_BACKEND = 'postgres';
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_BACKEND === undefined) delete process.env.MC_DATABASE_BACKEND;
  else process.env.MC_DATABASE_BACKEND = ORIGINAL_BACKEND;
});

const SNAPSHOT = {
  schemaVersion: '1.0' as const,
  connectorInstanceId: 'pg-work-todo',
  syncTimestamp: '2026-08-07T18:05:00.000Z',
  isFullSnapshot: true as const,
  lists: [{
    id: 'list-1',
    displayName: 'Tasks',
    tasks: [{
      id: 'task-1',
      title: 'Portable task',
      status: 'notStarted' as const,
      importance: 'normal' as const,
      body: { content: 'body', contentType: 'text' as const },
      createdDateTime: '2026-08-07T17:00:00.000Z',
      lastModifiedDateTime: '2026-08-07T18:00:00.000Z',
      completedDateTime: null,
      dueDateTime: null,
      isReminderOn: false,
      reminderDateTime: null,
    }],
  }],
};

describe('Layer 4 PostgreSQL selection — Work To Do bridge service', () => {
  it('ingests through the registered composition and indexes after commit', async () => {
    const service = await import('@/lib/connectors/work-todo/service');

    const result = await service.ingestWorkTodo(SNAPSHOT);

    expect(mocks.workTodo.ingest).toHaveBeenCalledOnce();
    expect(mocks.workTodo.ingest).toHaveBeenCalledWith(expect.objectContaining({
      payload: SNAPSHOT,
      timezone: expect.any(String),
    }));
    expect(result).toMatchObject({
      connectorInstanceId: 'pg-work-todo',
      mode: 'snapshot',
      created: 1,
      removed: 1,
    });
    expect(mocks.searchRepository.indexTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
    );
    expect(mocks.searchRepository.removeTask).toHaveBeenCalledWith('task-removed');
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('leases, acknowledges, reads status, and resets without touching SQLite', async () => {
    const service = await import('@/lib/connectors/work-todo/service');

    const lease = await service.leaseWorkTodoChanges({
      connectorInstanceId: 'pg-work-todo',
      limit: 10,
    });
    expect(lease).toMatchObject({
      schemaVersion: '1.0',
      allowDelete: false,
      leaseId: '11111111-1111-4111-8111-111111111111',
    });
    expect(lease.changes[0]).toEqual({
      idempotencyKey: 'key-1',
      sourceId: 'list-1:task-1',
      listId: 'list-1',
      taskId: 'task-1',
      operation: 'update',
      fields: { title: 'Portable task' },
    });

    const acknowledgement = await service.acknowledgeWorkTodoChanges({
      connectorInstanceId: 'pg-work-todo',
      leaseId: '11111111-1111-4111-8111-111111111111',
      processedAt: '2026-08-07T18:12:00.000Z',
      results: [{
        idempotencyKey: 'key-1',
        sourceId: 'list-1:task-1',
        status: 'succeeded',
      }],
    });
    expect(acknowledgement).toMatchObject({ succeeded: 1, stale: 0 });
    expect(mocks.searchRepository.removeTask).toHaveBeenCalledWith('task-removed');

    const status = await service.getWorkTodoBridgeStatus('pg-work-todo');
    expect(status).toMatchObject({ initialized: true, pendingWriteBackCount: 2 });
    expect(JSON.stringify(status)).not.toContain('deltatoken');

    const reset = await service.resetWorkTodoDelta('pg-work-todo');
    expect(reset).toEqual({
      connectorId: 'pg-work-todo',
      resetRequired: true,
      updatedAt: '2026-08-07T19:00:00.000Z',
    });
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('builds the extended pull envelope from the portable pull state', async () => {
    const service = await import('@/lib/connectors/work-todo/service');

    const envelope = await service.createWorkTodoPullRequest('pg-work-todo');

    expect(envelope).toMatchObject({
      schemaVersion: '1.1',
      connectorInstanceId: 'pg-work-todo',
      selectedListIds: ['list-1'],
      listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=v1',
      taskDeltaLinks: {
        'list-1': 'https://graph.example/tasks/delta?$deltatoken=t1',
      },
    });
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('suppresses stored checkpoints while a reset is pending', async () => {
    mocks.workTodo.readPullState.mockResolvedValueOnce({
      capabilityProfile: 'extended-v1',
      resetRequired: true,
      listDeltaLink: 'https://graph.example/lists/delta?$deltatoken=v1',
      selectedListIds: [],
      taskDeltaLinks: [{ listSourceId: 'list-1', deltaLink: 'https://graph.example/t' }],
    });
    const service = await import('@/lib/connectors/work-todo/service');

    const envelope = await service.createWorkTodoPullRequest('pg-work-todo');

    expect(envelope).toMatchObject({
      schemaVersion: '1.1',
      listDeltaLink: null,
      taskDeltaLinks: { 'list-1': null },
    });
    expect(envelope).not.toHaveProperty('selectedListIds');
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});

describe('Layer 4 PostgreSQL selection — Microsoft To Do connector state', () => {
  const graphResponses = new Map<string, unknown>();

  function stubGraphClient() {
    vi.doMock('@/lib/connectors/microsoft-todo/graph-client', () => ({
      GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0',
      SUBSTRATE_BASE_URL: 'https://substrate.example',
      createGraphClient: () => ({
        graphFetch: async (url: string) => {
          const key = [...graphResponses.keys()]
            .sort((a, b) => b.length - a.length)
            .find((pattern) => url.startsWith(pattern));
          if (!key) return { ok: false, status: 404, statusText: 'Not Found' };
          return { ok: true, status: 200, json: async () => graphResponses.get(key) };
        },
        substrateFetch: async () => ({ ok: false, status: 404, statusText: 'Not Found' }),
      }),
    }));
  }

  beforeEach(() => {
    graphResponses.clear();
  });

  it('records the authenticated user through the portable settings patch', async () => {
    graphResponses.set('/me/todo/lists', { value: [] });
    graphResponses.set('/me', { userPrincipalName: 'worker@example.com' });
    stubGraphClient();
    const { microsoftTodoFactory } = await import('@/lib/connectors/microsoft-todo');
    const connector = microsoftTodoFactory.create();
    await connector.initialize({
      id: 'pg-todo',
      type: 'microsoft-todo',
      name: 'Microsoft To Do',
      enabled: true,
      syncMode: 'poll',
      capabilities: {
        read: true,
        write: true,
        delete: false,
        sync: true,
        subtasks: true,
        lists: true,
        tags: true,
        tagWriteBack: false,
      },
      // Inert placeholder: no real Microsoft Graph credential is used here.
      credentials: { accessToken: 'inert-test-token' },
      settings: { retained: true },
      syncedLists: [],
    });

    const result = await connector.testConnection();

    expect(result.success).toBe(true);
    expect(mocks.mergeSettings).toHaveBeenCalledWith(
      'pg-todo',
      { retained: true },
      { authenticatedUser: 'worker@example.com' },
    );
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('discovers hidden lists through the portable source-list port', async () => {
    graphResponses.set('/me/todo/lists?$top=100', { value: [] });
    graphResponses.set('/me/todo/lists/hidden-list', { displayName: 'Hidden remote name' });
    graphResponses.set('/me/todo/lists/hidden-list/tasks', {
      value: [{
        id: 'graph-task-1',
        title: 'Hidden task',
        status: 'notStarted',
        importance: 'normal',
        createdDateTime: '2026-08-07T17:00:00.000Z',
        lastModifiedDateTime: '2026-08-07T18:00:00.000Z',
      }],
    });
    stubGraphClient();
    const { microsoftTodoFactory } = await import('@/lib/connectors/microsoft-todo');
    const connector = microsoftTodoFactory.create();
    await connector.initialize({
      id: 'pg-todo',
      type: 'microsoft-todo',
      name: 'Microsoft To Do',
      enabled: true,
      syncMode: 'poll',
      capabilities: {
        read: true,
        write: true,
        delete: false,
        sync: true,
        subtasks: true,
        lists: true,
        tags: true,
        tagWriteBack: false,
      },
      credentials: { accessToken: 'inert-test-token' },
      settings: {},
      syncedLists: [],
    });

    const pages: Array<Array<{ sourceId: string; sourceListName?: string | null }>> = [];
    for await (const page of connector.fetchTasks!()) {
      pages.push(page as Array<{ sourceId: string; sourceListName?: string | null }>);
    }
    const sourceIds = new Set(pages.flat().map((task) => task.sourceId));

    expect(mocks.listSourceLists).toHaveBeenCalledWith('pg-todo');
    expect([...sourceIds]).toEqual(['hidden-list:graph-task-1']);
    expect(pages.flat()[0].sourceListName).toBe('Hidden remote name');
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});
