import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSourceList: vi.fn(),
  getSourceListRepair: vi.fn(async () => null),
  beginSourceListRepair: vi.fn(),
  checkpointSourceListRepair: vi.fn(async () => true),
  finalizeSourceListRepair: vi.fn(async () => 'completed' as const),
  getConnector: vi.fn(),
  getConnectorCapabilities: vi.fn(async () => ({ write: true })),
  isConnectorEnabled: vi.fn(async () => true),
  runWithConnectorOperationLease: vi.fn(
    async (_id: string, _type: string, work: () => Promise<unknown>) => work(),
  ),
}));

vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence: vi.fn(async () => mocks),
}));
vi.mock('@/lib/connectors/registry-runtime', () => ({
  getConnectorRegistry: vi.fn(() => ({
    getConnector: mocks.getConnector,
  })),
}));
vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: mocks.getConnectorCapabilities,
  isConnectorEnabled: mocks.isConnectorEnabled,
}));
vi.mock('@/lib/sync/connector-lock', () => ({
  ConnectorOperationBusyError: class ConnectorOperationBusyError extends Error {},
  runWithConnectorOperationLease: mocks.runWithConnectorOperationLease,
}));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn() },
}));

const sourceList = {
  id: 'list-1',
  connectorInstanceId: 'todo-1',
  sourceId: 'remote-list-1',
  name: '😀 Tasks',
  type: 'list',
  taskCount: 0,
  lastSyncedAt: null,
  wellKnownListName: null,
  groupId: null,
  sortOrder: 0,
  hidden: false,
  lastKnownRemoteName: '😀 Tasks',
  userDisplayName: '😀 My tasks',
  icon: null,
  iconColor: null,
};

function repair(overrides: Record<string, unknown> = {}) {
  return {
    id: 'repair-1',
    createdAt: '2026-09-04T00:00:00.000Z',
    strategy: 'strip-emoji',
    status: 'pending',
    originalListId: 'list-1',
    originalSourceId: 'remote-list-1',
    originalName: '😀 Tasks',
    originalGroupId: null,
    connectorInstanceId: 'todo-1',
    newListId: null,
    newName: 'Tasks',
    taskSnapshot: [],
    moveResults: [],
    tasksTotal: 0,
    tasksMoved: 0,
    tasksFailed: 0,
    oldListDeleted: false,
    ...overrides,
  };
}

