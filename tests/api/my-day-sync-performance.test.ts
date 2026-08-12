import { beforeEach, describe, expect, it, vi } from 'vitest';

function chainable<T>(value: T) {
  const chain: Record<PropertyKey, unknown> = new Proxy({}, {
    get(_, property: string | symbol) {
      if (property === 'then') return (resolve: (result: T) => unknown) => resolve(value);
      return vi.fn(() => chain);
    },
  });
  return chain;
}

let selectCall = 0;
const selectOverrides = new Map<number, unknown>();
const mockDb = {
  select: vi.fn(() => {
    selectCall++;
    return chainable(selectOverrides.has(selectCall)
      ? selectOverrides.get(selectCall)
      : selectCall === 1
      ? [{
          id: 'todo-1',
          type: 'microsoft-todo',
          enabled: true,
          capabilities: {},
          settings: {},
          credentials: {},
          syncedLists: [],
        }]
      : []);
  }),
  insert: vi.fn(() => chainable({ changes: 0 })),
  delete: vi.fn(() => chainable({ changes: 0 })),
};

vi.mock('@/db', () => ({ default: mockDb }));
vi.mock('@/db/schema', () => ({
  myDayItems: { id: 'id', taskId: 'task_id', date: 'date' },
  myDayExclusions: { taskId: 'task_id', date: 'date' },
  tasks: {
    id: 'id',
    sourceId: 'source_id',
    metadata: 'metadata',
    connectorType: 'connector_type',
    connectorInstanceId: 'connector_instance_id',
    sourceListId: 'source_list_id',
    title: 'title',
    status: 'status',
    completedAt: 'completed_at',
    dueDate: 'due_date',
    depth: 'depth',
  },
  syncDeletionSnapshots: {
    sourceId: 'source_id',
    connectorId: 'connector_id',
    reason: 'reason',
  },
  connectorConfigs: {
    type: 'type',
    enabled: 'enabled',
    deletedAt: 'deleted_at',
  },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => 'eq'),
  and: vi.fn(() => 'and'),
  like: vi.fn(() => 'like'),
  isNull: vi.fn(() => 'is-null'),
  inArray: vi.fn(() => 'in-array'),
  ne: vi.fn(() => 'ne'),
}));

let resolveRemoteTasks!: (tasks: unknown[]) => void;
const fetchMyDayTasks = vi.fn(() => new Promise<unknown[]>((resolve) => {
  resolveRemoteTasks = resolve;
}));
const fetchMyDaySuggestions = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/connectors/microsoft-todo', () => ({
  MicrosoftTodoConnector: class {
    initialize = vi.fn().mockResolvedValue(undefined);
    fetchMyDayTasks = fetchMyDayTasks;
    fetchMyDaySuggestions = fetchMyDaySuggestions;
  },
}));

