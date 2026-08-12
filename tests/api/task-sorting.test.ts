/**
 * Tests for PR #307 — Sort by Created Date
 * Tests for PR #295 — Dashboard sort not updating task list
 */
import { NextResponse } from 'next/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Shared DB mock ─────────────────────────────────────────────────────────

type ChainableProxy = Record<PropertyKey, unknown>;
const queryLimits: number[] = [];

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      if (prop === Symbol.iterator) {
        return () => (Array.isArray(terminal) ? terminal : [])[Symbol.iterator]();
      }
      if (prop === 'limit') {
        return vi.fn((value: number) => {
          queryLimits.push(value);
          return chain;
        });
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
    dueDate: 'due_date', connectorType: 'connector_type',
    connectorInstanceId: 'connector_instance_id', sourceListId: 'source_list_id',
    sourceListName: 'source_list_name', createdAt: 'created_at', updatedAt: 'updated_at',
    parentId: 'parent_id', assignee: 'assignee', effort: 'effort',
    snoozedUntil: 'snoozed_until',
    localDisposition: 'local_disposition',
  },
  taskTags: { taskId: 'task_id', tagId: 'tag_id' },
  taskProjects: { taskId: 'task_id', projectId: 'project_id' },
  tags: { id: 'id', name: 'name', slug: 'slug' },
  hubProjects: { id: 'id', name: 'name' },
  sourceLists: { sourceId: 'source_id', connectorInstanceId: 'connector_instance_id', name: 'name', userDisplayName: 'user_display_name' },
  connectorConfigs: { id: 'id', type: 'type', enabled: 'enabled', deletedAt: 'deleted_at' },
  myDayItems: { taskId: 'task_id', date: 'date' },
  taskSchedules: { taskId: 'task_id' },
  priorityEntities: { rank: 'rank' },
  sourceRankings: { rank: 'rank' },
  appSettings: { key: 'key', value: 'value' },
}));

vi.mock('@/lib/events', () => ({
  emitEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: { getConnector: vi.fn(), getAllConnectors: vi.fn(() => []) },
}));

vi.mock('@/lib/connectors/capabilities', () => ({
  getConnectorCapabilities: vi.fn(() => ({})),
  isConnectorEnabled: vi.fn(() => true),
}));

vi.mock('@/lib/sync', () => ({
  syncScheduler: { runSync: vi.fn(), runAll: vi.fn(), getStatus: vi.fn(() => ({})), isSyncing: vi.fn(() => false) },
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: vi.fn(() => '2026-07-20'),
  getLocalDaysFromNow: vi.fn(() => '2026-07-27'),
}));

vi.mock('@/lib/utils/resolve-task-list-names', () => ({
  buildSourceListNameMap: vi.fn(() => new Map()),
}));

vi.mock('@/lib/smart-score', () => ({
  computeBatchSmartScores: vi.fn(() => []),
}));

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/api-error', () => ({
  ApiErrors: {
    badRequest: vi.fn((msg: string) =>
      NextResponse.json({ error: msg, code: 'BAD_REQUEST' }, { status: 400 })),
    internal: vi.fn((msg: string, error?: unknown) => {
      if (error) throw error;
      return NextResponse.json({ error: msg, code: 'INTERNAL_ERROR' }, { status: 500 });
    }),
  },
}));

const BASE = 'http://localhost:3099';

beforeEach(() => {
  queryLimits.length = 0;
  mockDb.select.mockImplementation(() => chainable([]));
});

describe('GET /api/tasks — sortBy=createdAt support (PR #307)', () => {
  it('should accept sortBy=createdAt without error', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const logger = (await import('@/lib/logger')).default;
    const request = new Request(`${BASE}/api/tasks?sortBy=createdAt&sortDirection=desc`);
    const response = await GET(request);
    expect(logger.error).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it('should accept sortBy=priority (existing sort)', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const request = new Request(`${BASE}/api/tasks?sortBy=priority`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should accept sortBy=dueDate', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const request = new Request(`${BASE}/api/tasks?sortBy=dueDate&sortDirection=asc`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should accept sortBy=updated', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const request = new Request(`${BASE}/api/tasks?sortBy=updated`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should accept sortBy=title', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const request = new Request(`${BASE}/api/tasks?sortBy=title`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should accept sortBy=sourceList', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const request = new Request(`${BASE}/api/tasks?sortBy=sourceList`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should default to priority sort when no sortBy specified', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const request = new Request(`${BASE}/api/tasks`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should accept sortDirection=desc', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const request = new Request(`${BASE}/api/tasks?sortBy=createdAt&sortDirection=desc`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should return tasks structure with expected fields', async () => {
    mockDb.select.mockImplementation(() => chainable([]));

    const { GET } = await import('@/app/api/tasks/route');
    const request = new Request(`${BASE}/api/tasks?sortBy=createdAt`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('tasks');
    expect(Array.isArray(data.tasks)).toBe(true);
  });
});

describe('GET /api/tasks — sort updates task list (PR #295)', () => {
  it('should accept sortBy=smartScore', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const request = new Request(`${BASE}/api/tasks?sortBy=smartScore`);
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(queryLimits).toContain(1000);
  });

  it('should respect filter params alongside sort', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const request = new Request(`${BASE}/api/tasks?sortBy=createdAt&source=github-issues&status=todo`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should handle pagination with sort', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const request = new Request(`${BASE}/api/tasks?sortBy=createdAt&limit=10&offset=20`);
    const response = await GET(request);
    expect(response.status).toBe(200);
  });
});

describe('GET /api/tasks — bounded pagination', () => {
  it.each(['0', '201', '-1', 'NaN', 'Infinity'])('rejects limit=%s', async (limit) => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?limit=${limit}`));
    expect(response.status).toBe(400);
  });

  it('rejects smart-score offsets outside the candidate budget', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?sortBy=smartScore&offset=1000`));
    expect(response.status).toBe(400);
  });

  it('reports effective pagination values', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?limit=200&offset=10`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pagination: { limit: 200, offset: 10, maxLimit: 200 },
    });
  });
});
