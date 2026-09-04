import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOverview: vi.fn(),
  getConnector: vi.fn(),
  createConnector: vi.fn(async () => true),
  ensureSourceLists: vi.fn(async () => undefined),
  ensureWorkTodoBridge: vi.fn(async () => undefined),
  projectExists: vi.fn(async () => true),
  updateConnector: vi.fn(async () => true),
  updateWorkTodoConnector: vi.fn(async () => 'updated' as const),
  softDeleteConnector: vi.fn(async () => ({ affectedTasks: 2, affectedLists: 1 })),
  hardDeleteConnector: vi.fn(async () => undefined),
  getSourceList: vi.fn(),
  listGroupExists: vi.fn(async () => true),
  patchSourceList: vi.fn(async () => undefined),
  reorderSourceLists: vi.fn(async () => undefined),
  listSourceRankings: vi.fn(async () => []),
  putSourceRankings: vi.fn(async () => []),
  reconcileScheduleFromDb: vi.fn(async () => undefined),
}));

vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence: vi.fn(async () => mocks),
}));
vi.mock('@/lib/sync', () => ({
  syncScheduler: {
    reconcileScheduleFromDb: mocks.reconcileScheduleFromDb,
  },
}));
vi.mock('@/lib/sync/connector-lock', () => ({
  ConnectorOperationBusyError: class ConnectorOperationBusyError extends Error {},
  runWithConnectorOperationLease: vi.fn(
    async (_id: string, _type: string, work: () => Promise<unknown>) => work(),
  ),
}));

const sourceList = {
  id: 'list-1',
  connectorInstanceId: 'connector-1',
  sourceId: 'remote-list',
  name: 'Remote list',
  type: 'list',
  taskCount: 0,
  lastSyncedAt: null,
  wellKnownListName: null,
  groupId: null,
  sortOrder: 0,
  hidden: false,
  lastKnownRemoteName: null,
  userDisplayName: null,
  icon: null,
  iconColor: null,
};

describe('connector management API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOverview.mockResolvedValue({
      connectors: [{
        id: 'connector-1',
        type: 'test',
        name: 'Connector',
        enabled: true,
        syncMode: 'poll',
        pollIntervalMinutes: 5,
        capabilities: { read: true },
        credentials: { token: 'secret' },
        settings: {},
        syncedLists: ['remote-list'],
        createdAt: '2026-09-04T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:00.000Z',
        deletedAt: null,
        lastTestStatus: null,
        lastTestError: null,
        lastTestAt: null,
      }],
      sourceLists: [sourceList],
      openTaskCounts: [{
        connectorInstanceId: 'connector-1',
        sourceListId: 'remote-list',
        count: 3,
      }],
      syncOutcomes: [{
        connectorId: 'connector-1',
        lastSyncedAt: '2026-09-04T01:00:00.000Z',
        success: false,
        error: 'offline',
      }],
    });
    mocks.getSourceList.mockResolvedValue(sourceList);
    mocks.listGroupExists.mockResolvedValue(true);
  });

  it('builds the connector response entirely from the management port', async () => {
    const { GET } = await import('@/app/api/connectors/route');
    const response = await GET(new Request(
      'http://localhost/api/connectors?includeDeleted=true',
    ));

    expect(response.status).toBe(200);
    expect(mocks.getOverview).toHaveBeenCalledWith(true);
    expect(await response.json()).toMatchObject({
      connectors: [{
        id: 'connector-1',
        credentials: {},
        hasCredentials: true,
        lastSyncStatus: 'failed',
        lastSyncError: 'offline',
      }],
      sourceLists: [{
        id: 'list-1',
        taskCount: 3,
        selectedForSync: true,
      }],
    });
  });

  it('soft-deletes through the port and reports affected records', async () => {
    const { DELETE } = await import('@/app/api/connectors/route');
    const response = await DELETE(new Request(
      'http://localhost/api/connectors?id=connector-1',
      { method: 'DELETE' },
    ));

    expect(response.status).toBe(200);
    expect(mocks.softDeleteConnector).toHaveBeenCalledWith(
      'connector-1',
      expect.stringMatching(/^20/),
    );
    expect(await response.json()).toMatchObject({
      success: true,
      mode: 'soft',
      affectedTasks: 2,
      affectedLists: 1,
    });
  });

  it('patches grouping and visibility through one source-list operation', async () => {
    const { PATCH } = await import('@/app/api/source-lists/[id]/route');
    const response = await PATCH(new Request('http://localhost/api/source-lists/list-1', {
      method: 'PATCH',
      body: JSON.stringify({ groupId: ' group-1 ', hidden: 1 }),
    }), { params: Promise.resolve({ id: 'list-1' }) });

    expect(response.status).toBe(200);
    expect(mocks.listGroupExists).toHaveBeenCalledWith('group-1');
    expect(mocks.patchSourceList).toHaveBeenCalledWith({
      sourceListId: 'list-1',
      groupId: 'group-1',
      hidden: true,
    });
  });

  it('reorders source lists through the management port', async () => {
    const { PUT } = await import('@/app/api/source-lists/reorder/route');
    const response = await PUT(new Request('http://localhost/api/source-lists/reorder', {
      method: 'PUT',
      body: JSON.stringify({ orderedIds: ['list-2', 'list-1'] }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.reorderSourceLists).toHaveBeenCalledWith(['list-2', 'list-1']);
  });
});
