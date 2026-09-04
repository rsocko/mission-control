import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMicrosoftTodoHealthSnapshot: vi.fn(),
  getConnector: vi.fn(),
  createConnector: vi.fn(),
}));

vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence: vi.fn(async () => mocks),
}));
vi.mock('@/lib/connectors/registry-runtime', () => ({
  getConnectorRegistry: vi.fn(() => ({
    getConnector: mocks.getConnector,
    createConnector: mocks.createConnector,
  })),
}));
vi.mock('@/lib/public-demo', () => ({
  isPublicDemoMode: vi.fn(() => false),
}));

const connector = {
  id: 'todo-1',
  type: 'microsoft-todo',
  name: 'Todo',
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 5,
  capabilities: { read: true },
  credentials: { accessToken: 'secret-token' },
  settings: {},
  syncedLists: [],
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
  deletedAt: null,
  lastTestStatus: null,
  lastTestError: null,
  lastTestAt: null,
};

describe('sync health route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMicrosoftTodoHealthSnapshot.mockResolvedValue({
      connectors: [connector],
      sourceLists: [
        {
          id: 'list-affected',
          connectorInstanceId: 'todo-1',
          sourceId: 'remote-affected',
          name: '😀 Hidden',
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
        },
        {
          id: 'list-visible',
          connectorInstanceId: 'todo-1',
          sourceId: 'remote-visible',
          name: 'Visible',
          type: 'list',
          taskCount: 0,
          lastSyncedAt: null,
          wellKnownListName: null,
          groupId: null,
          sortOrder: 1,
          hidden: false,
          lastKnownRemoteName: null,
          userDisplayName: null,
          icon: null,
          iconColor: null,
        },
      ],
      taskCounts: [{
        connectorInstanceId: 'todo-1',
        sourceListId: 'remote-affected',
        count: 0,
      }],
    });
    mocks.getConnector.mockReturnValue({
      graphFetch: vi.fn(async () => new Response(JSON.stringify({
        value: [{ id: 'one' }, { id: 'two' }],
      }), { status: 200 })),
    });
  });

  it('combines one local snapshot with remote fallback counts without exposing credentials', async () => {
    const { GET } = await import('@/app/api/sync/health/route');
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      healthy: false,
      graphApiEmojiIssue: {
        affected: true,
        totalLists: 2,
        graphVisibleLists: 1,
        substrateOnlyLists: 1,
        affectedLists: [{
          id: 'list-affected',
          taskCount: 2,
          connectorInstanceId: 'todo-1',
        }],
      },
    });
    expect(mocks.getMicrosoftTodoHealthSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.getConnector).toHaveBeenCalledWith('todo-1');
    expect(JSON.stringify(body)).not.toContain('secret-token');
  });

  it('returns the existing healthy empty shape without initializing a connector', async () => {
    mocks.getMicrosoftTodoHealthSnapshot.mockResolvedValueOnce({
      connectors: [],
      sourceLists: [],
      taskCounts: [],
    });
    mocks.getConnector.mockReturnValueOnce(undefined);
    const { GET } = await import('@/app/api/sync/health/route');
    const response = await GET();

    expect(await response.json()).toMatchObject({
      healthy: true,
      graphApiEmojiIssue: {
        affected: false,
        affectedLists: [],
        totalLists: 0,
        graphVisibleLists: 0,
        substrateOnlyLists: 0,
      },
    });
    expect(mocks.createConnector).not.toHaveBeenCalled();
  });
});
