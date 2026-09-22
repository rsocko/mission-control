import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskCollectionRow } from '@/lib/tasks/core/contracts';
import { registerFakeTaskCorePersistence } from '../fixtures/task-core-fake';

const { readTaskCollection } = vi.hoisted(() => ({
  readTaskCollection: vi.fn(),
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: vi.fn(() => '2026-07-20'),
  getLocalDaysFromNow: vi.fn((days: number) => days < 0 ? '2026-07-13' : '2026-07-27'),
}));
vi.mock('@/lib/smart-score', () => ({
  createScoreInput: vi.fn(),
  computeBatchSmartScores: vi.fn(() => []),
}));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/api-error', () => ({
  ApiErrors: {
    badRequest: vi.fn((message: string) =>
      NextResponse.json({ error: message, code: 'BAD_REQUEST' }, { status: 400 })),
    validation: vi.fn((message: string) =>
      NextResponse.json({ error: message, code: 'VALIDATION_ERROR' }, { status: 422 })),
    internal: vi.fn((message: string) =>
      NextResponse.json({ error: message, code: 'INTERNAL_ERROR' }, { status: 500 })),
  },
}));

const EMPTY_COLLECTION = {
  rows: [],
  total: 0,
  stats: {
    totalOpen: 0,
    overdue: 0,
    dueToday: 0,
    dueThisWeek: 0,
    noDate: 0,
    highPriority: 0,
    assignedToMe: 0,
    myDay: 0,
    recentlyCreated: 0,
    recentlyClosed: 0,
    waiting: 0,
    inbox: 0,
  },
  sourceCounts: {},
  availableTags: [],
  connectorContexts: [],
  smartScore: null,
};

const BASE = 'http://localhost:3099';

function row(id: string): TaskCollectionRow {
  return {
    id,
    sourceId: `local:${id}`,
    connectorType: 'local',
    connectorInstanceId: 'local',
    title: `Task ${id}`,
    description: null,
    status: 'todo',
    localDisposition: 'active',
    priority: 'none',
    planningHorizon: null,
    dueDate: null,
    pushCount: 0,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    completedAt: null,
    recurrenceGeneratedFromTaskId: null,
    parentId: null,
    depth: 0,
    isChecklistItem: false,
    sourceListId: null,
    sourceListName: null,
    assignee: null,
    microStatus: null,
    statusReason: null,
    metadata: {},
    syncStatus: 'synced',
    lastSyncedAt: '2026-07-20T00:00:00.000Z',
    pushRetryCount: 0,
    kanbanColumn: null,
    kanbanOrder: null,
    snoozedUntil: null,
    reminderAt: null,
    reminderRelative: null,
    reminderDueTime: null,
    effort: null,
    isBulkImport: false,
    parentTitle: null,
    authoritativeSourceListName: null,
    estimatedDuration: null,
    subtaskTotal: 0,
    subtaskDone: 0,
    projectIds: [],
    projectPhaseMemberships: [],
    linkedSourceCount: 0,
    tags: [],
  };
}

beforeEach(() => {
  readTaskCollection.mockReset();
  readTaskCollection.mockResolvedValue(EMPTY_COLLECTION);
  registerFakeTaskCorePersistence({ collections: { readTaskCollection } });
});

