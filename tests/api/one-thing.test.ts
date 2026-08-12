/**
 * API Route Tests — /api/one-thing (GET, POST, DELETE)
 * Tests for issue #99
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Chainable DB mock ──────────────────────────────────────────────────────

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      if (prop === Symbol.iterator) {
        return () => (Array.isArray(terminal) ? terminal : [])[Symbol.iterator]();
      }
      return vi.fn(() => chain);
    },
  });
  return chain;
}

const mockDb = {
  select: vi.fn(() => chainable([])),
  insert: vi.fn(() => chainable([])),
  update: vi.fn(() => chainable(undefined)),
  delete: vi.fn(() => chainable(undefined)),
};

vi.mock('@/db', () => ({ default: mockDb }));

vi.mock('@/db/schema', () => ({
  tasks: {
    id: 'id', title: 'title', status: 'status', priority: 'priority',
    dueDate: 'dueDate', connectorType: 'connectorType', sourceListName: 'sourceListName',
    updatedAt: 'updatedAt', depth: 'depth', parentId: 'parentId',
  },
  weeklyOneThing: {
    id: 'id', taskId: 'taskId', weekMonday: 'weekMonday',
    isManualOverride: 'isManualOverride', completedAt: 'completedAt', createdAt: 'createdAt',
  },
  myDayItems: { taskId: 'taskId', date: 'date' },
}));

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: vi.fn(() => '2026-07-15'),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Ship feature X',
    status: 'in_progress',
    priority: 'high',
    dueDate: '2026-07-17',
    connectorType: 'microsoft-todo',
    sourceListName: 'Work',
    updatedAt: '2026-07-14T10:00:00Z',
    depth: 0,
    ...overrides,
  };
}

function makeOneThing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ot-abc123',
    taskId: 'task-1',
    weekMonday: '2026-07-13',
    isManualOverride: false,
    completedAt: null,
    createdAt: '2026-07-13T08:00:00Z',
    title: 'Ship feature X',
    status: 'in_progress',
    priority: 'high',
    dueDate: '2026-07-17',
    connectorType: 'microsoft-todo',
    sourceListName: 'Work',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/one-thing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns existing one-thing for the week', async () => {
    const existing = makeOneThing();
    // First select: existing one-thing join. Second select: subtask progress.
    mockDb.select
      .mockReturnValueOnce(chainable([existing]))
      .mockReturnValueOnce(chainable([{ total: 3, done: 1 }]));

    const { GET } = await import('@/app/api/one-thing/route');
    const res = await GET(new Request('http://localhost/api/one-thing?date=2026-07-15'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.oneThing.taskId).toBe('task-1');
    expect(data.oneThing.title).toBe('Ship feature X');
    expect(data.source).toBe('auto');
    expect(data.weekMonday).toBe('2026-07-13');
    expect(data.oneThing.subtaskTotal).toBe(3);
    expect(data.oneThing.subtaskDone).toBe(1);
  });

  it('returns manual source when isManualOverride is true', async () => {
    const existing = makeOneThing({ isManualOverride: true });
    mockDb.select
      .mockReturnValueOnce(chainable([existing]))
      .mockReturnValueOnce(chainable([{ total: 0, done: 0 }]));

    const { GET } = await import('@/app/api/one-thing/route');
    const res = await GET(new Request('http://localhost/api/one-thing?date=2026-07-15'));
    const data = await res.json();

    expect(data.source).toBe('manual');
  });

  it('detects just-completed task and sets completedAt', async () => {
    const existing = makeOneThing({ status: 'done', completedAt: null });
    mockDb.select
      .mockReturnValueOnce(chainable([existing]))
      .mockReturnValueOnce(chainable([{ total: 0, done: 0 }]));

    const { GET } = await import('@/app/api/one-thing/route');
    const res = await GET(new Request('http://localhost/api/one-thing'));
    const data = await res.json();

    expect(data.oneThing.justCompleted).toBe(true);
    expect(data.oneThing.completedAt).toBeTruthy();
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('auto-selects when no existing one-thing exists', async () => {
    const openTasks = [
      makeTask({ id: 'task-a', priority: 'low', dueDate: null }),
      makeTask({ id: 'task-b', priority: 'critical', dueDate: '2026-07-16' }),
    ];
    // First select: no existing. Second select: open tasks. Third: myDayItems. Fourth: subtask progress.
    mockDb.select
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable(openTasks))
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([{ total: 0, done: 0 }]));

    const { GET } = await import('@/app/api/one-thing/route');
    const res = await GET(new Request('http://localhost/api/one-thing?date=2026-07-15'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.source).toBe('auto');
    expect(data.oneThing).not.toBeNull();
    // Critical + near due date should score highest
    expect(data.oneThing.taskId).toBe('task-b');
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('returns none when there are no open tasks', async () => {
    mockDb.select
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]));

    const { GET } = await import('@/app/api/one-thing/route');
    const res = await GET(new Request('http://localhost/api/one-thing'));
    const data = await res.json();

    expect(data.oneThing).toBeNull();
    expect(data.source).toBe('none');
  });
});

describe('POST /api/one-thing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('creates a manual override', async () => {
    mockDb.select.mockReturnValueOnce(chainable([{ id: 'task-99', title: 'Important thing' }]));

    const { POST } = await import('@/app/api/one-thing/route');
    const res = await POST(new Request('http://localhost/api/one-thing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-99' }),
    }));
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.taskId).toBe('task-99');
    expect(mockDb.delete).toHaveBeenCalled();
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('rejects when taskId is missing', async () => {
    const { POST } = await import('@/app/api/one-thing/route');
    const res = await POST(new Request('http://localhost/api/one-thing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));

    expect(res.status).toBe(400);
  });

  it('returns 404 when task not found', async () => {
    mockDb.select.mockReturnValueOnce(chainable([]));

    const { POST } = await import('@/app/api/one-thing/route');
    const res = await POST(new Request('http://localhost/api/one-thing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'nonexistent' }),
    }));

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/one-thing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('clears the one-thing for the week', async () => {
    const { DELETE } = await import('@/app/api/one-thing/route');
    const res = await DELETE(new Request('http://localhost/api/one-thing?date=2026-07-15'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.weekMonday).toBe('2026-07-13');
    expect(mockDb.delete).toHaveBeenCalled();
  });
});
