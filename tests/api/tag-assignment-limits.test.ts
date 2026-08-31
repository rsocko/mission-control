/**
 * Tests for PR #305 — Input limits and optimization on tag assignment endpoint
 */
import { NextResponse } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetCapabilities,
  mockGetConnector,
  mockInitializeConnector,
  mockIsConnectorEnabled,
  mockEvaluateRulesForTasks,
} = vi.hoisted(() => ({
  mockGetCapabilities: vi.fn(),
  mockGetConnector: vi.fn(),
  mockInitializeConnector: vi.fn(),
  mockIsConnectorEnabled: vi.fn(),
  mockEvaluateRulesForTasks: vi.fn(),
}));

// ─── Shared DB mock ─────────────────────────────────────────────────────────

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
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
    const txProxy = new Proxy({}, {
      get() {
        return vi.fn(() => chainable([]));
      },
    });
    await fn(txProxy);
  }),
};

vi.mock('@/db', () => ({
  default: mockDb,
  runTransaction: vi.fn((fn: (tx: unknown) => unknown) => {
    const txProxy = new Proxy({}, {
      get() { return vi.fn(() => chainable([])); },
    });
    return fn(txProxy);
  }),
}));

vi.mock('@/db/schema', () => ({
  tags: { id: 'id', slug: 'slug', name: 'name', type: 'type', source: 'source', color: 'color', confirmed: 'confirmed', createdAt: 'created_at' },
  taskTags: { taskId: 'task_id', tagId: 'tag_id' },
  tasks: { id: 'id', connectorInstanceId: 'connector_instance_id', sourceId: 'source_id', connectorType: 'connector_type' },
  connectorConfigs: { id: 'id', capabilities: 'capabilities' },
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: { getConnector: mockGetConnector },
}));

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: mockGetCapabilities,
  isConnectorEnabled: mockIsConnectorEnabled,
}));

vi.mock('@/lib/sync', () => ({
  syncScheduler: { initializeConnectorFromDb: mockInitializeConnector },
}));

vi.mock('@/lib/rules', () => ({
  evaluateRulesForTasks: mockEvaluateRulesForTasks,
}));

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn() },
  dbLogger: { error: vi.fn() },
}));

vi.mock('@/lib/api-error', () => ({
  ApiErrors: {
    internal: vi.fn((msg: string) => {
      return NextResponse.json({ error: msg, code: 'INTERNAL_ERROR' }, { status: 500 });
    }),
  },
}));

vi.mock('@/lib/mode', () => ({
  isDemoMode: () => false,
}));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomUUID: () => 'test-uuid-1234',
  };
});

const BASE = 'http://localhost:3099';

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.select.mockImplementation(() => chainable([]));
  mockDb.transaction.mockImplementation(async (fn) => {
    const txProxy = new Proxy({}, {
      get() { return vi.fn(() => chainable([])); },
    });
    await fn(txProxy);
  });
  mockGetCapabilities.mockResolvedValue(null);
  mockIsConnectorEnabled.mockResolvedValue(true);
});

