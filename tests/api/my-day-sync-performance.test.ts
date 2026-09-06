import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

interface SyncSnapshot {
  localItems: Array<{
    id: string;
    taskId: string;
    sourceId: string | null;
    isAutoIncluded: boolean;
    status: string;
    completedAt: string | null;
  }>;
  excludedTaskIds: string[];
  recurringHistory: Array<Record<string, unknown>>;
  archivedDuplicateSourceIds: string[];
}

const state = vi.hoisted(() => ({
  snapshot: {
    localItems: [],
    excludedTaskIds: [],
    recurringHistory: [],
    archivedDuplicateSourceIds: [],
  } as SyncSnapshot,
  localTasks: [] as Array<Record<string, unknown>>,
  completedSiblings: [] as Array<Record<string, unknown>>,
  dueTodayTasks: [] as Array<{ id: string; sourceId: string | null; status: string }>,
}));

const myDaySync = vi.hoisted(() => ({
  snapshot: vi.fn(),
  findTasksBySourceIds: vi.fn(),
  listCompletedMyDaySiblings: vi.fn(),
  createTaskFromRemote: vi.fn(),
  applyReconciliation: vi.fn(),
  listOpenDueTodayTaskIds: vi.fn(),
  listOpenDueTodayTasks: vi.fn(),
  listMyDayTaskIds: vi.fn(),
  resolveTaskIdsBySourceIds: vi.fn(),
}));

const listEnabled = vi.hoisted(() => vi.fn());

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    connectors: { listEnabled },
    dailyPlanning: { myDaySync },
  }),
}));

vi.mock('@/lib/planning-signals', () => ({
  appendPlanningSignal: vi.fn(() => true),
  finalizePlanningSignals: vi.fn(),
  finalizePlanningSignalsIfDue: vi.fn(),
}));

let resolveRemoteTasks!: (tasks: unknown[]) => void;
const fetchMyDayTasks = vi.fn<(date: string) => Promise<unknown[]>>();
const fetchMyDaySuggestions = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/connectors/microsoft-todo', () => ({
  MicrosoftTodoConnector: class {
    initialize = vi.fn().mockResolvedValue(undefined);
    fetchMyDayTasks = fetchMyDayTasks;
    fetchMyDaySuggestions = fetchMyDaySuggestions;
  },
}));

function request(date: string) {
  return new Request('http://localhost/api/my-day/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date }),
  });
}

