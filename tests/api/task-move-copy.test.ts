/**
 * Tests for PR #303 — Migrate all task references during task move
 * Tests for PR #302 — Use targetConnectorInstanceId instead of type string in copy/move
 */
import { NextResponse } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Shared DB mock (chainable with transaction tracking) ────────────────────

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

// Track all tx operations
const txOps: Array<{ op: string; table?: string; values?: unknown; set?: unknown }> = [];

function createTxMock() {
  return {
    select: vi.fn(() => {
      txOps.push({ op: 'select' });
      return chainable([]);
    }),
    insert: vi.fn((table: unknown) => {
      const opEntry = { op: 'insert', table: String(table), values: undefined as unknown };
      txOps.push(opEntry);
      return {
        values: vi.fn((vals: unknown) => {
          opEntry.values = vals;
          return chainable([]);
        }),
      };
    }),
    update: vi.fn((table: unknown) => {
      const opEntry = { op: 'update', table: String(table), set: undefined as unknown };
      txOps.push(opEntry);
      return {
        set: vi.fn((s: unknown) => {
          opEntry.set = s;
          return { where: vi.fn(() => chainable(undefined)) };
        }),
      };
    }),
    delete: vi.fn((table: unknown) => {
      txOps.push({ op: 'delete', table: String(table) });
      return { where: vi.fn(() => chainable(undefined)) };
    }),
  };
}

const mockDb = {
  select: vi.fn(() => chainable([])),
  insert: vi.fn(() => chainable([])),
  update: vi.fn(() => chainable(undefined)),
  delete: vi.fn(() => chainable(undefined)),
  transaction: vi.fn(async (fn: (tx: ReturnType<typeof createTxMock>) => Promise<void>) => {
    const tx = createTxMock();
    await fn(tx);
  }),
};

const mockRunTransaction = vi.fn((fn: (tx: ReturnType<typeof createTxMock>) => unknown) => {
  const tx = createTxMock();
  return fn(tx);
});

vi.mock('@/db', () => ({
  default: mockDb,
  runTransaction: mockRunTransaction,
}));

vi.mock('@/db/schema', () => ({
  tasks: { id: 'id', connectorType: 'connector_type', connectorInstanceId: 'connector_instance_id', parentId: 'parent_id', sourceListId: 'source_list_id' },
  taskTags: { taskId: 'task_id', tagId: 'tag_id' },
  taskProjects: { taskId: 'task_id', projectId: 'project_id' },
  projectAutoIncludeExclusions: {
    taskId: 'excluded_task_id',
    toString: () => 'projectAutoIncludeExclusions',
  },
  taskDependencies: { taskId: 'task_id', dependsOnTaskId: 'depends_on_task_id' },
  myDayItems: { taskId: 'task_id' },
  focusItems: { taskId: 'task_id' },
  taskSchedules: { taskId: 'task_id' },
  projectPhaseItems: { taskId: 'task_id' },
  weeklyOneThing: { taskId: 'task_id' },
  connectorConfigs: { id: 'id', type: 'type' },
}));

vi.mock('@/lib/logger', () => ({
  dbLogger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/api-error', () => ({
  ApiErrors: {
    internal: vi.fn((msg: string) => {
      return NextResponse.json({ error: msg, code: 'INTERNAL_ERROR' }, { status: 500 });
    }),
  },
}));

const BASE = 'http://localhost:3099';

beforeEach(() => {
  txOps.length = 0;
  mockDb.select.mockImplementation(() => chainable([]));
});

// ─── MOVE ENDPOINT ──────────────────────────────────────────────────────────

