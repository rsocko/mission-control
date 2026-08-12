/**
 * Scout Connector — Status Changes Acknowledge & Write-Back Cursor Tests
 *
 * Tests the POST /api/scout/status-changes/ack handler for:
 * - Advances the write-back cursor in appSettings
 * - Validates acknowledgedAt parameter
 * - Auth validation
 * - Cursor is used as default `since` in GET /api/scout/status-changes
 *
 * Phase 3: Status Write-Back (F-15, F-17)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockAppSettingsStore: Record<string, { key: string; value: unknown; updatedAt: string }> = {};

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => []),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(),
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  appSettings: {
    key: 'key',
    value: 'value',
    updatedAt: 'updated_at',
  },
  tasks: {
    id: 'id',
    sourceId: 'source_id',
    connectorType: 'connector_type',
    title: 'title',
    status: 'status',
    updatedAt: 'updated_at',
    completedAt: 'completed_at',
    snoozedUntil: 'snoozed_until',
    metadata: 'metadata',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  gt: vi.fn((...args: unknown[]) => ({ op: 'gt', args })),
  asc: vi.fn((...args: unknown[]) => ({ op: 'asc', args })),
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeAckRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3099/api/scout/status-changes/ack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/scout/status-changes/ack', () => {
  let POST: (request: Request) => Promise<Response>;
  let db: {
    select: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    Object.keys(mockAppSettingsStore).forEach(k => delete mockAppSettingsStore[k]);

    const dbMod = await import('@/db');
    db = dbMod.default as unknown as typeof db;

    // Default: no existing cursor
    db.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => []),
      })),
    }));

    db.insert.mockImplementation(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(),
      })),
    }));

    db.update.mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(),
      })),
    }));

    const mod = await import('@/app/api/scout/status-changes/ack/route');
    POST = mod.POST;
  });

  describe('auth', () => {
    it('rejects unauthorized requests when MC_API_KEY is set', async () => {
      const originalKey = process.env.MC_API_KEY;
      process.env.MC_API_KEY = 'test-secret-key';
      try {
        const res = await POST(makeAckRequest({ acknowledgedAt: '2026-07-29T14:00:00Z' }));
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
        const res = await POST(makeAckRequest(
          { acknowledgedAt: '2026-07-29T14:00:00Z' },
          { 'X-MC-API-Key': 'test-secret-key' },
        ));
        expect(res.status).toBe(200);
      } finally {
        if (originalKey === undefined) delete process.env.MC_API_KEY;
        else process.env.MC_API_KEY = originalKey;
      }
    });
  });

  describe('validation', () => {
    it('rejects missing acknowledgedAt', async () => {
      const res = await POST(makeAckRequest({}));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('acknowledgedAt is required');
    });

    it('rejects invalid timestamp', async () => {
      const res = await POST(makeAckRequest({ acknowledgedAt: 'not-a-date' }));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('valid ISO timestamp');
    });

    it('rejects non-string acknowledgedAt', async () => {
      const res = await POST(makeAckRequest({ acknowledgedAt: 12345 }));
      expect(res.status).toBe(400);
    });
  });

  describe('cursor update', () => {
    it('inserts cursor when none exists', async () => {
      const onConflictMock = vi.fn();
      const insertValues = vi.fn(() => ({ onConflictDoUpdate: onConflictMock }));
      db.insert.mockImplementation(() => ({ values: insertValues }));

      const res = await POST(makeAckRequest({ acknowledgedAt: '2026-07-29T14:00:00Z' }));
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.cursor).toBe('2026-07-29T14:00:00Z');
      expect(db.insert).toHaveBeenCalled();
    });

    it('updates cursor when one already exists', async () => {
      // Mock existing cursor
      db.select.mockImplementation(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => [{ key: 'scout_write_back_synced_at', value: '2026-07-29T12:00:00Z' }]),
        })),
      }));

      const setMock = vi.fn(() => ({ where: vi.fn() }));
      db.update.mockImplementation(() => ({ set: setMock }));

      const res = await POST(makeAckRequest({ acknowledgedAt: '2026-07-29T14:00:00Z' }));
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.cursor).toBe('2026-07-29T14:00:00Z');
      expect(db.update).toHaveBeenCalled();
    });
  });
});

describe('GET /api/scout/status-changes — cursor integration', () => {
  let GET: (request: Request) => Promise<Response>;
  let db: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();

    const dbMod = await import('@/db');
    db = dbMod.default as unknown as typeof db;

    // First call: appSettings cursor lookup; second call: tasks query
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Return cursor from appSettings
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => [{ value: '2026-07-29T12:00:00Z' }]),
          })),
        };
      }
      // Return empty tasks (with orderBy/limit chain)
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => []),
            })),
          })),
        })),
      };
    });

    const mod = await import('@/app/api/scout/status-changes/route');
    GET = mod.GET;
  });

  it('uses write-back cursor as default since when no explicit since provided', async () => {
    const req = new Request('http://localhost:3099/api/scout/status-changes');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.since).toBe('2026-07-29T12:00:00Z');
    expect(json.cursorSource).toBe('write_back_cursor');
  });

  it('uses explicit since over cursor when provided', async () => {
    // With explicit since, only the tasks query is called (no cursor lookup)
    db.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => []),
          })),
        })),
      })),
    }));

    const req = new Request('http://localhost:3099/api/scout/status-changes?since=2026-07-29T15:00:00Z');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.since).toBe('2026-07-29T15:00:00Z');
    expect(json.cursorSource).toBe('explicit');
  });
});

describe('GET /api/scout/status-changes — suppressRepush flag', () => {
  let GET: (request: Request) => Promise<Response>;
  let db: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();

    const dbMod = await import('@/db');
    db = dbMod.default as unknown as typeof db;
  });

  function mockTasksQuery(tasks: unknown[]) {
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => tasks),
          })),
        })),
      })),
    };
  }

  it('marks completed tasks with suppressRepush=true', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { from: vi.fn(() => ({ where: vi.fn(() => []) })) };
      }
      return mockTasksQuery([{
        id: 'tsk-001',
        sourceId: 'scout:email:msg-1',
        title: 'Done task',
        status: 'done',
        updatedAt: '2026-07-29T14:00:00Z',
        completedAt: '2026-07-29T14:00:00Z',
        snoozedUntil: null,
        metadata: JSON.stringify({ sourceType: 'email' }),
      }]);
    });

    const mod = await import('@/app/api/scout/status-changes/route');
    const GET = mod.GET;
    const req = new Request('http://localhost:3099/api/scout/status-changes');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.changes[0].suppressRepush).toBe(true);
  });

  it('marks snoozed tasks with suppressRepush=true', async () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { from: vi.fn(() => ({ where: vi.fn(() => []) })) };
      }
      return mockTasksQuery([{
        id: 'tsk-002',
        sourceId: 'scout:teams:msg-2',
        title: 'Snoozed task',
        status: 'todo',
        updatedAt: '2026-07-29T14:00:00Z',
        completedAt: null,
        snoozedUntil: futureDate,
        metadata: JSON.stringify({ sourceType: 'teams' }),
      }]);
    });

    const mod = await import('@/app/api/scout/status-changes/route');
    const GET = mod.GET;
    const req = new Request('http://localhost:3099/api/scout/status-changes');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.changes[0].suppressRepush).toBe(true);
  });

  it('marks active todo tasks with suppressRepush=false', async () => {
    let callCount = 0;
    db.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { from: vi.fn(() => ({ where: vi.fn(() => []) })) };
      }
      return mockTasksQuery([{
        id: 'tsk-003',
        sourceId: 'scout:email:msg-3',
        title: 'Active task',
        status: 'in_progress',
        updatedAt: '2026-07-29T14:00:00Z',
        completedAt: null,
        snoozedUntil: null,
        metadata: JSON.stringify({ sourceType: 'email' }),
      }]);
    });

    const mod = await import('@/app/api/scout/status-changes/route');
    const GET = mod.GET;
    const req = new Request('http://localhost:3099/api/scout/status-changes');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.changes[0].suppressRepush).toBe(false);
  });
});