describe('My Day reconciliation coalescing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.snapshot = {
      localItems: [],
      excludedTaskIds: [],
      recurringHistory: [],
      archivedDuplicateSourceIds: [],
    };
    state.localTasks = [];
    state.completedSiblings = [];
    state.dueTodayTasks = [];

    listEnabled.mockResolvedValue([{
      id: 'todo-1',
      type: 'microsoft-todo',
      enabled: true,
      capabilities: {},
      settings: {},
      credentials: {},
      syncedLists: [],
    }]);
    myDaySync.snapshot.mockImplementation(async () => state.snapshot);
    myDaySync.findTasksBySourceIds.mockImplementation(async () => state.localTasks);
    myDaySync.listCompletedMyDaySiblings.mockImplementation(
      async () => state.completedSiblings,
    );
    myDaySync.createTaskFromRemote.mockImplementation(async (command: { id: string }) => ({
      created: true,
      task: { id: command.id, sourceId: 'created', metadata: {}, status: 'todo' },
    }));
    myDaySync.applyReconciliation.mockImplementation(async (command: {
      committedRows: readonly unknown[];
      autoIncludedRows: readonly unknown[];
      removeItemIds: readonly string[];
    }) => ({
      added: command.committedRows.length,
      dueTodayAdded: command.autoIncludedRows.length,
      removed: command.removeItemIds.length,
    }));
    myDaySync.listOpenDueTodayTaskIds.mockResolvedValue([]);
    myDaySync.listOpenDueTodayTasks.mockImplementation(async () => state.dueTodayTasks);
    myDaySync.listMyDayTaskIds.mockResolvedValue([]);
    myDaySync.resolveTaskIdsBySourceIds.mockResolvedValue([]);

    fetchMyDayTasks
      .mockImplementationOnce(() => new Promise<unknown[]>((resolve) => {
        resolveRemoteTasks = resolve;
      }))
      .mockResolvedValue([]);
    fetchMyDaySuggestions.mockResolvedValue([]);
  });

  it('shares one remote fetch across equivalent concurrent requests', async () => {
    const { POST } = await import('@/app/api/my-day/sync/route');

    const first = POST(request('2026-08-08'));
    await vi.waitFor(() => expect(fetchMyDayTasks).toHaveBeenCalledTimes(1));
    const second = POST(request('2026-08-08'));
    resolveRemoteTasks([]);

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(fetchMyDayTasks).toHaveBeenCalledTimes(4);
    expect(fetchMyDayTasks.mock.calls.map(([date]) => date)).toEqual([
      '2026-08-08',
      '2026-08-07',
      '2026-08-06',
      '2026-08-05',
    ]);
    expect(fetchMyDaySuggestions).toHaveBeenCalledTimes(1);
    // The route asks persistence for open due-today identity, never SQL predicates.
    expect(myDaySync.listOpenDueTodayTasks).toHaveBeenCalledWith({
      connectorType: 'microsoft-todo',
      connectorInstanceId: 'todo-1',
      date: '2026-08-08',
    });
  });

  it('rejects oversized remote task sets before local reconciliation', async () => {
    const { POST } = await import('@/app/api/my-day/sync/route');
    const responsePromise = POST(request('2026-08-09'));
    await vi.waitFor(() => expect(fetchMyDayTasks).toHaveBeenCalledTimes(1));
    resolveRemoteTasks(Array.from({ length: 2_001 }, () => ({})));

    const response = await responsePromise;
    expect(response.status).toBe(502);
    expect(fetchMyDaySuggestions).not.toHaveBeenCalled();
    expect(myDaySync.snapshot).not.toHaveBeenCalled();
    expect(myDaySync.applyReconciliation).not.toHaveBeenCalled();
  });

  it('removes auto-included cancellations while retaining manual history', async () => {
    state.snapshot.localItems = [
      {
        id: 'md-auto-cancelled',
        taskId: 'task-auto-cancelled',
        sourceId: 'list:auto-cancelled',
        isAutoIncluded: true,
        status: 'cancelled',
        completedAt: null,
      },
      {
        id: 'md-manual-cancelled',
        taskId: 'task-manual-cancelled',
        sourceId: 'list:manual-cancelled',
        isAutoIncluded: false,
        status: 'cancelled',
        completedAt: null,
      },
    ];

    const { POST } = await import('@/app/api/my-day/sync/route');
    const responsePromise = POST(request('2026-08-10'));
    await vi.waitFor(() => expect(fetchMyDayTasks).toHaveBeenCalledTimes(1));
    resolveRemoteTasks([]);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(myDaySync.applyReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      removeItemIds: ['md-auto-cancelled'],
      signal: expect.objectContaining({ provenance: 'microsoft-todo-substrate' }),
    }));
  });

  it('does not re-add a locally cancelled task returned by remote My Day', async () => {
    state.localTasks = [{
      id: 'task-cancelled',
      sourceId: 'list-1:task-1',
      metadata: null,
      status: 'cancelled',
    }];

    const { POST } = await import('@/app/api/my-day/sync/route');
    const responsePromise = POST(request('2026-08-11'));
    await vi.waitFor(() => expect(fetchMyDayTasks).toHaveBeenCalledTimes(1));
    resolveRemoteTasks([{
      ParentFolderId: 'list-1',
      Id: 'task-1',
      Subject: 'Cancelled task',
      Status: 'NotStarted',
    }]);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(myDaySync.createTaskFromRemote).not.toHaveBeenCalled();
    expect(myDaySync.applyReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      committedRows: [],
      signal: expect.objectContaining({ provenance: 'microsoft-todo-substrate' }),
    }));
  });

  it('suppresses an archived recurring duplicate and removes its stale My Day row', async () => {
    state.snapshot.localItems = [{
      id: 'md-rosey-duplicate',
      taskId: 'task-rosey-duplicate',
      sourceId: 'dog-tasks:rosey-old',
      isAutoIncluded: true,
      status: 'todo',
      completedAt: null,
    }];
    state.snapshot.recurringHistory = ['2026-08-01', '2026-08-02', '2026-08-03'].map(
      (dueDate) => ({
        title: 'Rosey: Ear Spray 1x/day (both ears?)',
        sourceListId: 'dog-tasks',
        status: 'done',
        dueDate,
        completedAt: `${dueDate}T20:00:00Z`,
        metadata: {},
      }),
    );
    state.snapshot.archivedDuplicateSourceIds = ['dog-tasks:rosey-old'];

    const { POST } = await import('@/app/api/my-day/sync/route');
    const responsePromise = POST(request('2026-08-11'));
    await vi.waitFor(() => expect(fetchMyDayTasks).toHaveBeenCalledTimes(1));
    resolveRemoteTasks([{
      ParentFolderId: 'dog-tasks',
      Id: 'rosey-old',
      Subject: 'Rosey: Ear Spray 1x/day (both ears?)',
      Status: 'NotStarted',
      DueDateTime: { DateTime: '2026-08-09T00:00:00Z' },
    }]);

    const response = await responsePromise;
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.skippedArchivedRecurring).toBe(1);
    expect(myDaySync.applyReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      removeItemIds: ['md-rosey-duplicate'],
      signal: expect.objectContaining({ provenance: 'microsoft-todo-substrate' }),
    }));
    expect(myDaySync.createTaskFromRemote).not.toHaveBeenCalled();
  });

  it('removes an existing auto-included future recurring task returned by remote My Day', async () => {
    state.snapshot.localItems = [{
      id: 'md-future-recurring',
      taskId: 'task-future-recurring',
      sourceId: 'bills:future-recurring',
      isAutoIncluded: true,
      status: 'todo',
      completedAt: null,
    }];
    state.localTasks = [{
      id: 'task-future-recurring',
      sourceId: 'bills:future-recurring',
      metadata: { recurrence: 'monthly' },
      status: 'todo',
    }];

    const { POST } = await import('@/app/api/my-day/sync/route');
    const responsePromise = POST(request('2026-08-12'));
    await vi.waitFor(() => expect(fetchMyDayTasks).toHaveBeenCalledTimes(1));
    resolveRemoteTasks([{
      ParentFolderId: 'bills',
      Id: 'future-recurring',
      Subject: 'Credit card bill',
      Status: 'NotStarted',
      DueDateTime: { DateTime: '2026-09-10T00:00:00Z' },
      Recurrence: {
        Pattern: { Type: 'absoluteMonthly', Interval: 1, DayOfMonth: 10 },
        Range: { Type: 'noEnd', StartDate: '2026-09-10' },
      },
    }]);

    const response = await responsePromise;
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.skippedFutureRecurring).toBe(1);
    expect(myDaySync.applyReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      removeItemIds: ['md-future-recurring'],
      signal: expect.objectContaining({ provenance: 'microsoft-todo-substrate' }),
    }));
  });

  it('removes an existing auto-included successor created after completing its recurring sibling', async () => {
    state.snapshot.localItems = [{
      id: 'md-recurring-successor',
      taskId: 'task-recurring-successor',
      sourceId: 'chores:recurring-successor',
      isAutoIncluded: true,
      status: 'todo',
      completedAt: null,
    }];
    state.localTasks = [{
      id: 'task-recurring-successor',
      sourceId: 'chores:recurring-successor',
      metadata: { recurrence: 'daily' },
      status: 'todo',
    }];
    state.completedSiblings = [{
      sourceListId: 'chores',
      title: 'Daily reset',
      completedAt: '2026-08-12T14:00:00Z',
      metadata: { recurrence: 'daily' },
    }];

    const { POST } = await import('@/app/api/my-day/sync/route');
    const responsePromise = POST(request('2026-08-12'));
    await vi.waitFor(() => expect(fetchMyDayTasks).toHaveBeenCalledTimes(1));
    resolveRemoteTasks([{
      ParentFolderId: 'chores',
      Id: 'recurring-successor',
      Subject: 'Daily reset',
      Status: 'NotStarted',
      CreatedDateTime: '2026-08-12T14:00:01Z',
      DueDateTime: { DateTime: '2026-08-12T00:00:00Z' },
      Recurrence: {
        Pattern: { Type: 'daily', Interval: 1 },
        Range: { Type: 'noEnd', StartDate: '2026-08-12' },
      },
    }]);

    const response = await responsePromise;
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.skippedFutureRecurring).toBe(1);
    expect(myDaySync.applyReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      removeItemIds: ['md-recurring-successor'],
      signal: expect.objectContaining({ provenance: 'microsoft-todo-substrate' }),
    }));
  });

  it('reports no configured connector without touching daily-planning persistence', async () => {
    listEnabled.mockResolvedValue([{ id: 'other', type: 'github-issues', enabled: true }]);

    const { POST } = await import('@/app/api/my-day/sync/route');
    const response = await POST(request('2026-08-13'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ synced: 0 });
    expect(myDaySync.snapshot).not.toHaveBeenCalled();
  });
});
