/**
 * Tests for the subtask promote endpoint: POST /api/tasks/[id]/promote
 */
import { NextResponse } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});

describe('POST /api/tasks/[id]/promote', () => {
  it('returns 404 when task does not exist', async () => {
    mockDb.select.mockImplementation(() => chainable([]));

    const { POST } = await import('@/app/api/tasks/[id]/promote/route');
    const request = new Request(`${BASE}/api/tasks/nonexistent/promote`, { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'nonexistent' }) });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toContain('not found');
  });

  it('returns 400 when task is not a checklist item', async () => {
    mockDb.select.mockImplementation(() =>
      chainable([{
        id: 'task-1',
        isChecklistItem: false,
        parentId: null,
        depth: 0,
      }]),
    );

    const { POST } = await import('@/app/api/tasks/[id]/promote/route');
    const request = new Request(`${BASE}/api/tasks/task-1/promote`, { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('not a subtask');
  });

  it('returns 400 when task has no parentId', async () => {
    mockDb.select.mockImplementation(() =>
      chainable([{
        id: 'task-1',
        isChecklistItem: true,
        parentId: null,
        depth: 1,
      }]),
    );

    const { POST } = await import('@/app/api/tasks/[id]/promote/route');
    const request = new Request(`${BASE}/api/tasks/task-1/promote`, { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('not a subtask');
  });

  it('promotes a subtask by clearing parentId, depth, and isChecklistItem', async () => {
    mockDb.select.mockImplementation(() =>
      chainable([{
        id: 'sub-1',
        isChecklistItem: true,
        parentId: 'parent-task-1',
        depth: 1,
        connectorType: 'local',
        sourceId: 'local:sub-1',
      }]),
    );

    const setMock = vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) }));
    mockUpdate.mockReturnValue({ set: setMock });

    const { POST } = await import('@/app/api/tasks/[id]/promote/route');
    const request = new Request(`${BASE}/api/tasks/sub-1/promote`, { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'sub-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify the update was called with correct fields
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: null,
        depth: 0,
        isChecklistItem: false,
      }),
    );
  });

  it('promotes a source-backed subtask (GitHub sub-issue)', async () => {
    mockDb.select.mockImplementation(() =>
      chainable([{
        id: 'sub-gh-1',
        isChecklistItem: true,
        parentId: 'parent-gh-1',
        depth: 1,
        connectorType: 'github-issues',
        sourceId: 'github-issues:owner:repo:456',
      }]),
    );

    const setMock = vi.fn(() => ({ where: vi.fn(() => chainable(undefined)) }));
    mockUpdate.mockReturnValue({ set: setMock });

    const { POST } = await import('@/app/api/tasks/[id]/promote/route');
    const request = new Request(`${BASE}/api/tasks/sub-gh-1/promote`, { method: 'POST' });
    const response = await POST(request, { params: Promise.resolve({ id: 'sub-gh-1' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: null,
        depth: 0,
        isChecklistItem: false,
      }),
    );
  });
});
