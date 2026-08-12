/**
 * API Route Tests - Recent Wins (GET, dismiss, settings)
 * Tests #100
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Shared DB mock (chainable) ─────────────────────────────────────────────

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy(
    {},
    {
      get(_, prop: string | symbol) {
        if (prop === 'then')
          return (resolve: (value: T) => unknown) => resolve(terminal);
        if (prop === Symbol.iterator) {
          return () =>
            (Array.isArray(terminal) ? terminal : [])[Symbol.iterator]();
        }
        return vi.fn(() => chain);
      },
    }
  );
  return chain;
}

// Store references so tests can swap return values
let selectResult: unknown[] = [];
const mockDb = {
  select: vi.fn(() => chainable(selectResult)),
  insert: vi.fn(() => chainable([])),
  update: vi.fn(() => chainable(undefined)),
  delete: vi.fn(() => chainable(undefined)),
};

vi.mock('@/db', () => ({ default: mockDb }));

vi.mock('@/db/schema', () => ({
  tasks: {
    id: 'id',
    title: 'title',
    status: 'status',
    priority: 'priority',
    completedAt: 'completedAt',
    connectorType: 'connectorType',
    sourceListName: 'sourceListName',
    dueDate: 'dueDate',
  },
  taskSchedules: {
    taskId: 'taskId',
    recurrence: 'recurrence',
  },
  appSettings: { key: 'key', value: 'value', updatedAt: 'updatedAt' },
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeWin(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Fix the thing',
    priority: overrides.priority ?? 'medium',
    completedAt: overrides.completedAt ?? new Date().toISOString(),
    connectorType: overrides.connectorType ?? 'todoist',
    sourceListName: overrides.sourceListName ?? 'Work',
    dueDate: overrides.dueDate ?? null,
    recurrence: overrides.recurrence ?? null,
  };
}

/** Configures mockDb.select so successive calls return different data.
 *  Each element in `results` is the array returned by one chained select call.
 */
function setupSelectSequence(results: unknown[][]) {
  let callIndex = 0;
  mockDb.select.mockImplementation(() => {
    const result = results[callIndex] ?? [];
    callIndex++;
    return chainable(result);
  });
}

// ─── GET /api/recent-wins ───────────────────────────────────────────────────

