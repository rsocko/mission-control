import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level coverage for the PR2 application-workflow surface that isn't
 * already exercised by tests/api/goals.test.ts, tests/api/ideation-convert.test.ts,
 * tests/api/reset-stats-timezone.test.ts, or tests/api/postgres-ai-workflows-poisoned.test.ts:
 * the dispatch route's maintenance-agent conflict handling and the resets
 * route's PATCH allowlist / upsert status-code semantics.
 */

const maintenanceMocks = vi.hoisted(() => ({
  executeMaintenanceAgent: vi.fn(async (agentType: string, _options?: { dryRun?: boolean }) => ({
    agent: agentType,
    status: 'success' as const,
    summary: 'done',
    actionsPerformed: 0,
    details: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    checkpoint: null,
    hasMore: false,
    scanned: 0,
    remainingWork: 'none' as const,
    budgets: { scanLimit: 101, mutationLimit: 100, detailLimit: 20, durationMs: 5_000 },
  })),
}));

class FakeMaintenanceAgentConflictError extends Error {
  constructor(agentType: string) {
    super(`${agentType} is already running`);
    this.name = 'MaintenanceAgentConflictError';
  }
}

vi.mock('@/lib/ai/agents', () => ({
  dispatchAgent: vi.fn(async (agentType: string, options?: { dryRun?: boolean }) => {
    if (agentType === 'conflicting-agent') {
      throw new FakeMaintenanceAgentConflictError(agentType);
    }
    return maintenanceMocks.executeMaintenanceAgent(agentType, options);
  }),
  MaintenanceAgentConflictError: FakeMaintenanceAgentConflictError,
}));

const resetsMocks = vi.hoisted(() => ({
  get: vi.fn(async () => null as unknown),
  list: vi.fn(async () => [] as unknown[]),
  upsert: vi.fn(async (input: { type: string; periodStart: string; periodEnd: string }) => ({
    id: 'reset-1',
    type: input.type,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    wentWell: null,
    needsAdjustment: null,
    notes: null,
    stats: null,
    aiSummary: null,
    staleActions: [],
    carryForwardItems: [],
    monthlyWin: null,
    monthlyChange: null,
    intentions: null,
    completedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })),
  patch: vi.fn(async (id: string) => (
    id === 'missing' ? null : {
      id,
      type: 'weekly',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-07',
      wentWell: null,
      needsAdjustment: null,
      notes: 'patched',
      stats: null,
      aiSummary: null,
      staleActions: [],
      carryForwardItems: [],
      monthlyWin: null,
      monthlyChange: null,
      intentions: null,
      completedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }
  )),
}));

vi.mock('@/lib/ai/workflow-persistence', () => ({
  getAIWorkflowPersistence: async () => ({ resets: resetsMocks }),
}));

describe('POST /api/ai/dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when agent type is missing', async () => {
    const { POST } = await import('@/app/api/ai/dispatch/route');
    const response = await POST(new Request('http://localhost/api/ai/dispatch', {
      method: 'POST',
      body: JSON.stringify({}),
    }));
    expect(response.status).toBe(400);
  });

  it('returns 400 when cursor is not a string', async () => {
    const { POST } = await import('@/app/api/ai/dispatch/route');
    const response = await POST(new Request('http://localhost/api/ai/dispatch', {
      method: 'POST',
      body: JSON.stringify({ agent: 'cleanup-done', cursor: 42 }),
    }));
    expect(response.status).toBe(400);
  });

  it('dispatches a maintenance agent and returns its bounded result', async () => {
    const { POST } = await import('@/app/api/ai/dispatch/route');
    const response = await POST(new Request('http://localhost/api/ai/dispatch', {
      method: 'POST',
      body: JSON.stringify({ agent: 'cleanup-done', dryRun: true }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('success');
  });

  it('returns 409 when the maintenance agent is already running', async () => {
    const { POST } = await import('@/app/api/ai/dispatch/route');
    const response = await POST(new Request('http://localhost/api/ai/dispatch', {
      method: 'POST',
      body: JSON.stringify({ agent: 'conflicting-agent' }),
    }));
    expect(response.status).toBe(409);
  });

  it('exports POST handler', async () => {
    const mod = await import('@/app/api/ai/dispatch/route');
    expect(typeof mod.POST).toBe('function');
  });
});

describe('resets route allowlist and status-code semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetsMocks.get.mockResolvedValue(null);
  });

  it('returns 201 when creating a new reset and 200 when one already exists', async () => {
    const { POST } = await import('@/app/api/resets/route');

    const created = await POST(new Request('http://localhost/api/resets', {
      method: 'POST',
      body: JSON.stringify({ type: 'weekly', periodStart: '2026-01-01', periodEnd: '2026-01-07' }),
    }));
    expect(created.status).toBe(201);

    resetsMocks.get.mockResolvedValueOnce({ id: 'reset-1' });
    const updated = await POST(new Request('http://localhost/api/resets', {
      method: 'POST',
      body: JSON.stringify({ type: 'weekly', periodStart: '2026-01-01', periodEnd: '2026-01-07' }),
    }));
    expect(updated.status).toBe(200);
  });

  it('only forwards allowlisted fields to the PATCH persistence method', async () => {
    const { PATCH } = await import('@/app/api/resets/route');
    const response = await PATCH(new Request('http://localhost/api/resets', {
      method: 'PATCH',
      body: JSON.stringify({
        id: 'reset-1',
        notes: 'patched',
        type: 'monthly',
        periodStart: '2099-01-01',
        createdAt: 'ignored',
      }),
    }));
    expect(response.status).toBe(200);
    expect(resetsMocks.patch).toHaveBeenCalledWith(
      'reset-1',
      { notes: 'patched' },
      expect.any(String),
    );
  });

  it('returns 404 when patching a reset that does not exist', async () => {
    const { PATCH } = await import('@/app/api/resets/route');
    const response = await PATCH(new Request('http://localhost/api/resets', {
      method: 'PATCH',
      body: JSON.stringify({ id: 'missing', notes: 'x' }),
    }));
    expect(response.status).toBe(404);
  });

  it('returns 400 when PATCH is missing an id', async () => {
    const { PATCH } = await import('@/app/api/resets/route');
    const response = await PATCH(new Request('http://localhost/api/resets', {
      method: 'PATCH',
      body: JSON.stringify({ notes: 'x' }),
    }));
    expect(response.status).toBe(400);
  });
});
