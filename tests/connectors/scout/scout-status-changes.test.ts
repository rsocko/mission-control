/**
 * Scout Connector — Status Changes Endpoint Tests
 *
 * Tests the GET /api/scout/status-changes handler for:
 * - Returns Scout-originated tasks that changed since a given timestamp
 * - Filters by sourceTypes
 * - Auth validation
 * - Correct response shape
 * - Edge cases (no changes, invalid params)
 *
 * Phase 3: Status Write-Back
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockSelectResults: unknown[] = [];

function mockSelectChain(results: unknown[]) {
  const whereResult = Object.assign([...results], {
    all: vi.fn(() => results),
    orderBy: vi.fn(() => Object.assign([...results], {
      limit: vi.fn(() => results),
      all: vi.fn(() => results),
    })),
    limit: vi.fn(() => results),
  });
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => whereResult),
      all: vi.fn(() => results),
      orderBy: vi.fn(() => Object.assign([...results], {
        limit: vi.fn(() => results),
        where: vi.fn(() => whereResult),
      })),
    })),
  };
}

/**
 * The status-changes route now calls db.select twice:
 * 1. First for appSettings (write-back cursor) → returns []
 * 2. Then for tasks → returns mockSelectResults
 */
function createSelectMock() {
  let callCount = 0;
  return vi.fn(() => {
    callCount++;
    if (callCount === 1) {
      // First call: appSettings cursor lookup → no cursor
      return mockSelectChain([]);
    }
    // Second call: tasks query
    return mockSelectChain(mockSelectResults);
  });
}

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => mockSelectChain([])),
  },
}));