describe('GET /api/recent-wins', () => {
  beforeEach(() => {
    vi.resetModules();
    selectResult = [];
    mockDb.select.mockImplementation(() => chainable(selectResult));
    mockDb.insert.mockImplementation(() => chainable([]));
    mockDb.update.mockImplementation(() => chainable(undefined));
    mockDb.delete.mockImplementation(() => chainable(undefined));
  });

  it('returns empty when no completed tasks exist', async () => {
    // select 1: snooze row (none), select 2: deprioritized lists (none), select 3: tasks (none)
    setupSelectSequence([[], [], []]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.totalCount).toBe(0);
    expect(data.items).toEqual([]);
    expect(data.groups).toEqual([]);
  });

  it('returns items and groups when completed tasks exist', async () => {
    const wins = [
      makeWin({ id: 'w1', title: 'Ship feature', priority: 'high' }),
      makeWin({ id: 'w2', title: 'Fix bug', priority: 'medium' }),
      makeWin({ id: 'w3', title: 'Write docs', priority: 'low', sourceListName: 'Docs' }),
    ];
    // select 1: no snooze, select 2: no deprioritized lists, select 3: wins
    setupSelectSequence([[], [], wins]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.totalCount).toBe(3);
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    expect(data.items.length).toBeLessThanOrEqual(6);

    // Every item should have the expected shape
    for (const item of data.items) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('priority');
      expect(item).toHaveProperty('connectorType');
      expect(item).toHaveProperty('score');
      expect(item).toHaveProperty('badge');
    }

    // Groups should be present
    expect(data.groups.length).toBeGreaterThanOrEqual(1);
    for (const group of data.groups) {
      expect(group).toHaveProperty('connectorType');
      expect(group).toHaveProperty('listName');
      expect(group).toHaveProperty('count');
    }
  });

  it('returns snoozed:true when day-snooze is active', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const snoozeRow = {
      value: { type: 'day', until: tomorrow.toISOString() },
    };
    setupSelectSequence([[snoozeRow]]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.snoozed).toBe(true);
    expect(data.items).toEqual([]);
  });

  it('clears expired day-snooze and returns wins normally', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const expiredSnooze = {
      value: { type: 'day', until: yesterday.toISOString() },
    };
    const wins = [makeWin({ id: 'w1' })];
    // select 1: expired snooze, select 2: no deprioritized lists, select 3: wins
    setupSelectSequence([[expiredSnooze], [], wins]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.snoozed).toBeUndefined();
    expect(data.totalCount).toBe(1);
    // Snooze should have been deleted
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it('keeps until-noteworthy snooze when not enough new wins', async () => {
    const snoozeRow = {
      value: {
        type: 'until-noteworthy',
        minCount: 5,
        snoozedAt: new Date().toISOString(),
      },
    };
    // Only 2 wins — below the threshold of 5
    const wins = [makeWin({ id: 'w1' }), makeWin({ id: 'w2' })];
    // select 1: snooze, select 2: no deprioritized, select 3: wins
    // But the route re-reads snooze in the second check, so the first select
    // returns the snooze, then deprioritized (empty), then tasks.
    // Actually looking at the code: it reads snooze first, then if not day-snoozed
    // it reads deprioritized, then tasks, then checks snoozeRow again.
    setupSelectSequence([[snoozeRow], [], wins]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.snoozed).toBe(true);
  });

  it('deprioritizes wins from grocery/shopping lists via built-in patterns', async () => {
    const wins = [
      makeWin({ id: 'w1', title: 'Buy milk', priority: 'medium', sourceListName: 'Grocery List' }),
      makeWin({ id: 'w2', title: 'Ship v2', priority: 'high', sourceListName: 'Work' }),
    ];
    setupSelectSequence([[], [], wins]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    const data = await response.json();

    // The Work item should rank higher than the grocery item
    const workItem = data.items.find((i: { id: string }) => i.id === 'w2');
    const groceryItem = data.items.find((i: { id: string }) => i.id === 'w1');
    if (workItem && groceryItem) {
      expect(workItem.score).toBeGreaterThan(groceryItem.score);
    }
  });

  it('assigns overdue-cleared badge when completedAt > dueDate', async () => {
    const wins = [
      makeWin({
        id: 'w1',
        title: 'Late task',
        priority: 'high',
        dueDate: '2026-07-10',
        completedAt: '2026-07-15T12:00:00.000Z',
      }),
    ];
    setupSelectSequence([[], [], wins]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    const data = await response.json();
    const item = data.items.find((i: { id: string }) => i.id === 'w1');
    expect(item).toBeDefined();
    expect(item.badge).toBe('overdue cleared');
  });

  it('assigns done-early badge when completedAt is before dueDate', async () => {
    const wins = [
      makeWin({
        id: 'w1',
        title: 'Early task',
        priority: 'medium',
        dueDate: '2026-07-25',
        completedAt: '2026-07-15T12:00:00.000Z',
      }),
    ];
    setupSelectSequence([[], [], wins]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    const data = await response.json();
    const item = data.items.find((i: { id: string }) => i.id === 'w1');
    expect(item).toBeDefined();
    expect(item.badge).toBe('done early');
  });

  it('gracefully handles db errors and returns empty', async () => {
    mockDb.select.mockImplementation(() => {
      throw new Error('DB connection failed');
    });

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.totalCount).toBe(0);
    expect(data.items).toEqual([]);
  });
});

// ─── POST /api/recent-wins/dismiss ──────────────────────────────────────────

describe('POST /api/recent-wins/dismiss', () => {
  beforeEach(() => {
    vi.resetModules();
    selectResult = [];
    mockDb.select.mockImplementation(() => chainable(selectResult));
    mockDb.insert.mockImplementation(() => chainable([]));
    mockDb.update.mockImplementation(() => chainable(undefined));
    mockDb.delete.mockImplementation(() => chainable(undefined));
  });

  it('saves day-snooze setting', async () => {
    // No existing snooze row
    setupSelectSequence([[]]);

    const { POST } = await import('@/app/api/recent-wins/dismiss/route');
    const request = new Request('http://localhost/api/recent-wins/dismiss', {
      method: 'POST',
      body: JSON.stringify({ action: 'snooze-day' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('saves until-noteworthy snooze setting', async () => {
    setupSelectSequence([[]]);

    const { POST } = await import('@/app/api/recent-wins/dismiss/route');
    const request = new Request('http://localhost/api/recent-wins/dismiss', {
      method: 'POST',
      body: JSON.stringify({ action: 'snooze-until-noteworthy' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('clears snooze on clear action', async () => {
    const { POST } = await import('@/app/api/recent-wins/dismiss/route');
    const request = new Request('http://localhost/api/recent-wins/dismiss', {
      method: 'POST',
      body: JSON.stringify({ action: 'clear' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it('updates existing snooze row instead of inserting', async () => {
    setupSelectSequence([[{ key: 'recent-wins-snoozed', value: {} }]]);

    const { POST } = await import('@/app/api/recent-wins/dismiss/route');
    const request = new Request('http://localhost/api/recent-wins/dismiss', {
      method: 'POST',
      body: JSON.stringify({ action: 'snooze-day' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('rejects invalid action', async () => {
    const { POST } = await import('@/app/api/recent-wins/dismiss/route');
    const request = new Request('http://localhost/api/recent-wins/dismiss', {
      method: 'POST',
      body: JSON.stringify({ action: 'invalid-action' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid action');
  });
});

// ─── GET/PUT /api/recent-wins/settings ──────────────────────────────────────

describe('GET /api/recent-wins/settings', () => {
  beforeEach(() => {
    vi.resetModules();
    selectResult = [];
    mockDb.select.mockImplementation(() => chainable(selectResult));
  });

  it('returns empty deprioritized lists by default', async () => {
    setupSelectSequence([[]]);

    const { GET } = await import('@/app/api/recent-wins/settings/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.deprioritizedLists).toEqual([]);
  });

  it('returns stored deprioritized lists', async () => {
    const lists = ['Groceries', 'Packing'];
    setupSelectSequence([[{ value: lists }]]);

    const { GET } = await import('@/app/api/recent-wins/settings/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.deprioritizedLists).toEqual(['Groceries', 'Packing']);
  });
});

describe('PUT /api/recent-wins/settings', () => {
  beforeEach(() => {
    vi.resetModules();
    selectResult = [];
    mockDb.select.mockImplementation(() => chainable(selectResult));
    mockDb.insert.mockImplementation(() => chainable([]));
    mockDb.update.mockImplementation(() => chainable(undefined));
  });

  it('saves new deprioritized lists', async () => {
    setupSelectSequence([[]]);

    const { PUT } = await import('@/app/api/recent-wins/settings/route');
    const request = new Request('http://localhost/api/recent-wins/settings', {
      method: 'PUT',
      body: JSON.stringify({ deprioritizedLists: ['Chores'] }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PUT(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.deprioritizedLists).toEqual(['Chores']);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('updates existing deprioritized lists', async () => {
    setupSelectSequence([[{ key: 'recent-wins-deprioritized-lists', value: ['Old'] }]]);

    const { PUT } = await import('@/app/api/recent-wins/settings/route');
    const request = new Request('http://localhost/api/recent-wins/settings', {
      method: 'PUT',
      body: JSON.stringify({ deprioritizedLists: ['New'] }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PUT(request);
    expect(response.status).toBe(200);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('rejects non-array body', async () => {
    const { PUT } = await import('@/app/api/recent-wins/settings/route');
    const request = new Request('http://localhost/api/recent-wins/settings', {
      method: 'PUT',
      body: JSON.stringify({ deprioritizedLists: 'not-an-array' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PUT(request);
    expect(response.status).toBe(400);
  });

  it('rejects too many entries', async () => {
    const { PUT } = await import('@/app/api/recent-wins/settings/route');
    const bigList = Array.from({ length: 101 }, (_, i) => `List ${i}`);
    const request = new Request('http://localhost/api/recent-wins/settings', {
      method: 'PUT',
      body: JSON.stringify({ deprioritizedLists: bigList }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PUT(request);
    expect(response.status).toBe(400);
  });

  it('rejects entries with strings over 200 chars', async () => {
    const { PUT } = await import('@/app/api/recent-wins/settings/route');
    const request = new Request('http://localhost/api/recent-wins/settings', {
      method: 'PUT',
      body: JSON.stringify({ deprioritizedLists: ['x'.repeat(201)] }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PUT(request);
    expect(response.status).toBe(400);
  });
});
