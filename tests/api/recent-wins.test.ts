/**
 * API Route Tests - Recent Wins (GET, dismiss, settings)
 * Tests #100
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

const settings = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<unknown>>().mockResolvedValue(null),
  set: vi.fn(async () => undefined),
  delete: vi.fn(async () => true),
}));

const recentWins = vi.hoisted(() => ({
  listRecentCompletions: vi.fn(async () => [] as unknown[]),
}));

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositories: () => ({ settings }),
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    dailyPlanning: { recentWins },
  }),
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

const SNOOZE_KEY = 'recent-wins-snoozed';
const DEPRIORITIZED_KEY = 'recent-wins-deprioritized-lists';

function setupSettings(values: Record<string, unknown>) {
  settings.get.mockImplementation(async (key: string) => values[key] ?? null);
}

function resetMocks() {
  vi.clearAllMocks();
  setupSettings({});
  recentWins.listRecentCompletions.mockResolvedValue([]);
  settings.set.mockResolvedValue(undefined);
  settings.delete.mockResolvedValue(true);
}

// ─── GET /api/recent-wins ───────────────────────────────────────────────────

describe('GET /api/recent-wins', () => {
  beforeEach(resetMocks);

  it('returns empty when no completed tasks exist', async () => {
    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.totalCount).toBe(0);
    expect(data.items).toEqual([]);
    expect(data.groups).toEqual([]);
  });

  it('returns items and groups when completed tasks exist', async () => {
    recentWins.listRecentCompletions.mockResolvedValue([
      makeWin({ id: 'w1', title: 'Ship feature', priority: 'high' }),
      makeWin({ id: 'w2', title: 'Fix bug', priority: 'medium' }),
      makeWin({ id: 'w3', title: 'Write docs', priority: 'low', sourceListName: 'Docs' }),
    ]);

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
    setupSettings({ [SNOOZE_KEY]: { type: 'day', until: tomorrow.toISOString() } });

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.snoozed).toBe(true);
    expect(data.items).toEqual([]);
    expect(recentWins.listRecentCompletions).not.toHaveBeenCalled();
  });

  it('clears expired day-snooze and returns wins normally', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    setupSettings({ [SNOOZE_KEY]: { type: 'day', until: yesterday.toISOString() } });
    recentWins.listRecentCompletions.mockResolvedValue([makeWin({ id: 'w1' })]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.snoozed).toBeUndefined();
    expect(data.totalCount).toBe(1);
    // Snooze should have been deleted
    expect(settings.delete).toHaveBeenCalledWith(SNOOZE_KEY);
  });

  it('keeps until-noteworthy snooze when not enough new wins', async () => {
    setupSettings({
      [SNOOZE_KEY]: {
        type: 'until-noteworthy',
        minCount: 5,
        snoozedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    // Only 2 wins — below the threshold of 5
    recentWins.listRecentCompletions.mockResolvedValue([
      makeWin({ id: 'w1' }),
      makeWin({ id: 'w2' }),
    ]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.snoozed).toBe(true);
    expect(settings.delete).not.toHaveBeenCalled();
  });

  it('clears until-noteworthy snooze once enough new wins land', async () => {
    setupSettings({
      [SNOOZE_KEY]: {
        type: 'until-noteworthy',
        minCount: 2,
        snoozedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    recentWins.listRecentCompletions.mockResolvedValue([
      makeWin({ id: 'w1', title: 'One' }),
      makeWin({ id: 'w2', title: 'Two' }),
    ]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const data = await (await GET()).json();
    expect(data.snoozed).toBeUndefined();
    expect(settings.delete).toHaveBeenCalledWith(SNOOZE_KEY);
  });

  it('deprioritizes wins from grocery/shopping lists via built-in patterns', async () => {
    recentWins.listRecentCompletions.mockResolvedValue([
      makeWin({ id: 'w1', title: 'Buy milk', priority: 'medium', sourceListName: 'Grocery List' }),
      makeWin({ id: 'w2', title: 'Ship v2', priority: 'high', sourceListName: 'Work' }),
    ]);

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

  it('deprioritizes user-configured lists from the shared settings repository', async () => {
    setupSettings({ [DEPRIORITIZED_KEY]: ['Chores'] });
    recentWins.listRecentCompletions.mockResolvedValue([
      makeWin({ id: 'w1', title: 'Sweep', priority: 'high', sourceListName: 'Chores' }),
      makeWin({ id: 'w2', title: 'Ship v2', priority: 'high', sourceListName: 'Work' }),
    ]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const data = await (await GET()).json();
    const chores = data.items.find((i: { id: string }) => i.id === 'w1');
    const work = data.items.find((i: { id: string }) => i.id === 'w2');
    expect(work.score).toBeGreaterThan(chores.score);
  });

  it('assigns overdue-cleared badge when completedAt > dueDate', async () => {
    recentWins.listRecentCompletions.mockResolvedValue([
      makeWin({
        id: 'w1',
        title: 'Late task',
        priority: 'high',
        dueDate: '2026-07-10',
        completedAt: '2026-07-15T12:00:00.000Z',
      }),
    ]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    const data = await response.json();
    const item = data.items.find((i: { id: string }) => i.id === 'w1');
    expect(item).toBeDefined();
    expect(item.badge).toBe('overdue cleared');
  });

  it('assigns done-early badge when completedAt is before dueDate', async () => {
    recentWins.listRecentCompletions.mockResolvedValue([
      makeWin({
        id: 'w1',
        title: 'Early task',
        priority: 'medium',
        dueDate: '2026-07-25',
        completedAt: '2026-07-15T12:00:00.000Z',
      }),
    ]);

    const { GET } = await import('@/app/api/recent-wins/route');
    const response = await GET();
    const data = await response.json();
    const item = data.items.find((i: { id: string }) => i.id === 'w1');
    expect(item).toBeDefined();
    expect(item.badge).toBe('done early');
  });

  it('gracefully handles persistence errors and returns empty', async () => {
    recentWins.listRecentCompletions.mockRejectedValue(new Error('DB connection failed'));

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
  beforeEach(resetMocks);

  function dismiss(action: string) {
    return new Request('http://localhost/api/recent-wins/dismiss', {
      method: 'POST',
      body: JSON.stringify({ action }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('saves day-snooze setting', async () => {
    const { POST } = await import('@/app/api/recent-wins/dismiss/route');
    const response = await POST(dismiss('snooze-day'));
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(settings.set).toHaveBeenCalledWith(
      SNOOZE_KEY,
      expect.objectContaining({ type: 'day' }),
    );
  });

  it('saves until-noteworthy snooze setting', async () => {
    const { POST } = await import('@/app/api/recent-wins/dismiss/route');
    const response = await POST(dismiss('snooze-until-noteworthy'));
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(settings.set).toHaveBeenCalledWith(
      SNOOZE_KEY,
      expect.objectContaining({ type: 'until-noteworthy', minCount: 5 }),
    );
  });

  it('clears snooze on clear action', async () => {
    const { POST } = await import('@/app/api/recent-wins/dismiss/route');
    const response = await POST(dismiss('clear'));
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(settings.delete).toHaveBeenCalledWith(SNOOZE_KEY);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('replaces an existing snooze with one atomic upsert', async () => {
    setupSettings({ [SNOOZE_KEY]: { type: 'until-noteworthy' } });

    const { POST } = await import('@/app/api/recent-wins/dismiss/route');
    const response = await POST(dismiss('snooze-day'));
    expect(response.status).toBe(200);
    expect(settings.set).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid action', async () => {
    const { POST } = await import('@/app/api/recent-wins/dismiss/route');
    const response = await POST(dismiss('invalid-action'));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Invalid action');
    expect(settings.set).not.toHaveBeenCalled();
  });
});

// ─── GET/PUT /api/recent-wins/settings ──────────────────────────────────────

describe('GET /api/recent-wins/settings', () => {
  beforeEach(resetMocks);

  it('returns empty deprioritized lists by default', async () => {
    const { GET } = await import('@/app/api/recent-wins/settings/route');
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).deprioritizedLists).toEqual([]);
  });

  it('returns stored deprioritized lists', async () => {
    setupSettings({ [DEPRIORITIZED_KEY]: ['Groceries', 'Packing'] });

    const { GET } = await import('@/app/api/recent-wins/settings/route');
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).deprioritizedLists).toEqual(['Groceries', 'Packing']);
  });

  it('fails soft when the settings repository is unavailable', async () => {
    settings.get.mockRejectedValue(new Error('unavailable'));

    const { GET } = await import('@/app/api/recent-wins/settings/route');
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).deprioritizedLists).toEqual([]);
  });
});

describe('PUT /api/recent-wins/settings', () => {
  beforeEach(resetMocks);

  function put(body: unknown) {
    return new Request('http://localhost/api/recent-wins/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('saves new deprioritized lists', async () => {
    const { PUT } = await import('@/app/api/recent-wins/settings/route');
    const response = await PUT(put({ deprioritizedLists: ['Chores'] }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.deprioritizedLists).toEqual(['Chores']);
    expect(settings.set).toHaveBeenCalledWith(DEPRIORITIZED_KEY, ['Chores']);
  });

  it('updates existing deprioritized lists with one atomic upsert', async () => {
    setupSettings({ [DEPRIORITIZED_KEY]: ['Old'] });

    const { PUT } = await import('@/app/api/recent-wins/settings/route');
    const response = await PUT(put({ deprioritizedLists: ['New'] }));
    expect(response.status).toBe(200);
    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(settings.set).toHaveBeenCalledWith(DEPRIORITIZED_KEY, ['New']);
  });

  it('rejects non-array, oversized, and invalid entries', async () => {
    const { PUT } = await import('@/app/api/recent-wins/settings/route');
    expect((await PUT(put({ deprioritizedLists: 'nope' }))).status).toBe(400);
    expect((await PUT(put({
      deprioritizedLists: Array.from({ length: 101 }, (_, i) => `list-${i}`),
    }))).status).toBe(400);
    expect((await PUT(put({ deprioritizedLists: ['x'.repeat(201)] }))).status).toBe(400);
    expect(settings.set).not.toHaveBeenCalled();
  });
});
