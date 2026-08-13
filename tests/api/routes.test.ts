/**
 * API Route Tests - Sync, Triage, AI paths
 * Tests #111
 */
import { describe, it, expect, vi } from 'vitest';

// ─── Shared DB mock (chainable) ─────────────────────────────────────────────

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      if (prop === Symbol.iterator) {
        return () => (Array.isArray(terminal) ? terminal : [])[Symbol.iterator]();
      }
      return vi.fn(() => chain);
    },
  });
  return chain;
}

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => chainable([])),
    insert: vi.fn(() => chainable([])),
    update: vi.fn(() => chainable(undefined)),
    delete: vi.fn(() => chainable(undefined)),
  },
  runTransaction: vi.fn(),
}));

vi.mock('@/db/schema', () => ({
  tasks: { id: 'id', title: 'title', status: 'status', priority: 'priority', dueDate: 'dueDate', updatedAt: 'updatedAt', connectorType: 'connectorType', sourceId: 'sourceId', parentId: 'parentId', assignee: 'assignee', kanbanColumn: 'kanbanColumn' },
  taskTags: { taskId: 'taskId', tagId: 'tagId' },
  taskProjects: { taskId: 'taskId', projectId: 'projectId' },
  taskSchedules: { taskId: 'taskId' },
  myDayItems: { taskId: 'taskId' },
  notifications: {
    id: 'id',
    title: 'title',
    level: 'level',
    levelRank: 'levelRank',
    connectorType: 'connectorType',
    disposition: 'disposition',
    sourceState: 'sourceState',
    snoozedUntil: 'snoozedUntil',
    readState: 'readState',
    receivedAt: 'receivedAt',
  },
  tags: {},
  sourceLists: {},
  connectorConfigs: { id: 'id', type: 'type', enabled: 'enabled', settings: 'settings', deletedAt: 'deletedAt' },
  prioritySyncLog: {},
  syncLog: {},
}));

vi.mock('@/lib/events', () => ({
  emitEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: vi.fn(),
    getAllConnectors: vi.fn(() => []),
  },
}));