describe('My Day reconciliation coalescing', () => {
  beforeEach(() => {
    selectCall = 0;
    selectOverrides.clear();
    vi.clearAllMocks();
  });

  it('shares one remote fetch across equivalent concurrent requests', async () => {
    const { POST } = await import('@/app/api/my-day/sync/route');
    const createRequest = () => new Request('http://localhost/api/my-day/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-08' }),
    });

    const first = POST(createRequest());
    await vi.waitFor(() => expect(fetchMyDayTasks).toHaveBeenCalledTimes(1));
    const second = POST(createRequest());
    resolveRemoteTasks([]);

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(fetchMyDayTasks).toHaveBeenCalledTimes(1);
    expect(fetchMyDaySuggestions).toHaveBeenCalledTimes(1);
    const { ne } = await import('drizzle-orm');
    expect(ne).toHaveBeenCalledWith('status', 'done');
    expect(ne).toHaveBeenCalledWith('status', 'cancelled');
  });

  it('rejects oversized remote task sets before local reconciliation', async () => {
    const { POST } = await import('@/app/api/my-day/sync/route');
    const responsePromise = POST(new Request('http://localhost/api/my-day/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-09' }),
    }));
    await vi.waitFor(() => expect(fetchMyDayTasks).toHaveBeenCalledTimes(1));
    resolveRemoteTasks(Array.from({ length: 2_001 }, () => ({})));

    const response = await responsePromise;
    expect(response.status).toBe(502);
    expect(fetchMyDaySuggestions).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('removes auto-included cancellations while retaining manual history', async () => {
    selectOverrides.set(2, [
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
    ]);
    const { POST } = await import('@/app/api/my-day/sync/route');
    const responsePromise = POST(new Request('http://localhost/api/my-day/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-10' }),
    }));
    await vi.waitFor(() => expect(fetchMyDayTasks).toHaveBeenCalledTimes(1));
    resolveRemoteTasks([]);

    const response = await responsePromise;
    const { inArray } = await import('drizzle-orm');
    expect(response.status).toBe(200);
    expect(inArray).toHaveBeenCalledWith('id', ['md-auto-cancelled']);
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it('does not re-add a locally cancelled task returned by remote My Day', async () => {
    selectOverrides.set(6, [{
      id: 'task-cancelled',
      sourceId: 'list-1:task-1',
      metadata: null,
      status: 'cancelled',
    }]);
    const { POST } = await import('@/app/api/my-day/sync/route');
    const responsePromise = POST(new Request('http://localhost/api/my-day/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-11' }),
    }));
    await vi.waitFor(() => expect(fetchMyDayTasks).toHaveBeenCalledTimes(1));
    resolveRemoteTasks([{
      ParentFolderId: 'list-1',
      Id: 'task-1',
      Subject: 'Cancelled task',
      Status: 'NotStarted',
    }]);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('suppresses an archived recurring duplicate and removes its stale My Day row', async () => {
    selectOverrides.set(2, [{
      id: 'md-rosey-duplicate',
      taskId: 'task-rosey-duplicate',
      sourceId: 'dog-tasks:rosey-old',
      isAutoIncluded: true,
      status: 'todo',
      completedAt: null,
    }]);
    selectOverrides.set(4, ['2026-08-01', '2026-08-02', '2026-08-03'].map(dueDate => ({
      title: 'Rosey: Ear Spray 1x/day (both ears?)',
      sourceListId: 'dog-tasks',
      status: 'done',
      dueDate,
      completedAt: `${dueDate}T20:00:00Z`,
      metadata: '{}',
    })));
    selectOverrides.set(5, [{ sourceId: 'dog-tasks:rosey-old' }]);

    const { POST } = await import('@/app/api/my-day/sync/route');
    const responsePromise = POST(new Request('http://localhost/api/my-day/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-11' }),
    }));
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
    const { inArray } = await import('drizzle-orm');
    expect(response.status).toBe(200);
    expect(body.skippedArchivedRecurring).toBe(1);
    expect(inArray).toHaveBeenCalledWith('id', ['md-rosey-duplicate']);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('removes an existing auto-included future recurring task returned by remote My Day', async () => {
    selectOverrides.set(2, [{
      id: 'md-future-recurring',
      taskId: 'task-future-recurring',
      sourceId: 'bills:future-recurring',
      isAutoIncluded: true,
      status: 'todo',
      completedAt: null,
    }]);
    selectOverrides.set(6, [{
      id: 'task-future-recurring',
      sourceId: 'bills:future-recurring',
      metadata: '{"recurrence":"monthly"}',
      status: 'todo',
    }]);

    const { POST } = await import('@/app/api/my-day/sync/route');
    const responsePromise = POST(new Request('http://localhost/api/my-day/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-12' }),
    }));
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
    const { inArray } = await import('drizzle-orm');
    expect(response.status).toBe(200);
    expect(body.skippedFutureRecurring).toBe(1);
    expect(inArray).toHaveBeenCalledWith('id', ['md-future-recurring']);
  });

  it('removes an existing auto-included successor created after completing its recurring sibling', async () => {
    selectOverrides.set(2, [{
      id: 'md-recurring-successor',
      taskId: 'task-recurring-successor',
      sourceId: 'chores:recurring-successor',
      isAutoIncluded: true,
      status: 'todo',
      completedAt: null,
    }]);
    selectOverrides.set(6, [{
      id: 'task-recurring-successor',
      sourceId: 'chores:recurring-successor',
      metadata: '{"recurrence":"daily"}',
      status: 'todo',
    }]);
    selectOverrides.set(7, [{
      sourceListId: 'chores',
      title: 'Daily reset',
      completedAt: '2026-08-12T14:00:00Z',
      metadata: '{"recurrence":"daily"}',
    }]);
    selectOverrides.set(9, [{
      id: 'task-recurring-successor',
      sourceId: 'chores:recurring-successor',
      status: 'todo',
    }]);

    const { POST } = await import('@/app/api/my-day/sync/route');
    const responsePromise = POST(new Request('http://localhost/api/my-day/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-08-12' }),
    }));
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
    const { inArray } = await import('drizzle-orm');
    expect(response.status).toBe(200);
    expect(body.skippedFutureRecurring).toBe(1);
    expect(inArray).toHaveBeenCalledWith('id', ['md-recurring-successor']);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});
