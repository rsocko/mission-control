/**
 * API Route Tests — /api/one-thing (GET, POST, DELETE)
 * Tests for issue #99
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

const repository = vi.hoisted(() => ({
  getForWeek: vi.fn(),
  markCompleted: vi.fn(async () => undefined),
  subtaskProgress: vi.fn(async () => ({ total: 0, done: 0 })),
  listCandidates: vi.fn(async () => [] as unknown[]),
  listMyDayTaskIds: vi.fn(async () => [] as string[]),
  selectAuto: vi.fn(async (): Promise<{ outcome: 'selected' | 'existing' }> => (
    { outcome: 'selected' }
  )),
  selectManual: vi.fn(async (): Promise<{ outcome: 'selected' | 'task-not-found' }> => (
    { outcome: 'selected' }
  )),
  clearForWeek: vi.fn(async () => undefined),
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    dailyPlanning: { oneThing: repository },
  }),
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

function resetRepository() {
  vi.clearAllMocks();
  repository.getForWeek.mockResolvedValue(null);
  repository.subtaskProgress.mockResolvedValue({ total: 0, done: 0 });
  repository.listCandidates.mockResolvedValue([]);
  repository.listMyDayTaskIds.mockResolvedValue([]);
  repository.selectAuto.mockResolvedValue({ outcome: 'selected' });
  repository.selectManual.mockResolvedValue({ outcome: 'selected' });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/one-thing', () => {
  beforeEach(() => {
    resetRepository();
  });

  it('returns existing one-thing for the week', async () => {
    repository.getForWeek.mockResolvedValue(makeOneThing());
    repository.subtaskProgress.mockResolvedValue({ total: 3, done: 1 });

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
    expect(repository.selectAuto).not.toHaveBeenCalled();
  });

  it('returns manual source when isManualOverride is true', async () => {
    repository.getForWeek.mockResolvedValue(makeOneThing({ isManualOverride: true }));

    const { GET } = await import('@/app/api/one-thing/route');
    const res = await GET(new Request('http://localhost/api/one-thing?date=2026-07-15'));
    const data = await res.json();

    expect(data.source).toBe('manual');
  });

  it('detects just-completed task and sets completedAt', async () => {
    repository.getForWeek.mockResolvedValue(
      makeOneThing({ status: 'done', completedAt: null }),
    );

    const { GET } = await import('@/app/api/one-thing/route');
    const res = await GET(new Request('http://localhost/api/one-thing'));
    const data = await res.json();

    expect(data.oneThing.justCompleted).toBe(true);
    expect(data.oneThing.completedAt).toBeTruthy();
    expect(repository.markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ot-abc123' }),
    );
  });

  it('auto-selects when no existing one-thing exists', async () => {
    repository.listCandidates.mockResolvedValue([
      makeTask({ id: 'task-a', priority: 'low', dueDate: null }),
      makeTask({ id: 'task-b', priority: 'critical', dueDate: '2026-07-16' }),
    ]);

    const { GET } = await import('@/app/api/one-thing/route');
    const res = await GET(new Request('http://localhost/api/one-thing?date=2026-07-15'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.source).toBe('auto');
    expect(data.oneThing).not.toBeNull();
    // Critical + near due date should score highest
    expect(data.oneThing.taskId).toBe('task-b');
    expect(repository.selectAuto).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-b', weekMonday: '2026-07-13' }),
    );
  });

  it('yields to a concurrently persisted selection instead of duplicating the week', async () => {
    repository.listCandidates.mockResolvedValue([makeTask({ id: 'task-a' })]);
    repository.selectAuto.mockResolvedValue({ outcome: 'existing' });
    repository.getForWeek
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeOneThing({ taskId: 'task-raced', isManualOverride: true }));

    const { GET } = await import('@/app/api/one-thing/route');
    const res = await GET(new Request('http://localhost/api/one-thing?date=2026-07-15'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.oneThing.taskId).toBe('task-raced');
    expect(data.source).toBe('manual');
  });

  it('returns none when there are no open tasks', async () => {
    const { GET } = await import('@/app/api/one-thing/route');
    const res = await GET(new Request('http://localhost/api/one-thing'));
    const data = await res.json();

    expect(data.oneThing).toBeNull();
    expect(data.source).toBe('none');
    expect(repository.selectAuto).not.toHaveBeenCalled();
  });
});

describe('POST /api/one-thing', () => {
  beforeEach(() => {
    resetRepository();
  });

  it('creates a manual override', async () => {
    const { POST } = await import('@/app/api/one-thing/route');
    const res = await POST(new Request('http://localhost/api/one-thing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-99' }),
    }));
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.taskId).toBe('task-99');
    expect(repository.selectManual).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-99', weekMonday: '2026-07-13' }),
    );
  });

  it('rejects when taskId is missing', async () => {
    const { POST } = await import('@/app/api/one-thing/route');
    const res = await POST(new Request('http://localhost/api/one-thing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));

    expect(res.status).toBe(400);
    expect(repository.selectManual).not.toHaveBeenCalled();
  });

  it('returns 404 when task not found', async () => {
    repository.selectManual.mockResolvedValue({ outcome: 'task-not-found' } as never);

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
    resetRepository();
  });

  it('clears the one-thing for the week', async () => {
    const { DELETE } = await import('@/app/api/one-thing/route');
    const res = await DELETE(new Request('http://localhost/api/one-thing?date=2026-07-15'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.weekMonday).toBe('2026-07-13');
    expect(repository.clearForWeek).toHaveBeenCalledWith('2026-07-13');
  });
});
