/**
 * Tests for PR #304 — Validate sourceInstanceId and action in cross-account endpoint
 */
import { NextResponse } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      get() { return vi.fn(() => chainable([])); },
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
  tasks: { id: 'id', connectorInstanceId: 'connector_instance_id' },
  connectorConfigs: { id: 'id', type: 'type' },
}));

vi.mock('@/lib/auth', () => ({
  getValidToken: vi.fn(() => Promise.resolve('mock-token')),
}));

vi.mock('@/lib/mode', () => ({
  getTimezone: vi.fn(() => 'America/New_York'),
}));

vi.mock('@/lib/logger', () => ({
  connectorLogger: { error: vi.fn(), info: vi.fn() },
  dbLogger: { error: vi.fn() },
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
  mockDb.select.mockImplementation(() => chainable([]));
});

describe('POST /api/connectors/[id]/cross-account — validation (PR #304)', () => {
  it('should return 400 when taskId is missing', async () => {
    const { POST } = await import('@/app/api/connectors/[id]/cross-account/route');
    const request = new Request(`${BASE}/api/connectors/inst-1/cross-account`, {
      method: 'POST',
      body: JSON.stringify({ targetInstanceId: 'inst-2', action: 'copy' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('taskId');
  });

  it('should return 400 when targetInstanceId is missing', async () => {
    const { POST } = await import('@/app/api/connectors/[id]/cross-account/route');
    const request = new Request(`${BASE}/api/connectors/inst-1/cross-account`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1', action: 'copy' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(400);
  });

  it('should return 400 when action is missing', async () => {
    const { POST } = await import('@/app/api/connectors/[id]/cross-account/route');
    const request = new Request(`${BASE}/api/connectors/inst-1/cross-account`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1', targetInstanceId: 'inst-2' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(400);
  });

  it('should return 400 when action is not "copy" or "move"', async () => {
    const { POST } = await import('@/app/api/connectors/[id]/cross-account/route');
    const request = new Request(`${BASE}/api/connectors/inst-1/cross-account`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1', targetInstanceId: 'inst-2', action: 'delete' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('action');
    expect(data.error).toContain('copy');
    expect(data.error).toContain('move');
  });

  it('should return 404 when task does not belong to source connector', async () => {
    // Task lookup returns empty (task not found for this connector)
    mockDb.select.mockImplementation(() => chainable([]));

    const { POST } = await import('@/app/api/connectors/[id]/cross-account/route');
    const request = new Request(`${BASE}/api/connectors/inst-1/cross-account`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1', targetInstanceId: 'inst-2', action: 'copy' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toContain('not found');
  });

  it('should return 404 when target connector does not exist', async () => {
    // First select returns the task, second returns empty (no target connector)
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return chainable([{ id: 'task-1', connectorInstanceId: 'inst-1', title: 'Test' }]);
      }
      return chainable([]);
    });

    const { POST } = await import('@/app/api/connectors/[id]/cross-account/route');
    const request = new Request(`${BASE}/api/connectors/inst-1/cross-account`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1', targetInstanceId: 'inst-99', action: 'move' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toContain('Target connector not found');
  });

  it('should accept valid "copy" action', async () => {
    // Mock the full path: task found → connector found → Graph API success
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return chainable([{
          id: 'task-1', connectorInstanceId: 'inst-1', title: 'My Task',
          description: null, priority: 'medium', dueDate: null, metadata: '{}',
        }]);
      }
      // target connector config
      return chainable([{ id: 'inst-2', type: 'microsoft-todo' }]);
    });

    // Mock fetch for Graph API calls
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ id: 'list-1', wellknownListName: 'defaultList' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'graph-task-1' }), { status: 201 }));

    const { POST } = await import('@/app/api/connectors/[id]/cross-account/route');
    const request = new Request(`${BASE}/api/connectors/inst-1/cross-account`, {
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1', targetInstanceId: 'inst-2', action: 'copy' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'inst-1' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.action).toBe('copy');
  });
});
