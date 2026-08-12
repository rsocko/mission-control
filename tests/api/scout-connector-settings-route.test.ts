import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCOUT_SETTINGS } from '@/lib/connectors/scout/settings';

const insertValues = vi.fn((value: unknown) => {
  const result = {
    run: vi.fn(),
    returning: vi.fn(() => ({
      get: vi.fn(() => ({
        id: (value as { id?: string }).id,
      })),
    })),
  };
  return {
    ...result,
    onConflictDoNothing: vi.fn(() => result),
  };
});
const updateWhere = vi.fn();
const updateSet = vi.fn(() => ({ where: updateWhere }));
const selectResults: unknown[][] = [];

const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => selectResults.shift() || []),
    })),
  })),
  insert: vi.fn(() => ({ values: insertValues })),
  update: vi.fn(() => ({ set: updateSet })),
};

vi.mock('@/db', () => ({
  default: mockDb,
  runTransaction: vi.fn((callback: (tx: typeof mockDb) => unknown) => callback(mockDb)),
}));

vi.mock('@/db/schema', () => ({
  connectorConfigs: {
    id: 'id',
    type: 'type',
    settings: 'settings',
  },
  githubIdentityMigrations: {},
  focusItems: {},
  hubProjects: { id: 'id' },
  myDayItems: {},
  projectPhaseItems: {},
  sourceLists: {},
  syncLog: {},
  taskProjects: {},
  taskSchedules: {},
  taskTags: {},
  tasks: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  desc: vi.fn(),
  sql: vi.fn(),
  ne: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  lt: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@/lib/sync', () => ({
  syncScheduler: {
    initializeConnectorFromDb: vi.fn(),
    reconcileScheduleFromDb: vi.fn(async () => undefined),
  },
}));

describe('Scout connector settings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults.length = 0;
  });

  it('stores complete defaults for new Scout connectors', async () => {
    const { POST } = await import('@/app/api/connectors/route');
    const response = await POST(new Request('http://localhost/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'scout-primary',
        type: 'scout',
        name: 'Scout',
        settings: {},
      }),
    }));

    expect(response.status).toBe(201);
    const connectorInsert = insertValues.mock.calls.find((call: unknown[]) => {
      const value = call[0] as Record<string, unknown>;
      return value.type === 'scout';
    });

    expect(connectorInsert?.[0]).toMatchObject({
      id: 'scout-primary',
      settings: DEFAULT_SCOUT_SETTINGS,
    });
  });

  it('creates new GitHub connectors with shadow identity state atomically', async () => {
    const { POST } = await import('@/app/api/connectors/route');
    const response = await POST(new Request('http://localhost/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'github-primary',
        type: 'github-issues',
        name: 'GitHub',
        credentials: { token: 'secret' },
        settings: { repos: ['owner/repo'] },
      }),
    }));

    expect(response.status).toBe(201);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      id: 'github-primary',
      type: 'github-issues',
    }));
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      connectorInstanceId: 'github-primary',
      phase: 'shadow_write',
    }));
  });

  it('rejects GitHub connectors with an untrusted identity origin', async () => {
    const { POST } = await import('@/app/api/connectors/route');
    const response = await POST(new Request('http://localhost/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'github-insecure',
        type: 'github-issues',
        name: 'GitHub',
        settings: { apiOrigin: 'http://github.example.com/api/v3' },
      }),
    }));

    expect(response.status).toBe(400);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('rejects invalid Scout settings updates', async () => {
    selectResults.push([{ type: 'scout' }]);
    const { PATCH } = await import('@/app/api/connectors/route');
    const response = await PATCH(new Request('http://localhost/api/connectors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'scout-primary',
        settings: {
          ...DEFAULT_SCOUT_SETTINGS,
          landingMode: 'invalid',
        },
      }),
    }));

    expect(response.status).toBe(400);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('persists validated Scout settings updates', async () => {
    selectResults.push([{ type: 'scout' }]);
    const { PATCH } = await import('@/app/api/connectors/route');
    const settings = {
      ...DEFAULT_SCOUT_SETTINGS,
      landingMode: 'triage' as const,
      allowedSourceTypes: ['email', 'meeting'] as const,
    };
    const response = await PATCH(new Request('http://localhost/api/connectors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'scout-primary', settings }),
    }));

    expect(response.status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      settings: {
        ...settings,
        allowedSourceTypes: ['email', 'meeting'],
      },
    }));
  });
});