vi.mock('@/db/schema', () => ({
  tasks: {
    id: 'id',
    sourceId: 'source_id',
    connectorType: 'connector_type',
    title: 'title',
    status: 'status',
    statusReason: 'status_reason',
    updatedAt: 'updated_at',
    completedAt: 'completed_at',
    snoozedUntil: 'snoozed_until',
    metadata: 'metadata',
  },
  appSettings: {
    key: 'key',
    value: 'value',
    updatedAt: 'updated_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  gt: vi.fn((...args: unknown[]) => ({ op: 'gt', args })),
  asc: vi.fn((...args: unknown[]) => ({ op: 'asc', args })),
  inArray: vi.fn((...args: unknown[]) => ({ op: 'inArray', args })),
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeRequest(params: Record<string, string> = {}, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3099/api/scout/status-changes');
  for (const [key, val] of Object.entries(params)) {
    url.searchParams.set(key, val);
  }
  return new Request(url.toString(), {
    method: 'GET',
    headers: { ...headers },
  });
}

function mockTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tsk-001',
    sourceId: 'scout:email:AAMkAG-test',
    title: 'Reply to Johnson about Q3 timeline',
    status: 'done',
    statusReason: null,
    updatedAt: '2026-07-29T14:00:00Z',
    completedAt: '2026-07-29T14:00:00Z',
    snoozedUntil: null,
    metadata: JSON.stringify({ sourceType: 'email', scoutContext: { confidence: 0.9 } }),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/scout/status-changes', () => {
  let GET: (request: Request) => Promise<Response>;
  let db: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSelectResults.length = 0;

    const dbMod = await import('@/db');
    db = dbMod.default as unknown as { select: ReturnType<typeof vi.fn> };
    db.select.mockImplementation(createSelectMock());

    const mod = await import('@/app/api/scout/status-changes/route');
    GET = mod.GET;
  });

  describe('auth', () => {
    it('rejects unauthorized requests when MC_API_KEY is set', async () => {
      const originalKey = process.env.MC_API_KEY;
      process.env.MC_API_KEY = 'test-secret-key';
      try {
        const res = await GET(makeRequest());
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.error).toBe('Unauthorized');
      } finally {
        if (originalKey === undefined) delete process.env.MC_API_KEY;
        else process.env.MC_API_KEY = originalKey;
      }
    });

    it('accepts requests with valid X-MC-API-Key header', async () => {
      const originalKey = process.env.MC_API_KEY;
      process.env.MC_API_KEY = 'test-secret-key';
      try {
        const res = await GET(makeRequest({}, { 'X-MC-API-Key': 'test-secret-key' }));
        expect(res.status).toBe(200);
      } finally {
        if (originalKey === undefined) delete process.env.MC_API_KEY;
        else process.env.MC_API_KEY = originalKey;
      }
    });

    it('allows requests when no MC_API_KEY is configured', async () => {
      const originalKey = process.env.MC_API_KEY;
      delete process.env.MC_API_KEY;
      try {
        const res = await GET(makeRequest());
        expect(res.status).toBe(200);
      } finally {
        if (originalKey !== undefined) process.env.MC_API_KEY = originalKey;
      }
    });
  });

  describe('basic responses', () => {
    it('returns empty changes array when no Scout tasks exist', async () => {
      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.changes).toEqual([]);
      expect(json.count).toBe(0);
      expect(json.queriedAt).toBeTruthy();
    });

    it('returns changes for Scout-originated tasks', async () => {
      mockSelectResults.push(mockTask());
      db.select.mockImplementation(createSelectMock());

      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.count).toBe(1);
      expect(json.changes[0]).toEqual({
        mcTaskId: 'tsk-001',
        sourceId: 'scout:email:AAMkAG-test',
        sourceType: 'email',
        title: 'Reply to Johnson about Q3 timeline',
        status: 'done',
        statusReason: null,
        updatedAt: '2026-07-29T14:00:00Z',
        completedAt: '2026-07-29T14:00:00Z',
        snoozedUntil: null,
        suppressRepush: true,
      });
    });

    it('returns multiple changes across source types', async () => {
      mockSelectResults.push(
        mockTask({ id: 'tsk-001', sourceId: 'scout:email:msg-1' }),
        mockTask({
          id: 'tsk-002',
          sourceId: 'scout:teams:msg-2',
          status: 'todo',
          completedAt: null,
          snoozedUntil: '2026-08-01T09:00:00Z',
          metadata: JSON.stringify({ sourceType: 'teams' }),
        }),
        mockTask({
          id: 'tsk-003',
          sourceId: 'scout:meeting:evt-3:0',
          status: 'cancelled',
          metadata: JSON.stringify({ sourceType: 'meeting' }),
        }),
      );
      db.select.mockImplementation(createSelectMock());

      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.count).toBe(3);
      expect(json.changes[0].sourceType).toBe('email');
      expect(json.changes[1].sourceType).toBe('teams');
      expect(json.changes[1].snoozedUntil).toBe('2026-08-01T09:00:00Z');
      expect(json.changes[2].sourceType).toBe('meeting');
      expect(json.changes[2].status).toBe('cancelled');
    });

    it('returns status reasons for pull-based write-back', async () => {
      mockSelectResults.push(mockTask({
        status: 'cancelled',
        statusReason: 'no_longer_needed',
      }));
      db.select.mockImplementation(createSelectMock());

      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.changes[0]).toMatchObject({
        status: 'cancelled',
        statusReason: 'no_longer_needed',
      });
    });

    it('keeps the feed available when a task has malformed legacy metadata', async () => {
      mockSelectResults.push(mockTask({ metadata: 'not-json' }));
      db.select.mockImplementation(createSelectMock());

      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.changes[0]).toMatchObject({
        mcTaskId: 'tsk-001',
        sourceType: 'unknown',
      });
    });
  });

  describe('since parameter', () => {
    it('passes since filter to query', async () => {
      const res = await GET(makeRequest({ since: '2026-07-29T12:00:00Z' }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.since).toBe('2026-07-29T12:00:00Z');
    });

    it('returns null since when not provided', async () => {
      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.since).toBeNull();
    });

    it('rejects invalid since timestamp', async () => {
      const res = await GET(makeRequest({ since: 'not-a-date' }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Invalid "since" parameter');
    });
  });

  describe('sourceTypes filter', () => {
    it('filters changes by single sourceType', async () => {
      mockSelectResults.push(
        mockTask({ id: 'tsk-001', metadata: JSON.stringify({ sourceType: 'email' }) }),
        mockTask({ id: 'tsk-002', metadata: JSON.stringify({ sourceType: 'teams' }) }),
      );
      db.select.mockImplementation(createSelectMock());

      const res = await GET(makeRequest({ sourceTypes: 'email' }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.count).toBe(1);
      expect(json.changes[0].sourceType).toBe('email');
    });

    it('filters changes by multiple sourceTypes', async () => {
      mockSelectResults.push(
        mockTask({ id: 'tsk-001', metadata: JSON.stringify({ sourceType: 'email' }) }),
        mockTask({ id: 'tsk-002', metadata: JSON.stringify({ sourceType: 'teams' }) }),
        mockTask({ id: 'tsk-003', metadata: JSON.stringify({ sourceType: 'meeting' }) }),
      );
      db.select.mockImplementation(createSelectMock());

      const res = await GET(makeRequest({ sourceTypes: 'email,teams' }));
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.count).toBe(2);
      const types = json.changes.map((c: { sourceType: string }) => c.sourceType);
      expect(types).toContain('email');
      expect(types).toContain('teams');
      expect(types).not.toContain('meeting');
    });
  });

  describe('metadata parsing', () => {
    it('handles metadata as a pre-parsed object', async () => {
      mockSelectResults.push(
        mockTask({ metadata: { sourceType: 'planner', scoutContext: {} } }),
      );
      db.select.mockImplementation(createSelectMock());

      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.changes[0].sourceType).toBe('planner');
    });

    it('defaults sourceType to "unknown" when metadata lacks it', async () => {
      mockSelectResults.push(mockTask({ metadata: '{}' }));
      db.select.mockImplementation(createSelectMock());

      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.changes[0].sourceType).toBe('unknown');
    });
  });

  describe('response shape', () => {
    it('includes queriedAt timestamp in response', async () => {
      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json).toHaveProperty('changes');
      expect(json).toHaveProperty('count');
      expect(json).toHaveProperty('since');
      expect(json).toHaveProperty('queriedAt');
      expect(new Date(json.queriedAt).getTime()).not.toBeNaN();
    });
  });
});