describe('source-list emoji repair route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSourceList.mockResolvedValue(sourceList);
    mocks.getSourceListRepair.mockResolvedValue(null);
    mocks.beginSourceListRepair.mockResolvedValue({
      repair: repair(),
      replayed: false,
    });
    mocks.finalizeSourceListRepair.mockResolvedValue('completed');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
  });

  it('writes intent, performs the remote rename, and CAS-finalizes under a lease', async () => {
    const connector = { renameList: vi.fn(async () => undefined) };
    mocks.getConnector.mockReturnValue(connector);
    const { POST } = await import('@/app/api/source-lists/[id]/fix-emoji/route');
    const response = await POST(new Request(
      'http://localhost/api/source-lists/list-1/fix-emoji',
      {
        method: 'POST',
        headers: { 'idempotency-key': 'repair-once' },
        body: JSON.stringify({ strategy: 'strip-emoji' }),
      },
    ), { params: Promise.resolve({ id: 'list-1' }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      strategy: 'strip-emoji',
      originalName: '😀 Tasks',
      newName: 'Tasks',
    });
    expect(mocks.runWithConnectorOperationLease).toHaveBeenCalledWith(
      'todo-1',
      'transfer',
      expect.any(Function),
    );
    expect(mocks.beginSourceListRepair).toHaveBeenCalledWith(expect.objectContaining({
      strategy: 'strip-emoji',
      sourceList,
      newName: 'Tasks',
    }));
    expect(connector.renameList).toHaveBeenCalledWith('remote-list-1', 'Tasks');
    expect(mocks.finalizeSourceListRepair).toHaveBeenCalledWith(expect.objectContaining({
      strategy: 'strip-emoji',
      sourceListId: 'list-1',
      expectedOriginalName: '😀 Tasks',
      newName: 'Tasks',
      userDisplayName: 'My tasks',
    }));
    expect(mocks.beginSourceListRepair.mock.invocationCallOrder[0])
      .toBeLessThan(connector.renameList.mock.invocationCallOrder[0]);
    expect(connector.renameList.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.finalizeSourceListRepair.mock.invocationCallOrder[0]);
  });

  it('replays a completed strip repair without another remote mutation', async () => {
    const connector = { renameList: vi.fn(async () => undefined) };
    mocks.getConnector.mockReturnValue(connector);
    mocks.getSourceListRepair.mockResolvedValueOnce(repair({ status: 'completed' }));
    mocks.getSourceList.mockResolvedValueOnce({
      ...sourceList,
      name: 'Tasks',
      lastKnownRemoteName: 'Tasks',
    });
    const { POST } = await import('@/app/api/source-lists/[id]/fix-emoji/route');
    const response = await POST(new Request(
      'http://localhost/api/source-lists/list-1/fix-emoji',
      {
        method: 'POST',
        body: JSON.stringify({ strategy: 'strip-emoji' }),
      },
    ), { params: Promise.resolve({ id: 'list-1' }) });

    expect(response.status).toBe(200);
    expect(connector.renameList).not.toHaveBeenCalled();
    expect(mocks.beginSourceListRepair).not.toHaveBeenCalled();
    expect(mocks.finalizeSourceListRepair).not.toHaveBeenCalled();
  });

  it('replays a completed migration with the original SSE response contract', async () => {
    mocks.getSourceList.mockResolvedValueOnce(null);
    mocks.getSourceListRepair.mockResolvedValueOnce(repair({
      strategy: 'migrate',
      status: 'completed',
      newListId: 'new-list',
      tasksTotal: 1,
      tasksMoved: 1,
      oldListDeleted: true,
    }));
    const { POST } = await import('@/app/api/source-lists/[id]/fix-emoji/route');
    const response = await POST(new Request(
      'http://localhost/api/source-lists/list-1/fix-emoji',
      {
        method: 'POST',
        body: JSON.stringify({ strategy: 'migrate' }),
      },
    ), { params: Promise.resolve({ id: 'list-1' }) });

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toContain('event: complete');
    expect(mocks.runWithConnectorOperationLease).not.toHaveBeenCalled();
  });

  it('checkpoints each migration phase and emits completion only after finalization', async () => {
    const connector = {
      createList: vi.fn(async () => ({ id: 'new-list', displayName: 'Tasks' })),
      moveTaskToList: vi.fn(async () => 'new-task'),
      deleteList: vi.fn(async () => undefined),
      graphFetch: vi.fn(async (path: string) => (
        path.includes('/tasks?')
          ? new Response(JSON.stringify({
              value: [{ id: 'task-1', title: 'Task', status: 'notStarted' }],
            }), { status: 200 })
          : new Response(JSON.stringify({ displayName: 'Tasks' }), { status: 200 })
      )),
    };
    mocks.getConnector.mockReturnValue(connector);
    mocks.beginSourceListRepair.mockResolvedValueOnce({
      repair: repair({ strategy: 'migrate' }),
      replayed: false,
    });
    const { POST } = await import('@/app/api/source-lists/[id]/fix-emoji/route');
    const response = await POST(new Request(
      'http://localhost/api/source-lists/list-1/fix-emoji',
      {
        method: 'POST',
        headers: { 'idempotency-key': 'migrate-once' },
        body: JSON.stringify({ strategy: 'migrate' }),
      },
    ), { params: Promise.resolve({ id: 'list-1' }) });
    const body = await response.text();

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(body).toContain('event: phase');
    expect(body).toContain('event: progress');
    expect(body).toContain('event: complete');
    expect(connector.createList).toHaveBeenCalledWith('Tasks');
    expect(connector.moveTaskToList).toHaveBeenCalledWith(
      'remote-list-1:task-1',
      'new-list',
    );
    expect(connector.deleteList).toHaveBeenCalledWith('remote-list-1');
    expect(mocks.checkpointSourceListRepair).toHaveBeenCalledWith(
      expect.objectContaining({ newListId: 'new-list', status: 'running' }),
    );
    expect(mocks.finalizeSourceListRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        strategy: 'migrate',
        status: 'completed',
        oldListDeleted: true,
      }),
    );
    expect(connector.deleteList.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.finalizeSourceListRepair.mock.invocationCallOrder[0]);
  });

  it('returns a conflict without success-shaped output when CAS finalization fails', async () => {
    mocks.getConnector.mockReturnValue({ renameList: vi.fn(async () => undefined) });
    mocks.finalizeSourceListRepair.mockResolvedValueOnce('conflict');
    const { POST } = await import('@/app/api/source-lists/[id]/fix-emoji/route');
    const response = await POST(new Request(
      'http://localhost/api/source-lists/list-1/fix-emoji',
      {
        method: 'POST',
        body: JSON.stringify({ strategy: 'strip-emoji' }),
      },
    ), { params: Promise.resolve({ id: 'list-1' }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Source list changed during repair',
      code: 'REPAIR_CONFLICT',
    });
  });
});
