import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});
vi.mock('@/lib/utils/sqlite-date', () => {
  throw new Error('SQLite date helpers must not be evaluated');
});

const mocks = vi.hoisted(() => ({
  countTasksCompletedIn: vi.fn(),
  getWorkerPersistenceRepositories: vi.fn(),
  loggerError: vi.fn(),
}));

const kpis = {
  countTasksCompletedIn: mocks.countTasksCompletedIn,
};

mocks.getWorkerPersistenceRepositories.mockImplementation(async () => ({
  analytics: { kpis },
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: mocks.getWorkerPersistenceRepositories,
}));
vi.mock('@/lib/utils/date', () => ({
  getLocalDayBoundsISO: () => ({
    todayStart: '2026-09-05T04:00:00.000Z',
    tomorrowStart: '2026-09-06T04:00:00.000Z',
  }),
}));
vi.mock('@/lib/logger', () => ({
  default: { error: mocks.loggerError },
}));

describe('daily completions PostgreSQL parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countTasksCompletedIn.mockResolvedValue(7);
  });

  it('uses the selected analytics repository with configured local-day bounds', async () => {
    const { GET } = await import('@/app/api/daily-completions/route');

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 7 });
    expect(mocks.countTasksCompletedIn).toHaveBeenCalledWith({
      startInclusive: '2026-09-05T04:00:00.000Z',
      endExclusive: '2026-09-06T04:00:00.000Z',
    });
  });

  it('serves concurrent reads without sharing mutable route state', async () => {
    const { GET } = await import('@/app/api/daily-completions/route');

    const responses = await Promise.all(Array.from({ length: 8 }, () => GET()));

    expect(await Promise.all(responses.map((response) => response.json())))
      .toEqual(Array.from({ length: 8 }, () => ({ count: 7 })));
    expect(mocks.countTasksCompletedIn).toHaveBeenCalledTimes(8);
  });

  it('preserves the logged fail-soft response when persistence is unavailable', async () => {
    const error = new Error('PostgreSQL unavailable');
    mocks.countTasksCompletedIn.mockRejectedValue(error);
    const { GET } = await import('@/app/api/daily-completions/route');

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 0 });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      { err: error },
      'Failed to fetch daily completions',
    );
  });
});
