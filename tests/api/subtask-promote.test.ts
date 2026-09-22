/**
 * Tests for the subtask promote endpoint: POST /api/tasks/[id]/promote
 */
import { NextResponse } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerFakeTaskCorePersistence } from '../fixtures/task-core-fake';

// ─── Shared DB mock ──────────────────────────────────────────────────────────

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

const mockUpdate = vi.fn();
const mockGetTask = vi.fn();
const mockPromoteSubtask = vi.fn();

const mockDb = {
  select: vi.fn(() => chainable([])),
  update: mockUpdate,
};

vi.mock('@/db', () => ({
  default: mockDb,
}));

vi.mock('@/db/schema', () => ({
  tasks: { id: 'id', parentId: 'parent_id', isChecklistItem: 'is_checklist_item', depth: 'depth' },
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/api-error', () => ({
  ApiErrors: {
    notFound: vi.fn((entity: string) =>
      NextResponse.json({ error: `${entity} not found` }, { status: 404 }),
    ),
    internal: vi.fn((msg: string) =>
      NextResponse.json({ error: msg }, { status: 500 }),
    ),
  },
}));

const BASE = 'http://localhost:3099';

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockReturnValue(chainable(undefined));
  mockGetTask.mockResolvedValue(null);
  mockPromoteSubtask.mockResolvedValue({ kind: 'not-found' });
  registerFakeTaskCorePersistence({
    ancillary: {
      getTask: mockGetTask,
      promoteSubtask: mockPromoteSubtask,
    },
  });
});

describe('POST /api/tasks/[id]/promote', () => {
  it('returns 404 when task does not exist', async () => {
    mockGetTask.mockResolvedValue(null);

    const { POST } = await import('@/app/api/tasks/[id]/promote/route');
    const request = new Request(`${BASE}/api/tasks/nonexistent/promote`, { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'nonexistent' }) });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toContain('not found');
  });

  it('returns 400 when task is not a checklist item', async () => {
    mockGetTask.mockResolvedValue({
      id: 'task-1',
      isChecklistItem: false,
      parentId: null,
      depth: 0,
    });

    const { POST } = await import('@/app/api/tasks/[id]/promote/route');
    const request = new Request(`${BASE}/api/tasks/task-1/promote`, { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('not a subtask');
  });

  it('returns 400 when task has no parentId', async () => {
    mockGetTask.mockResolvedValue({
      id: 'task-1',
      isChecklistItem: true,
      parentId: null,
      depth: 1,
    });

    const { POST } = await import('@/app/api/tasks/[id]/promote/route');
    const request = new Request(`${BASE}/api/tasks/task-1/promote`, { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('not a subtask');
  });

  it('promotes a subtask by clearing parentId, depth, and isChecklistItem', async () => {
    mockGetTask.mockResolvedValue({
      id: 'sub-1',
      isChecklistItem: true,
      parentId: 'parent-task-1',
      depth: 1,
      connectorType: 'local',
      sourceId: 'local:sub-1',
      updatedAt: '2026-08-01T12:00:00Z',
    });
    mockPromoteSubtask.mockResolvedValue({
      kind: 'promoted',
      previousParentId: 'parent-task-1',
    });

    const { POST } = await import('@/app/api/tasks/[id]/promote/route');
    const request = new Request(`${BASE}/api/tasks/sub-1/promote`, { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'sub-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    expect(mockPromoteSubtask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'sub-1',
      expectedUpdatedAt: '2026-08-01T12:00:00Z',
    }));
  });

  it('promotes a source-backed subtask (GitHub sub-issue)', async () => {
    mockGetTask.mockResolvedValue({
      id: 'sub-gh-1',
      isChecklistItem: true,
      parentId: 'parent-gh-1',
      depth: 1,
      connectorType: 'github-issues',
      sourceId: 'github-issues:owner:repo:456',
      updatedAt: '2026-08-01T12:00:00Z',
    });
    mockPromoteSubtask.mockResolvedValue({
      kind: 'promoted',
      previousParentId: 'parent-gh-1',
    });

    const { POST } = await import('@/app/api/tasks/[id]/promote/route');
    const request = new Request(`${BASE}/api/tasks/sub-gh-1/promote`, { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'sub-gh-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    expect(mockPromoteSubtask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'sub-gh-1',
    }));
  });
});