describe('POST /api/tasks/[id]/move — reference migration (PR #303)', () => {
  it('should require targetConnectorInstanceId (not type string — PR #302)', async () => {
    const { POST } = await import('@/app/api/tasks/[id]/move/route');
    const request = new Request(`${BASE}/api/tasks/task-1/move`, {
      method: 'POST',
      body: JSON.stringify({ targetConnectorType: 'microsoft-todo' }), // wrong field
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('targetConnectorInstanceId');
  });

  it('should return 404 when connector instance does not exist', async () => {
    mockDb.select.mockImplementation(() => chainable([]));

    const { POST } = await import('@/app/api/tasks/[id]/move/route');
    const request = new Request(`${BASE}/api/tasks/task-1/move`, {
      method: 'POST',
      body: JSON.stringify({ targetConnectorInstanceId: 'nonexistent' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toContain('not found');
  });

  it('should return 404 when source task does not exist', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return chainable([{ id: 'inst-2', type: 'local' }]);
      return chainable([]); // task not found
    });

    const { POST } = await import('@/app/api/tasks/[id]/move/route');
    const request = new Request(`${BASE}/api/tasks/task-999/move`, {
      method: 'POST',
      body: JSON.stringify({ targetConnectorInstanceId: 'inst-2' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-999' }) });
    expect(response.status).toBe(404);
  });

  it('should reject moving to same location without targetListId', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return chainable([{ id: 'inst-1', type: 'local' }]);
      return chainable([{ id: 'task-1', connectorInstanceId: 'inst-1', connectorType: 'local', title: 'Test', status: 'todo', priority: 'medium' }]);
    });

    const { POST } = await import('@/app/api/tasks/[id]/move/route');
    const request = new Request(`${BASE}/api/tasks/task-1/move`, {
      method: 'POST',
      body: JSON.stringify({ targetConnectorInstanceId: 'inst-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('same location');
  });

  it('should successfully move a task and return new ID', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return chainable([{ id: 'inst-2', type: 'microsoft-todo' }]);
      return chainable([{
        id: 'task-1', connectorInstanceId: 'inst-1', connectorType: 'local',
        title: 'My Task', description: 'desc', status: 'todo', priority: 'high',
        dueDate: '2026-08-01', createdAt: '2026-07-01', completedAt: null,
      }]);
    });

    const { POST } = await import('@/app/api/tasks/[id]/move/route');
    const request = new Request(`${BASE}/api/tasks/task-1/move`, {
      method: 'POST',
      body: JSON.stringify({ targetConnectorInstanceId: 'inst-2' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBeDefined();
    expect(data.previousId).toBe('task-1');
    expect(data.previousSource).toBe('local');
    expect(data.message).toContain('microsoft-todo');
  });

  it('should use transaction for all DB operations (atomicity)', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return chainable([{ id: 'inst-2', type: 'local' }]);
      return chainable([{
        id: 'task-1', connectorInstanceId: 'inst-1', connectorType: 'local',
        title: 'Test', status: 'todo', priority: 'medium',
      }]);
    });

    const { POST } = await import('@/app/api/tasks/[id]/move/route');
    const request = new Request(`${BASE}/api/tasks/task-1/move`, {
      method: 'POST',
      body: JSON.stringify({ targetConnectorInstanceId: 'inst-2' }),
      headers: { 'Content-Type': 'application/json' },
    });
    await POST(request, { params: Promise.resolve({ id: 'task-1' }) });

    // Transaction should have been used
    expect(mockRunTransaction).toHaveBeenCalled();

    // Verify multiple reference tables were touched in the transaction
    const insertOps = txOps.filter(op => op.op === 'insert');
    const updateOps = txOps.filter(op => op.op === 'update');
    const deleteOps = txOps.filter(op => op.op === 'delete');

    // At minimum: insert new task, update references, both dependency directions, and child tasks
    expect(insertOps.length).toBeGreaterThanOrEqual(1); // new task
    expect(updateOps.length).toBeGreaterThanOrEqual(8);
    expect(updateOps).toContainEqual(expect.objectContaining({
      table: 'projectAutoIncludeExclusions',
    }));
    expect(deleteOps.length).toBeGreaterThanOrEqual(2); // old taskTags, taskProjects, task
  });
});

// ─── COPY ENDPOINT ──────────────────────────────────────────────────────────

describe('POST /api/tasks/[id]/copy — uses targetConnectorInstanceId (PR #302)', () => {
  it('should require targetConnectorInstanceId', async () => {
    const { POST } = await import('@/app/api/tasks/[id]/copy/route');
    const request = new Request(`${BASE}/api/tasks/task-1/copy`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('targetConnectorInstanceId');
  });

  it('should return 404 when target connector instance does not exist', async () => {
    mockDb.select.mockImplementation(() => chainable([]));

    const { POST } = await import('@/app/api/tasks/[id]/copy/route');
    const request = new Request(`${BASE}/api/tasks/task-1/copy`, {
      method: 'POST',
      body: JSON.stringify({ targetConnectorInstanceId: 'nonexistent' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(404);
  });

  it('should return 404 when source task does not exist', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return chainable([{ id: 'inst-2', type: 'github-issues' }]);
      return chainable([]);
    });

    const { POST } = await import('@/app/api/tasks/[id]/copy/route');
    const request = new Request(`${BASE}/api/tasks/task-999/copy`, {
      method: 'POST',
      body: JSON.stringify({ targetConnectorInstanceId: 'inst-2' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-999' }) });
    expect(response.status).toBe(404);
  });

  it('should return 201 on successful copy', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return chainable([{ id: 'inst-2', type: 'microsoft-todo' }]);
      return chainable([{
        id: 'task-1', connectorInstanceId: 'inst-1', connectorType: 'local',
        title: 'Copy Me', description: 'a task', status: 'todo', priority: 'low',
        dueDate: null, createdAt: '2026-07-01',
      }]);
    });

    const { POST } = await import('@/app/api/tasks/[id]/copy/route');
    const request = new Request(`${BASE}/api/tasks/task-1/copy`, {
      method: 'POST',
      body: JSON.stringify({ targetConnectorInstanceId: 'inst-2' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.id).toBeDefined();
    expect(data.sourceId).toBe('task-1');
    expect(data.message).toContain('microsoft-todo');
  });
});