vi.mock('@/lib/sync', () => ({
  syncScheduler: {
    runSync: vi.fn(() => Promise.resolve({ success: true, connectorId: 'test', errors: [] })),
    runAll: vi.fn(() => Promise.resolve([{ success: true, connectorId: 'all', errors: [] }])),
    getStatus: vi.fn(() => ({})),
    isSyncing: vi.fn(() => false),
    getActiveSyncs: vi.fn(() => []),
    initializeConnectorFromDb: vi.fn(),
    reconcileScheduleFromDb: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@/lib/sync/job-queue', () => ({
  getSyncQueueMetrics: vi.fn(() => ({
    queued: 0,
    running: 0,
    retrying: 0,
    cancelled: 0,
    oldestQueuedAgeMs: 0,
    missedSchedules: 0,
    oldestScheduleOverdueMs: 0,
    overBudget: 0,
    expiredLeases: 0,
  })),
  getSyncScheduleHealth: vi.fn(() => []),
  isDurableSyncMode: vi.fn(() => true),
  requestSyncJobCancellation: vi.fn(),
}));

vi.mock('@/lib/sync/connector-lock', () => ({
  ConnectorOperationBusyError: class ConnectorOperationBusyError extends Error {},
  runWithConnectorOperationLease: vi.fn(
    async (_id: string, _operation: string, callback: () => Promise<unknown>) => callback(),
  ),
}));

vi.mock('@/lib/telemetry/runtime', () => ({
  getRuntimeTelemetry: vi.fn(() => []),
  getRuntimeTelemetryAlertHistory: vi.fn(() => []),
  getRuntimeTelemetryInstances: vi.fn(() => []),
}));

vi.mock('@/lib/priority', () => ({
  resolveOutboundPriority: vi.fn(() => ({ shouldWrite: false, event: null })),
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: vi.fn(() => '2026-07-17'),
  getLocalDaysFromNow: vi.fn(() => '2026-07-24'),
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  syncLogger: { info: vi.fn(), error: vi.fn() },
  aiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  requestContext: { getStore: vi.fn(() => undefined) },
}));

vi.mock('@/lib/triage', () => ({
  listTriageItems: vi.fn(() => Promise.resolve({ items: [], total: 0 })),
  createTriageCapture: vi.fn(() => Promise.resolve({ id: 'triage-1', url: 'https://example.com', status: 'pending' })),
  applyTriageAction: vi.fn((id: string, action: string) => Promise.resolve({ id, status: action === 'dismiss' ? 'dismissed' : 'actioned' })),
  undoTriageAction: vi.fn((id: string) => Promise.resolve({ id, status: 'pending' })),
  isUndoableTriageAction: vi.fn((action: string) => ['complete_action', 'dismiss', 'snooze'].includes(action)),
  isValidTriageStatus: vi.fn((s: string) => ['pending', 'snoozed', 'actioned', 'dismissed', 'all'].includes(s)),
  isValidTriageSource: vi.fn((s: string) => ['reddit', 'youtube', 'github', 'web', 'all'].includes(s)),
}));

vi.mock('@/lib/ai', () => ({
  getAIRouteOutcome: vi.fn(() => ({ route: 'ollama' })),
  getResolvedAIConfig: vi.fn(() => ({ configured: true })),
  streamChat: vi.fn(() => Promise.resolve({
    result: {
      toUIMessageStreamResponse: () => new Response('streamed', { status: 200 }),
    },
    context: {
      featureId: 'houston-chat',
      sensitivity: 'restricted',
      allowedRoutes: ['ollama'],
      correlationId: 'test-correlation',
    },
  })),
}));

// ─── SYNC API ──────────────────────────────────────────────────────────────

describe('POST /api/sync', () => {
  it('should trigger sync and return results', async () => {
    const { POST } = await import('@/app/api/sync/route');
    const request = new Request('http://localhost:3099/api/sync', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('should accept optional connectorId for targeted sync', async () => {
    const { POST } = await import('@/app/api/sync/route');
    const request = new Request('http://localhost:3099/api/sync', {
      method: 'POST',
      body: JSON.stringify({ connectorId: 'test-connector', full: true }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.results).toHaveLength(1);
  });
});

describe('GET /api/sync', () => {
  it('should return sync status and history', async () => {
    const { GET } = await import('@/app/api/sync/route');
    const response = await GET(new Request('http://localhost/api/sync'));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('status');
    expect(data).toHaveProperty('isSyncing');
    expect(data.isSyncing).toBe(false);
    expect(data).toHaveProperty('activeSyncs');
    expect(data.scheduleHealth).toMatchObject({
      status: 'healthy',
      userAction: null,
    });
    expect(data).toHaveProperty('history');
  });
});

describe('connector schedule lifecycle', () => {
  it('reconciles scheduling after create and update', async () => {
    const { syncScheduler } = await import('@/lib/sync');
    const reconcile = vi.mocked(syncScheduler.reconcileScheduleFromDb);
    reconcile.mockClear();
    const connectors = await import('@/app/api/connectors/route');

    await connectors.POST(new Request('http://localhost/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'github-1',
        type: 'github-issues',
        name: 'GitHub',
      }),
    }));
    await connectors.PATCH(new Request('http://localhost/api/connectors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'github-1',
        syncMode: 'manual',
      }),
    }));

    expect(reconcile).toHaveBeenNthCalledWith(1, 'github-1');
    expect(reconcile).toHaveBeenNthCalledWith(2, 'github-1');
  });

  it('reconciles scheduling after soft and permanent deletion', async () => {
    const { syncScheduler } = await import('@/lib/sync');
    const reconcile = vi.mocked(syncScheduler.reconcileScheduleFromDb);
    reconcile.mockClear();
    const { DELETE } = await import('@/app/api/connectors/route');

    await DELETE(new Request('http://localhost/api/connectors?id=soft'));
    await DELETE(new Request('http://localhost/api/connectors?id=hard&permanent=true'));

    expect(reconcile).toHaveBeenNthCalledWith(1, 'soft');
    expect(reconcile).toHaveBeenNthCalledWith(2, 'hard');
  });
});

// ─── TRIAGE API ────────────────────────────────────────────────────────────

describe('GET /api/triage', () => {
  it('should return triage items list', async () => {
    const { GET } = await import('@/app/api/triage/route');
    const request = new Request('http://localhost:3099/api/triage?status=pending');
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('total');
  });

  it('should default invalid status to all', async () => {
    const { GET } = await import('@/app/api/triage/route');
    const request = new Request('http://localhost:3099/api/triage?status=bogus');
    const response = await GET(request);
    expect(response.status).toBe(200);
  });

  it('should pass source filter through', async () => {
    const { GET } = await import('@/app/api/triage/route');
    const request = new Request('http://localhost:3099/api/triage?source=github');
    const response = await GET(request);
    expect(response.status).toBe(200);
  });
});

