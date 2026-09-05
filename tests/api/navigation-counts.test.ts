import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

const mocks = vi.hoisted(() => ({
  counts: vi.fn(),
  getServerToday: vi.fn(() => '2026-08-16'),
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    dailyPlanning: { navigation: { counts: mocks.counts } },
  }),
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: mocks.getServerToday,
}));

function projection(overrides: {
  myDay?: number;
  triage?: number;
  quickSort?: number;
  reconciliation?: number;
  overdue?: number;
  notifications?: Partial<{
    attention: number;
    unread: number;
    urgent: number;
    actionNeeded: number;
    headsUp: number;
    fyi: number;
  }>;
}) {
  return {
    myDay: overrides.myDay ?? 0,
    triage: overrides.triage ?? 0,
    quickSort: overrides.quickSort ?? 0,
    reconciliation: overrides.reconciliation ?? 0,
    overdue: overrides.overdue ?? 0,
    notifications: {
      attention: 0,
      unread: 0,
      urgent: 0,
      actionNeeded: 0,
      headsUp: 0,
      fyi: 0,
      ...overrides.notifications,
    },
  };
}

describe('GET /api/navigation/counts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerToday.mockReturnValue('2026-08-16');
  });

  it('returns all actionable queue counts and notification severity', async () => {
    mocks.counts.mockResolvedValue(projection({
      myDay: 4,
      triage: 11,
      quickSort: 5,
      reconciliation: 3,
      overdue: 6,
      notifications: { attention: 7, unread: 9, actionNeeded: 2, headsUp: 3, fyi: 2 },
    }));

    const { GET } = await import('@/app/api/navigation/counts/route');
    const response = await GET(new Request(
      'http://localhost/api/navigation/counts?date=2026-08-16',
    ));

    expect(response.status).toBe(200);
    expect(mocks.getServerToday).not.toHaveBeenCalled();
    expect(mocks.counts).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-08-16' }),
    );
    await expect(response.json()).resolves.toEqual({
      myDay: 4,
      notifications: 2,
      triage: 11,
      quickSort: 5,
      reconciliation: 3,
      overdue: 6,
      unreadNotifications: 9,
      notificationTone: 'amber',
    });
  });

  it('counts only urgent notifications when urgent is the highest severity', async () => {
    mocks.counts.mockResolvedValue(projection({
      notifications: { attention: 7, unread: 9, urgent: 2, actionNeeded: 3, headsUp: 1, fyi: 1 },
    }));

    const { GET } = await import('@/app/api/navigation/counts/route');
    const response = await GET(new Request('http://localhost/api/navigation/counts'));

    expect(response.status).toBe(200);
    expect(mocks.getServerToday).toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      notifications: 2,
      notificationTone: 'red',
    });
  });

  it('counts only heads-up notifications above lower blue severities', async () => {
    mocks.counts.mockResolvedValue(projection({
      notifications: { attention: 6, unread: 6, headsUp: 2, fyi: 4 },
    }));

    const { GET } = await import('@/app/api/navigation/counts/route');
    const response = await GET(new Request('http://localhost/api/navigation/counts'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      notifications: 2,
      notificationTone: 'blue',
    });
  });

  it('rejects invalid browser-local dates', async () => {
    const { GET } = await import('@/app/api/navigation/counts/route');
    const response = await GET(new Request(
      'http://localhost/api/navigation/counts?date=2026-02-30',
    ));

    expect(response.status).toBe(400);
    expect(mocks.counts).not.toHaveBeenCalled();
  });

  it('fails closed when the selected persistence projection is unavailable', async () => {
    mocks.counts.mockRejectedValue(new Error('PostgreSQL unavailable'));

    const { GET } = await import('@/app/api/navigation/counts/route');
    const response = await GET(new Request('http://localhost/api/navigation/counts'));

    expect(response.status).toBe(500);
  });
});