describe('GET /api/tasks — sortBy=createdAt support (PR #307)', () => {
  it('accepts sortBy=createdAt through portable persistence', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(
      `${BASE}/api/tasks?sortBy=createdAt&sortDirection=desc`,
    ));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: expect.objectContaining({ order: { field: 'createdAt', direction: 'desc' } }),
    }));
  });

  it('accepts sortBy=completedAt through portable persistence', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(
      `${BASE}/api/tasks?sortBy=completedAt&sortDirection=desc`,
    ));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: expect.objectContaining({ order: { field: 'completedAt', direction: 'desc' } }),
    }));
  });

  it('accepts sortBy=priority', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?sortBy=priority`));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: expect.objectContaining({ order: { field: 'priority', direction: 'asc' } }),
    }));
  });

  it('accepts sortBy=dueDate', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?sortBy=dueDate`));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: expect.objectContaining({ order: { field: 'dueDate', direction: 'asc' } }),
    }));
  });

  it('accepts sortBy=updated', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?sortBy=updated`));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: expect.objectContaining({ order: { field: 'updated', direction: 'asc' } }),
    }));
  });

  it('accepts sortBy=title', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?sortBy=title`));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: expect.objectContaining({ order: { field: 'title', direction: 'asc' } }),
    }));
  });

  it('accepts sortBy=sourceList', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?sortBy=sourceList`));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: expect.objectContaining({ order: { field: 'sourceList', direction: 'asc' } }),
    }));
  });

  it('defaults to priority sort when no sortBy is specified', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks`));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: expect.objectContaining({ order: { field: 'priority', direction: 'asc' } }),
    }));
  });

  it('accepts descending sort direction', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(
      `${BASE}/api/tasks?sortBy=createdAt&sortDirection=desc`,
    ));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: expect.objectContaining({ order: { field: 'createdAt', direction: 'desc' } }),
    }));
  });

  it('returns the expected task collection response structure', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?sortBy=createdAt`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tasks: [],
      total: 0,
      stats: EMPTY_COLLECTION.stats,
      hasMore: false,
      sourceCounts: {},
      availableTags: [],
    });
  });
});

describe('GET /api/tasks — sort updates task list (PR #295)', () => {
  it('accepts smartScore and requests the bounded candidate set', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?sortBy=smartScore`));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: expect.objectContaining({ order: { field: 'smartScore', direction: 'asc' } }),
      smartScoreCandidateLimit: 1000,
    }));
  });

  it('passes filter params alongside sort through the portable spec', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(
      `${BASE}/api/tasks?sortBy=createdAt&source=github-issues&status=todo`,
    ));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      spec: expect.objectContaining({
        connectorTypes: ['github-issues'],
        statuses: ['todo'],
      }),
      page: expect.objectContaining({ order: { field: 'createdAt', direction: 'asc' } }),
    }));
  });

  it('handles pagination with sort', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(
      `${BASE}/api/tasks?sortBy=createdAt&limit=10&offset=20`,
    ));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: { order: { field: 'createdAt', direction: 'asc' }, limit: 10, offset: 20 },
    }));
  });

  it('preserves the repository stable task ID tie-break order through pagination', async () => {
    readTaskCollection.mockResolvedValue({
      ...EMPTY_COLLECTION,
      rows: [row('task-b'), row('task-c')],
      total: 3,
    });
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(
      `${BASE}/api/tasks?sortBy=priority&limit=2&offset=1`,
    ));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: { order: { field: 'priority', direction: 'asc' }, limit: 2, offset: 1 },
    }));
    const data = await response.json();
    expect(data.tasks.map((task: { id: string }) => task.id)).toEqual(['task-b', 'task-c']);
  });
});

describe('GET /api/tasks — bounded pagination', () => {
  it.each(['0', '201', '-1', 'NaN', 'Infinity'])('rejects limit=%s', async (limit) => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?limit=${limit}`));
    expect(response.status).toBe(400);
    expect(readTaskCollection).not.toHaveBeenCalled();
  });

  it('rejects smart-score offsets outside the candidate budget', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?sortBy=smartScore&offset=1000`));
    expect(response.status).toBe(400);
    expect(readTaskCollection).not.toHaveBeenCalled();
  });

  it('reports effective pagination values', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?limit=200&offset=10`));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: expect.objectContaining({ limit: 200, offset: 10 }),
    }));
    await expect(response.json()).resolves.toMatchObject({
      pagination: { limit: 200, offset: 10, maxLimit: 200 },
    });
  });

  it('defaults unknown sorts to priority while preserving pagination', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(
      `${BASE}/api/tasks?sortBy=unknown&limit=10&offset=20`,
    ));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      page: { order: { field: 'priority', direction: 'asc' }, limit: 10, offset: 20 },
    }));
  });

  it('passes collection-only filters through the portable spec', async () => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(
      `${BASE}/api/tasks?search=100%25_&effort=3&tagIds=a,b&noProject=true`,
    ));
    expect(response.status).toBe(200);
    expect(readTaskCollection).toHaveBeenCalledWith(expect.objectContaining({
      spec: expect.objectContaining({
        search: '100%_',
        effort: 3,
        tagIds: ['a', 'b'],
        noProject: true,
      }),
    }));
  });

  it.each([
    'groupBy=effort&groupValue=not-a-number',
    'groupBy=project&groupValue=not-a-project-group',
  ])('preserves the empty response for invalid group scopes: %s', async (query) => {
    const { GET } = await import('@/app/api/tasks/route');
    const response = await GET(new Request(`${BASE}/api/tasks?${query}`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tasks: [],
      total: 0,
      hasMore: false,
      sourceCounts: {},
      availableTags: [],
    });
    expect(readTaskCollection).not.toHaveBeenCalled();
  });
});