describe('POST /api/triage', () => {
  it('should create a triage capture with valid url', async () => {
    const { POST } = await import('@/app/api/triage/route');
    const request = new Request('http://localhost:3099/api/triage', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/article' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data).toHaveProperty('item');
    expect(data.item.id).toBe('triage-1');
  });

  it('should return 400 when url is missing', async () => {
    const { POST } = await import('@/app/api/triage/route');
    const request = new Request('http://localhost:3099/api/triage', {
      method: 'POST',
      body: JSON.stringify({ title: 'No URL' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('url');
  });

  it('should return 400 when url is empty string', async () => {
    const { POST } = await import('@/app/api/triage/route');
    const request = new Request('http://localhost:3099/api/triage', {
      method: 'POST',
      body: JSON.stringify({ url: '' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

describe('PATCH /api/triage/[id]', () => {
  it('should apply triage action with valid actionType', async () => {
    const { PATCH } = await import('@/app/api/triage/[id]/route');
    const request = new Request('http://localhost:3099/api/triage/item-1', {
      method: 'PATCH',
      body: JSON.stringify({ actionType: 'dismiss' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: 'item-1' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('item');
  });

  it('should return 400 when actionType is missing', async () => {
    const { PATCH } = await import('@/app/api/triage/[id]/route');
    const request = new Request('http://localhost:3099/api/triage/item-1', {
      method: 'PATCH',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: 'item-1' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('actionType');
  });

  it('should undo an exact triage action', async () => {
    const { PATCH } = await import('@/app/api/triage/[id]/route');
    const request = new Request('http://localhost:3099/api/triage/item-1', {
      method: 'PATCH',
      body: JSON.stringify({
        undo: true,
        actionType: 'dismiss',
        actionId: 'action-1',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: 'item-1' }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      item: { id: 'item-1', status: 'pending' },
    });
  });

  it('should reject incomplete undo requests', async () => {
    const { PATCH } = await import('@/app/api/triage/[id]/route');
    const request = new Request('http://localhost:3099/api/triage/item-1', {
      method: 'PATCH',
      body: JSON.stringify({ undo: true, actionType: 'dismiss' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: 'item-1' }) });
    expect(response.status).toBe(400);
  });

});

// ─── AI API ────────────────────────────────────────────────────────────────

describe('POST /api/ai', () => {
  it('should stream a response for valid messages', async () => {
    const { POST } = await import('@/app/api/ai/route');
    const request = new Request('http://localhost:3099/api/ai', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
  });

  it('should return 400 when messages is missing', async () => {
    const { POST } = await import('@/app/api/ai/route');
    const request = new Request('http://localhost:3099/api/ai', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('messages');
  });

  it('should return 400 when messages is not an array', async () => {
    const { POST } = await import('@/app/api/ai/route');
    const request = new Request('http://localhost:3099/api/ai', {
      method: 'POST',
      body: JSON.stringify({ messages: 'not-an-array' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it('should return 503 when AI provider is not configured', async () => {
    const { getResolvedAIConfig } = await import('@/lib/ai');
    vi.mocked(getResolvedAIConfig).mockReturnValueOnce({ configured: false } as ReturnType<typeof getResolvedAIConfig>);

    const { POST } = await import('@/app/api/ai/route');
    const request = new Request('http://localhost:3099/api/ai', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request);
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.fallback).toBe(true);
  });
});

// ─── TASKS API (basic structure tests) ─────────────────────────────────────

describe('Tasks API route exports', () => {
  it('GET /api/tasks exports GET handler', async () => {
    const mod = await import('@/app/api/tasks/route');
    expect(mod.GET).toBeDefined();
    expect(typeof mod.GET).toBe('function');
  });

  it('PATCH /api/tasks/[id] exports PATCH handler', async () => {
    const mod = await import('@/app/api/tasks/[id]/route');
    expect(mod.PATCH).toBeDefined();
    expect(typeof mod.PATCH).toBe('function');
  });

  it('DELETE /api/tasks/[id] exports DELETE handler', async () => {
    const mod = await import('@/app/api/tasks/[id]/route');
    expect(mod.DELETE).toBeDefined();
    expect(typeof mod.DELETE).toBe('function');
  });

  it('GET /api/tasks/[id] exports GET handler', async () => {
    const mod = await import('@/app/api/tasks/[id]/route');
    expect(mod.GET).toBeDefined();
    expect(typeof mod.GET).toBe('function');
  });
});