describe('POST /api/tasks/[id]/tags — input limits (PR #305)', () => {
  it('should reject when tags array is empty', async () => {
    const { POST } = await import('@/app/api/tasks/[id]/tags/route');
    const request = new Request(`${BASE}/api/tasks/task-1/tags`, {
      method: 'POST',
      body: JSON.stringify({ tags: [] }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('required');
  });

  it('should reject when tags array is missing', async () => {
    const { POST } = await import('@/app/api/tasks/[id]/tags/route');
    const request = new Request(`${BASE}/api/tasks/task-1/tags`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(400);
  });

  it('should reject when more than 20 tags are provided', async () => {
    const tooManyTags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    const { POST } = await import('@/app/api/tasks/[id]/tags/route');
    const request = new Request(`${BASE}/api/tasks/task-1/tags`, {
      method: 'POST',
      body: JSON.stringify({ tags: tooManyTags }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('maximum');
    expect(data.error).toContain('20');
  });

  it('should accept exactly 20 tags', async () => {
    // Mock task lookup to return a task
    mockDb.select.mockImplementation(() => chainable([{ connectorInstanceId: null, sourceId: 'local:1', connectorType: 'local' }]));

    const exactlyTwenty = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
    const { POST } = await import('@/app/api/tasks/[id]/tags/route');
    const request = new Request(`${BASE}/api/tasks/task-1/tags`, {
      method: 'POST',
      body: JSON.stringify({ tags: exactlyTwenty }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(200);
    expect(mockEvaluateRulesForTasks).toHaveBeenCalledWith(['task-1']);
  });

  it('should truncate tag names to 100 characters', async () => {
    mockDb.select.mockImplementation(() => chainable([{ connectorInstanceId: null, sourceId: 'local:1', connectorType: 'local' }]));

    const longTag = 'a'.repeat(150);
    const { POST } = await import('@/app/api/tasks/[id]/tags/route');
    const request = new Request(`${BASE}/api/tasks/task-1/tags`, {
      method: 'POST',
      body: JSON.stringify({ tags: [longTag] }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    // Should succeed (truncated, not rejected)
    expect(response.status).toBe(200);
  });

  it('keeps a successful tag write successful when auto-include evaluation fails', async () => {
    mockDb.select.mockImplementation(() => chainable([{ connectorInstanceId: null, sourceId: 'local:1', connectorType: 'local' }]));
    mockEvaluateRulesForTasks.mockRejectedValueOnce(new Error('rule evaluation failed'));

    const { POST } = await import('@/app/api/tasks/[id]/tags/route');
    const response = await POST(new Request(`${BASE}/api/tasks/task-1/tags`, {
      method: 'POST',
      body: JSON.stringify({ tags: ['3DPrint'] }),
      headers: { 'Content-Type': 'application/json' },
    }), { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(200);
  });

  it('should filter out non-string and empty values from tags', async () => {
    const { POST } = await import('@/app/api/tasks/[id]/tags/route');
    const request = new Request(`${BASE}/api/tasks/task-1/tags`, {
      method: 'POST',
      body: JSON.stringify({ tags: [null, '', '   ', 123, undefined] }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });
    // All invalid → effectively empty → 400
    expect(response.status).toBe(400);
  });

  it('should require tagId for DELETE', async () => {
    const { DELETE } = await import('@/app/api/tasks/[id]/tags/route');
    const request = new Request(`${BASE}/api/tasks/task-1/tags`, {
      method: 'DELETE',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await DELETE(request, { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('tagId');
  });

  it('writes Microsoft To Do tag removal through despite legacy stored capabilities', async () => {
    const removeTagFromTask = vi.fn().mockResolvedValue(undefined);
    mockGetCapabilities.mockResolvedValue({
      read: true,
      write: true,
      delete: true,
      sync: true,
      subtasks: true,
      lists: true,
      tags: true,
      tagWriteBack: true,
      taskSourceModel: 'remote-managed',
      taskFieldProfile: {
        tags: { authority: 'source', writeBack: 'direct' },
      },
    });
    mockGetConnector.mockReturnValue({
      type: 'microsoft-todo',
      removeTagFromTask,
    });
    mockDb.select.mockImplementation((selection?: Record<string, unknown>) => {
      if (selection?.sourceId) {
        return chainable([{
          connectorInstanceId: 'todo-1',
          sourceId: 'list-1:task-1',
          connectorType: 'microsoft-todo',
        }]);
      }
      if (selection?.capabilities) {
        return chainable([{
          capabilities: { tags: false, tagWriteBack: false },
        }]);
      }
      if (selection?.name) {
        return chainable([{ name: 'needs-triage' }]);
      }
      return chainable([]);
    });

    const { DELETE } = await import('@/app/api/tasks/[id]/tags/route');
    const response = await DELETE(new Request(`${BASE}/api/tasks/task-1/tags`, {
      method: 'DELETE',
      body: JSON.stringify({ tagId: 'tag-needs-triage' }),
      headers: { 'Content-Type': 'application/json' },
    }), { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(removeTagFromTask).toHaveBeenCalledWith(
        'list-1:task-1',
        'needs-triage',
      );
    });
  });

  it('persists Scout tags locally without invoking connector write-back', async () => {
    mockGetCapabilities.mockResolvedValue({
      write: false,
      tagWriteBack: false,
      taskSourceModel: 'ingested',
      statusWriteBack: 'pull',
    });
    mockDb.select
      .mockReturnValueOnce(chainable([{
        connectorInstanceId: 'scout-primary',
        sourceId: 'scout:email:item-1',
        connectorType: 'scout',
      }]))
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]));

    const { POST } = await import('@/app/api/tasks/[id]/tags/route');
    const response = await POST(new Request(`${BASE}/api/tasks/task-1/tags`, {
      method: 'POST',
      body: JSON.stringify({ tags: ['follow-up'] }),
      headers: { 'Content-Type': 'application/json' },
    }), { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(200);
    expect(mockGetConnector).not.toHaveBeenCalled();
    expect(mockInitializeConnector).not.toHaveBeenCalled();
  });
});
