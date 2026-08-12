/**
 * Notifications API Route Tests
 * Tests for /api/notifications, /api/notifications/bulk, /api/notifications/[id]/snooze,
 * /api/notifications/[id]/actions/[actionId]
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Chainable DB mock ──────────────────────────────────────────────────────

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      if (prop === 'run') return () => terminal;
      if (prop === Symbol.iterator) {
        return () => (Array.isArray(terminal) ? terminal : [])[Symbol.iterator]();
      }
      return vi.fn(() => chain);
    },
  });
  return chain;
}

const mockDb = {
  select: vi.fn(() => chainable([])),
  insert: vi.fn(() => chainable([])),
  update: vi.fn(() => chainable({ changes: 1 })),
  delete: vi.fn(() => chainable({ changes: 1 })),
  transaction: vi.fn(),
};
mockDb.transaction.mockImplementation((callback: (tx: typeof mockDb) => unknown) => callback(mockDb));

vi.mock('@/db', () => ({ default: mockDb }));

vi.mock('@/db/schema', () => ({
  notifications: {
    id: 'id',
    sourceId: 'sourceId',
    connectorType: 'connectorType',
    connectorInstanceId: 'connectorInstanceId',
    title: 'title',
    body: 'body',
    level: 'level',
    levelRank: 'levelRank',
    category: 'category',
    state: 'state',
    readState: 'readState',
    disposition: 'disposition',
    sourceState: 'sourceState',
    syncState: 'syncState',
    receivedAt: 'receivedAt',
    sortAt: 'sortAt',
    readAt: 'readAt',
    dismissedAt: 'dismissedAt',
    handledAt: 'handledAt',
    archivedAt: 'archivedAt',
    handledSourceActivityAt: 'handledSourceActivityAt',
    handledSourceActivityKey: 'handledSourceActivityKey',
    lastSourceActivityAt: 'lastSourceActivityAt',
    lastSourceActivityKey: 'lastSourceActivityKey',
    snoozedUntil: 'snoozedUntil',
    resolvedAt: 'resolvedAt',
    expiresAt: 'expiresAt',
    metadata: 'metadata',
    presentation: 'presentation',
    isActionable: 'isActionable',
    aiSuggestedActionId: 'aiSuggestedActionId',
    navigationTarget: 'navigationTarget',
  },
  notificationActions: {
    id: 'id',
    notificationId: 'notificationId',
    actionType: 'actionType',
    label: 'label',
    icon: 'icon',
    variant: 'variant',
    isPrimary: 'isPrimary',
    payload: 'payload',
    opensExternal: 'opensExternal',
    executionState: 'executionState',
    claimedAt: 'claimedAt',
  },
}));

vi.mock('@/lib/api-error', () => ({
  ApiErrors: {
    badRequest: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 }),
    notFound: (entity: string) => new Response(JSON.stringify({ error: `${entity} not found` }), { status: 404 }),
    internal: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 500 }),
  },
}));

vi.mock('@/lib/notifications/workflow-executor', () => ({
  executeWorkflow: vi.fn().mockResolvedValue({ success: true, workflowId: 'wf-1', response: { ok: true } }),
}));

vi.mock('@/lib/notifications/notification-writeback', () => ({
  enqueueNotificationDismissalWritebacks: vi.fn().mockResolvedValue(0),
  dismissNotificationsAndEnqueueWritebacks: vi.fn(() => ({
    updatedCount: 1,
    queuedCount: 0,
  })),
  mutateNotificationsAndEnqueueWritebacks: vi.fn((ids: string[]) => ({
    updatedCount: ids.length,
    queuedCount: ids.length,
    results: ids.map((id) => ({
      id,
      localStatus: 'updated',
      writebackStatus: 'pending',
    })),
  })),
  wakeNotificationWritebackDispatcher: vi.fn(),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/notifications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should import route module without errors', async () => {
    const routeMod = await import('@/app/api/notifications/route');
    expect(routeMod).toHaveProperty('GET');
    expect(routeMod).toHaveProperty('PATCH');
  });

  it('GET returns notifications array and stats', async () => {
    const mockNotifications = [
      { id: 'n1', title: 'Test', level: 'urgent', state: 'unread', category: 'system', receivedAt: new Date().toISOString(), sortAt: new Date().toISOString(), levelRank: 0 },
    ];
    mockDb.select.mockImplementationOnce(() => chainable(mockNotifications));
    mockDb.select.mockImplementationOnce(() => chainable([])); // actions

    const { GET } = await import('@/app/api/notifications/route');
    const req = new Request('http://localhost/api/notifications');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('notifications');
  });

  it('rejects invalid or duplicate merchant parameters before querying', async () => {
    const merchant = `merchant-v1_${'A'.repeat(43)}`;
    const { GET } = await import('@/app/api/notifications/route');
    for (const query of [
      'merchant=',
      'merchant=not-a-key',
      `merchant=${merchant}&merchant=${merchant}`,
    ]) {
      const response = await GET(new Request(`http://localhost/api/notifications?${query}`));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'merchant must be supplied once as a normalized merchant key',
      });
    }
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('restores independent lifecycle dimensions for undo', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([
      { id: 'n1', sourceState: 'active' },
    ]));
    const { PATCH } = await import('@/app/api/notifications/route');
    const response = await PATCH(new Request('http://localhost/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restore: [{
          id: 'n1',
          readState: 'unread',
          disposition: 'inbox',
          readAt: null,
          handledAt: null,
          dismissedAt: null,
          archivedAt: null,
          handledSourceActivityAt: null,
          handledSourceActivityKey: null,
        }],
      }),
    }));

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      updatedCount: 1,
    });
    expect(mockDb.update).toHaveBeenCalled();
  });
});

describe('POST /api/notifications/bulk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should import bulk route module', async () => {
    const routeMod = await import('@/app/api/notifications/bulk/route');
    expect(routeMod).toHaveProperty('POST');
  });

  it('marks every unread notification read when all is requested', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([{ id: 'n1' }]));
    const { POST } = await import('@/app/api/notifications/bulk/route');
    const req = new Request('http://localhost/api/notifications/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, action: 'mark_read' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      updatedCount: 1,
      outcome: {
        acceptedCount: 1,
        noOpCount: 0,
        failedCount: 0,
        queuedCount: 0,
      },
    });
  });

  it('counts already-read notifications as no-ops without mutating them', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'n1',
      state: 'archived',
      readState: 'read',
      disposition: 'handled',
      sourceState: 'active',
    }]));
    const { POST } = await import('@/app/api/notifications/bulk/route');
    const response = await POST(new Request('http://localhost/api/notifications/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['n1'], action: 'mark_read' }),
    }));

    await expect(response.json()).resolves.toMatchObject({
      requestedCount: 1,
      acceptedCount: 0,
      updatedCount: 0,
      noOpCount: 1,
      outcome: {
        acceptedCount: 0,
        noOpCount: 1,
      },
    });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('resolves all-matching IDs on the server instead of trusting client IDs', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([{ id: 'authorized-id' }]));
    const { POST } = await import('@/app/api/notifications/bulk/route');
    const response = await POST(new Request('http://localhost/api/notifications/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: ['client-supplied-id'],
        scope: 'all_matching',
        query: { source: 'github-issues', reason: 'review_requested' },
        action: 'archive',
      }),
    }));

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      scope: 'all_matching',
      acceptedCount: 1,
      failedCount: 0,
    });
  });

  it('enforces the existing bulk cap after server-side resolution', async () => {
    mockDb.select.mockImplementationOnce(() => chainable(
      Array.from({ length: 501 }, (_, index) => ({ id: `n-${index}` })),
    ));
    const { POST } = await import('@/app/api/notifications/bulk/route');
    const response = await POST(new Request('http://localhost/api/notifications/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'all_matching',
        query: { source: 'github-issues' },
        action: 'dismiss',
      }),
    }));

    expect(response.status).toBe(400);
  });

  it('rejects an invalid merchant in all-matching bulk scope', async () => {
    const { POST } = await import('@/app/api/notifications/bulk/route');
    const response = await POST(new Request('http://localhost/api/notifications/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'all_matching',
        query: { merchant: "' OR 1=1 --" },
        action: 'dismiss',
      }),
    }));

    expect(response.status).toBe(400);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('rejects a valid-shaped but unknown merchant in all-matching bulk scope', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([]));
    const merchant = `merchant-v1_${'Z'.repeat(43)}`;
    const { POST } = await import('@/app/api/notifications/bulk/route');
    const response = await POST(new Request('http://localhost/api/notifications/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'all_matching',
        query: { merchant },
        action: 'dismiss',
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'merchant does not match available normalized notification metadata',
    });
  });

  it('reports queued lifecycle writebacks through the shared bulk outcome', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'n1',
      readState: 'unread',
      disposition: 'inbox',
      sourceState: 'active',
      mutedAt: null,
    }]));
    const { POST } = await import('@/app/api/notifications/bulk/route');
    const response = await POST(new Request('http://localhost/api/notifications/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['n1'], action: 'mute' }),
    }));

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      action: 'mute',
      updatedCount: 1,
      acceptedCount: 1,
      noOpCount: 0,
      failedCount: 0,
      queuedCount: 1,
      outcome: {
        acceptedCount: 1,
        noOpCount: 0,
        failedCount: 0,
        queuedCount: 1,
      },
      writeback: {
        status: 'pending',
        queuedCount: 1,
      },
    });
  });

  it('counts missing explicit lifecycle selections as no-ops', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([]));
    const { POST } = await import('@/app/api/notifications/bulk/route');
    const response = await POST(new Request('http://localhost/api/notifications/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['missing'], action: 'mute' }),
    }));

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      updatedCount: 0,
      acceptedCount: 0,
      noOpCount: 1,
      failedCount: 0,
      queuedCount: 0,
    });
  });
});

describe('POST /api/notifications/[id]/snooze', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReset();
    mockDb.select.mockImplementation(() => chainable([]));
  });

  it('should import snooze route module', async () => {
    const routeMod = await import('@/app/api/notifications/[id]/snooze/route');
    expect(routeMod).toHaveProperty('POST');
  });

  it('rejects invalid duration', async () => {
    // Mock notification exists
    mockDb.select.mockImplementationOnce(() => chainable([{ id: 'n1' }]));

    const { POST } = await import('@/app/api/notifications/[id]/snooze/route');
    const req = new Request('http://localhost/api/notifications/n1/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 'invalid' }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'n1' }) });
    expect(res.status).toBe(400);
  });

  it('accepts valid duration and snoozes', async () => {
    // Mock notification found
    mockDb.select.mockImplementationOnce(() => chainable([{ id: 'n1' }]));
    // Mock read metadata
    mockDb.select.mockImplementationOnce(() => chainable([{ metadata: '{}' }]));

    const { POST } = await import('@/app/api/notifications/[id]/snooze/route');
    const req = new Request('http://localhost/api/notifications/n1/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: '1h' }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'n1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.snoozedUntil).toBeDefined();
  });

  it('returns 404 for missing notification', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([]));
    const { POST } = await import('@/app/api/notifications/[id]/snooze/route');
    const req = new Request('http://localhost/api/notifications/missing/snooze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: '1h' }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'missing' }) });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/notifications/[id]/actions/[actionId]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should import action route module', async () => {
    const routeMod = await import('@/app/api/notifications/[id]/actions/[actionId]/route');
    expect(routeMod).toHaveProperty('POST');
  });

  it('returns 404 when notification not found', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([]));

    const { POST } = await import('@/app/api/notifications/[id]/actions/[actionId]/route');
    const req = new Request('http://localhost/api/notifications/n1/actions/a1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'n1', actionId: 'a1' }) });
    expect(res.status).toBe(404);
  });

  it('handles open_url action', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'n1', title: 'Test', body: null, connectorType: 'github', category: 'social', metadata: '{}',
    }]));
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'a1', notificationId: 'n1', actionType: 'open_url', label: 'Open', payload: '{"url":"https://example.com"}',
    }]));

    const { POST } = await import('@/app/api/notifications/[id]/actions/[actionId]/route');
    const req = new Request('http://localhost/api/notifications/n1/actions/a1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'n1', actionId: 'a1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.result.type).toBe('open_url');
    expect(data.result.url).toBe('https://example.com');
  });

  it('rejects unsafe open_url protocols', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'n1', title: 'Test', body: null, connectorType: 'unknown', category: 'system', metadata: '{}',
    }]));
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'a1', notificationId: 'n1', actionType: 'open_url', label: 'Open', payload: '{"url":"javascript:alert(1)"}',
    }]));

    const { POST } = await import('@/app/api/notifications/[id]/actions/[actionId]/route');
    const req = new Request('http://localhost/api/notifications/n1/actions/a1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'n1', actionId: 'a1' }) });
    expect(res.status).toBe(400);
  });

  it.each([
    'finance',
    'finance-manager',
    'monarch-money',
  ])('rejects a stored create_task action for the %s Finance alias', async (connectorType) => {
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'n1',
      sourceId: 'finance-source',
      connectorType,
      connectorInstanceId: 'finance-instance',
      title: 'Invented Finance notice',
      body: null,
      category: 'finance',
      navigationTarget: null,
      metadata: '{}',
      presentation: '{}',
    }]));
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'a1',
      notificationId: 'n1',
      actionType: 'create_task',
      label: 'Unsafe task',
      payload: '{}',
    }]));

    const { POST } = await import('@/app/api/notifications/[id]/actions/[actionId]/route');
    const req = new Request('http://localhost/api/notifications/n1/actions/a1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'n1', actionId: 'a1' }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Finance notifications cannot create tasks',
    });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('handles run_workflow action by calling executeWorkflow', async () => {
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'n1',
      sourceId: 'source-1',
      connectorType: 'n8n',
      connectorInstanceId: 'n8n-1',
      title: 'Notification',
      body: null,
      category: 'automation',
      metadata: '{}',
    }]));
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'a1', notificationId: 'n1', actionType: 'run_workflow', label: 'Run', payload: '{"workflowId":"wf-123"}',
    }]));

    const { POST } = await import('@/app/api/notifications/[id]/actions/[actionId]/route');
    const req = new Request('http://localhost/api/notifications/n1/actions/a1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'n1', actionId: 'a1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.result.type).toBe('run_workflow');
    expect(data.result.followUpNotificationId).toEqual(expect.any(String));
    expect(mockDb.insert).toHaveBeenCalledWith(expect.objectContaining({ id: 'id' }));
  });

  it('creates an actionable retry follow-up when a workflow fails', async () => {
    const { executeWorkflow } = await import('@/lib/notifications/workflow-executor');
    vi.mocked(executeWorkflow).mockResolvedValueOnce({
      success: false,
      workflowId: 'wf-123',
      error: 'Workflow timed out',
    });
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'n1',
      sourceId: 'source-1',
      connectorType: 'n8n',
      connectorInstanceId: 'n8n-1',
      title: 'Notification',
      body: null,
      category: 'automation',
      metadata: '{}',
    }]));
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'a1',
      notificationId: 'n1',
      actionType: 'run_workflow',
      label: 'Run',
      payload: '{"workflowId":"wf-123"}',
    }]));

    const { POST } = await import('@/app/api/notifications/[id]/actions/[actionId]/route');
    const req = new Request('http://localhost/api/notifications/n1/actions/a1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'n1', actionId: 'a1' }) });
    const data = await res.json();

    expect(data.success).toBe(false);
    expect(data.result.error).toBe('Workflow timed out');
    expect(mockDb.insert).toHaveBeenCalledTimes(2);
    expect(mockDb.insert).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'id' }));
  });

  it('rejects a workflow action that has already been claimed', async () => {
    const { executeWorkflow } = await import('@/lib/notifications/workflow-executor');
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'n1',
      connectorType: 'n8n',
      title: 'Notification',
      category: 'automation',
      metadata: '{}',
    }]));
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'a1',
      notificationId: 'n1',
      actionType: 'run_workflow',
      label: 'Run',
      payload: '{"workflowId":"wf-123"}',
    }]));
    mockDb.update.mockImplementationOnce(() => chainable({ changes: 0 }));

    const { POST } = await import('@/app/api/notifications/[id]/actions/[actionId]/route');
    const req = new Request('http://localhost/api/notifications/n1/actions/a1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req, { params: Promise.resolve({ id: 'n1', actionId: 'a1' }) });
    expect(res.status).toBe(409);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('retries a workflow with the original notification context', async () => {
    const { executeWorkflow } = await import('@/lib/notifications/workflow-executor');
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'failure-result',
      connectorType: 'mission-control',
      connectorInstanceId: 'mission-control:workflow',
      title: 'Workflow failed: Original',
      category: 'automation',
      metadata: '{"parentNotificationId":"original"}',
      groupKey: 'workflow:original',
    }]));
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'retry',
      notificationId: 'failure-result',
      actionType: 'run_workflow',
      label: 'Retry workflow',
      payload: '{"workflowId":"wf-123","params":{"attempt":2}}',
    }]));
    mockDb.select.mockImplementationOnce(() => chainable([{
      id: 'original',
      connectorType: 'github',
      connectorInstanceId: 'github-1',
      title: 'Original',
      body: 'Original body',
      category: 'pr_review',
      metadata: '{"repository":"owner/repo"}',
    }]));

    const { POST } = await import('@/app/api/notifications/[id]/actions/[actionId]/route');
    const req = new Request('http://localhost/api/notifications/failure-result/actions/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req, {
      params: Promise.resolve({ id: 'failure-result', actionId: 'retry' }),
    });

    expect(res.status).toBe(200);
    expect(executeWorkflow).toHaveBeenCalledWith(
      'wf-123',
      { attempt: 2 },
      expect.objectContaining({
        notificationId: 'original',
        title: 'Original',
        connectorType: 'github',
        idempotencyKey: 'notification-action:retry',
      }),
    );
  });
});

// ─── TEMPLATE / REGISTRY UNIT TESTS ────────────────────────────────────────

describe('Notification Templates', () => {
  it('registers and retrieves built-in templates', async () => {
    const { getTemplate, getAllTemplates } = await import('@/lib/notifications/templates');
    const budgetTemplate = getTemplate('budget_exceeded');
    expect(budgetTemplate).toBeDefined();
    expect(budgetTemplate!.category).toBe('finance');
    expect(budgetTemplate!.defaultLevel).toBe('action_needed');
    expect(getAllTemplates()
      .filter((template) => template.category === 'finance')
      .flatMap((template) => template.defaultActions)
      .some((action) => action.actionType === 'create_task')).toBe(false);
    expect(getAllTemplates().length).toBeGreaterThan(10);
  });

  it('allows registering custom templates', async () => {
    const { registerTemplate, getTemplate } = await import('@/lib/notifications/templates');
    registerTemplate({
      key: 'test_custom',
      category: 'test',
      defaultLevel: 'fyi',
      categoryIcon: 'test',
      sourceDisplayMode: 'compact',
      defaultActions: [],
    });
    expect(getTemplate('test_custom')).toBeDefined();
  });

  it('omits generic task actions from registered Finance templates', async () => {
    const { registerTemplate, getTemplate } = await import('@/lib/notifications/templates');
    registerTemplate({
      key: 'test_finance_policy',
      category: 'finance',
      defaultLevel: 'action_needed',
      categoryIcon: 'test',
      sourceDisplayMode: 'compact',
      defaultActions: [
        {
          actionType: 'create_task',
          label: 'Unsafe task',
          icon: 'circle-check',
          variant: 'primary',
        },
        {
          actionType: 'navigate',
          label: 'Review Finance',
          icon: 'arrow-right',
          variant: 'secondary',
        },
      ],
    });

    expect(getTemplate('test_finance_policy')?.defaultActions.map(action => action.actionType))
      .toEqual(['navigate']);
  });
});

describe('Action Plugin Registry', () => {
  it('registers and retrieves actions', async () => {
    const { getActionDefinition, getAllRegisteredActions } = await import('@/lib/notifications/action-registry');
    expect(getActionDefinition('ha_toggle_device')).toBeDefined();
    expect(getAllRegisteredActions().length).toBeGreaterThan(3);
  });

  it('filters by connector type', async () => {
    const { getActionsForConnector } = await import('@/lib/notifications/action-registry');
    const haActions = getActionsForConnector('home-assistant');
    expect(haActions.length).toBeGreaterThanOrEqual(2);
    // Should include at least the HA-specific actions
    const haSpecific = haActions.filter(a => a.connectorTypes?.includes('home-assistant'));
    expect(haSpecific.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by category', async () => {
    const { getActionsForCategory } = await import('@/lib/notifications/action-registry');
    const financeActions = getActionsForCategory('finance');
    expect(financeActions.length).toBeGreaterThanOrEqual(1);
  });
});
