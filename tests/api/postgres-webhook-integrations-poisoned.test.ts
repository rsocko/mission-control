import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WebhookIntegrationsPersistence,
} from '@/db/persistence/webhook-integrations';

/**
 * Poisoned-SQLite proof for the Layer L18 owned surface: with a
 * PostgreSQL-shaped worker composition and a `@/db`, `@/db/schema`, and
 * `better-sqlite3` that all fail closed, every handler on the eleven owned
 * webhook routes must still import and run. Any static or dynamic SQLite reach
 * fails the whole file at import time.
 */

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});
vi.mock('better-sqlite3', () => {
  throw new Error('SQLite driver must not be loaded');
});
vi.mock('drizzle-orm/better-sqlite3', () => {
  throw new Error('SQLite drizzle dialect must not be loaded');
});

const search = vi.hoisted(() => ({
  indexAlert: vi.fn(async () => {}),
  removeAlertFromIndex: vi.fn(async () => {}),
  publishSemanticEntityUpsert: vi.fn(async () => {}),
  publishSemanticEntityDelete: vi.fn(async () => {}),
}));

vi.mock('@/lib/search/fts', () => ({
  indexAlert: search.indexAlert,
  removeAlertFromIndex: search.removeAlertFromIndex,
}));
vi.mock('@/lib/semantic-index/publication-service', () => ({
  publishSemanticEntityUpsert: search.publishSemanticEntityUpsert,
  publishSemanticEntityDelete: search.publishSemanticEntityDelete,
}));

const externalAgents = vi.hoisted(() => ({
  getExternalAgent: vi.fn(async () => null),
  getDispatch: vi.fn(async () => null),
  submitDispatchResult: vi.fn(async () => ({ duplicate: false })),
}));

vi.mock('@/lib/external-agents/registry', () => ({
  getExternalAgent: externalAgents.getExternalAgent,
}));
vi.mock('@/lib/external-agents/service', () => ({
  getDispatch: externalAgents.getDispatch,
  submitDispatchResult: externalAgents.submitDispatchResult,
}));

const events = vi.hoisted(() => ({
  sendWebhookEvent: vi.fn(async () => ({ ok: true, status: 200 })),
}));

vi.mock('@/lib/events', () => ({ sendWebhookEvent: events.sendWebhookEvent }));

const dispatcher = vi.hoisted(() => ({
  wakeNotificationDeliveryDispatcher: vi.fn(),
}));

vi.mock('@/lib/notifications/dispatcher-wake', () => ({
  wakeNotificationDeliveryDispatcher: dispatcher.wakeNotificationDeliveryDispatcher,
}));

const calls = vi.hoisted(() => ({
  inboundList: vi.fn(),
  inboundCreate: vi.fn(),
  inboundUpdate: vi.fn(),
  inboundDelete: vi.fn(),
  inboundListLog: vi.fn(),
  inboundAppendLog: vi.fn(),
  inboundFindForDelivery: vi.fn(),
  inboundClaimDelivery: vi.fn(),
  inboundReleaseDelivery: vi.fn(),
  inboundRecordStats: vi.fn(),
  inboundCreateTask: vi.fn(),
  inboundCreateAlert: vi.fn(),
  outboundList: vi.fn(),
  outboundFind: vi.fn(),
  outboundCreate: vi.fn(),
  outboundUpdate: vi.fn(),
  outboundDelete: vi.fn(),
  integrationsFind: vi.fn(),
  integrationsSave: vi.fn(),
  integrationsUpdateSettings: vi.fn(),
  ingestFindConnector: vi.fn(),
  ingestFindTask: vi.fn(),
  ingestCreateTask: vi.fn(),
  ingestUpdateTask: vi.fn(),
  ingestCreateNotification: vi.fn(),
  ingestUpsertNotification: vi.fn(),
  ingestDeleteNotification: vi.fn(),
  ingestSnoozeNotification: vi.fn(),
  ingestAppendSyncLog: vi.fn(),
}));

const webhookIntegrations: WebhookIntegrationsPersistence = {
  inbound: {
    list: calls.inboundList,
    create: calls.inboundCreate,
    update: calls.inboundUpdate,
    delete: calls.inboundDelete,
    listLog: calls.inboundListLog,
    appendLog: calls.inboundAppendLog,
    findForDelivery: calls.inboundFindForDelivery,
    claimDelivery: calls.inboundClaimDelivery,
    releaseDelivery: calls.inboundReleaseDelivery,
    recordDeliveryStats: calls.inboundRecordStats,
    createTask: calls.inboundCreateTask,
    createAlert: calls.inboundCreateAlert,
  },
  outbound: {
    list: calls.outboundList,
    find: calls.outboundFind,
    create: calls.outboundCreate,
    update: calls.outboundUpdate,
    delete: calls.outboundDelete,
  },
  integrations: {
    find: calls.integrationsFind,
    save: calls.integrationsSave,
    updateSettings: calls.integrationsUpdateSettings,
  },
  ingest: {
    findConnector: calls.ingestFindConnector,
    findTaskBySourceId: calls.ingestFindTask,
    createTask: calls.ingestCreateTask,
    updateTask: calls.ingestUpdateTask,
    createNotification: calls.ingestCreateNotification,
    upsertNotificationBySource: calls.ingestUpsertNotification,
    deleteNotificationBySource: calls.ingestDeleteNotification,
    snoozeNotificationBySource: calls.ingestSnoozeNotification,
    appendSyncLog: calls.ingestAppendSyncLog,
  },
};

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({ webhookIntegrations }),
}));

const BASE = 'http://localhost:3099';
const TRUSTED = {
  host: 'localhost:3099',
  origin: BASE,
  'sec-fetch-site': 'same-origin',
} as const;

function get(url: string) {
  return new Request(`${BASE}${url}`, { headers: { ...TRUSTED } });
}

function mutate(url: string, method: string, body?: unknown) {
  return new Request(`${BASE}${url}`, {
    method,
    headers: { ...TRUSTED, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function untrusted(url: string, method: string, body?: unknown) {
  return new Request(`${BASE}${url}`, {
    method,
    headers: { host: 'localhost:3099', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const searchProjection = {
  id: 'notification-1',
  title: 'Alert',
  body: null,
  category: 'n8n',
  connectorType: 'n8n',
};

beforeEach(() => {
  for (const mock of Object.values(calls)) mock.mockReset();
  for (const mock of Object.values(search)) mock.mockClear();
  dispatcher.wakeNotificationDeliveryDispatcher.mockClear();
  events.sendWebhookEvent.mockClear();

  calls.inboundList.mockResolvedValue([]);
  calls.inboundCreate.mockResolvedValue(undefined);
  calls.inboundUpdate.mockResolvedValue('updated');
  calls.inboundDelete.mockResolvedValue('deleted');
  calls.inboundListLog.mockResolvedValue([]);
  calls.inboundAppendLog.mockResolvedValue(undefined);
  calls.inboundFindForDelivery.mockResolvedValue({
    id: 'webhook-1',
    name: 'Home Server',
    sourceLabel: 'Automation',
    secret: null,
    enabled: true,
    defaultAction: 'auto',
    fieldMappings: {},
  });
  calls.inboundClaimDelivery.mockResolvedValue(true);
  calls.inboundReleaseDelivery.mockResolvedValue(undefined);
  calls.inboundRecordStats.mockResolvedValue(undefined);
  calls.inboundCreateTask.mockResolvedValue(undefined);
  calls.inboundCreateAlert.mockResolvedValue({
    id: 'alert-1',
    created: true,
    pendingDelivery: true,
  });
  calls.outboundList.mockResolvedValue([]);
  calls.outboundFind.mockResolvedValue({
    id: 'outbound-1',
    name: 'Hook',
    url: 'https://example.test/hook',
    secret: null,
    eventTypes: ['sync.completed'],
    enabled: true,
    lastTriggeredAt: null,
    lastStatus: null,
    createdAt: '2026-09-04T12:00:00.000Z',
  });
  calls.outboundCreate.mockResolvedValue(undefined);
  calls.outboundUpdate.mockResolvedValue(undefined);
  calls.outboundDelete.mockResolvedValue(undefined);
  calls.integrationsFind.mockResolvedValue({
    id: 'n8n',
    type: 'n8n',
    name: 'n8n',
    baseUrl: 'https://n8n.test',
    apiKey: 'api-key',
    enabled: true,
    settings: { webhookSecret: 'n8n-secret', workflowCount: 2, connected: true },
    createdAt: '2026-09-04T12:00:00.000Z',
    updatedAt: '2026-09-04T12:00:00.000Z',
  });
  calls.integrationsSave.mockResolvedValue(undefined);
  calls.integrationsUpdateSettings.mockResolvedValue(undefined);
  calls.ingestFindConnector.mockResolvedValue({
    id: 'custom-rest',
    type: 'custom-rest',
    enabled: true,
    settings: { notificationTemplateKeyField: 'event_kind' },
  });
  calls.ingestFindTask.mockResolvedValue(null);
  calls.ingestCreateTask.mockResolvedValue(undefined);
  calls.ingestUpdateTask.mockResolvedValue(undefined);
  calls.ingestCreateNotification.mockResolvedValue(searchProjection);
  calls.ingestUpsertNotification.mockResolvedValue({
    id: 'notification-1',
    created: true,
    search: searchProjection,
  });
  calls.ingestDeleteNotification.mockResolvedValue('notification-1');
  calls.ingestSnoozeNotification.mockResolvedValue('notification-1');
  calls.ingestAppendSyncLog.mockResolvedValue(undefined);
});

describe('poisoned-SQLite webhook web surface', () => {
  it('serves inbound webhook listing and creation from the composed repository', async () => {
    const route = await import('@/app/api/inbound-webhooks/route');

    const listed = await route.GET();
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ webhooks: [] });

    const created = await route.POST(
      mutate('/api/inbound-webhooks', 'POST', { name: 'Home Server', secret: 'shhh' }),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      receiveUrl: expect.stringContaining('/receive'),
    });
    expect(calls.inboundCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Home Server',
      secret: 'shhh',
      defaultAction: 'auto',
    }));
  });

  it('keeps trusted-mutation authentication on inbound webhook writes', async () => {
    const collection = await import('@/app/api/inbound-webhooks/route');
    const detail = await import('@/app/api/inbound-webhooks/[id]/route');

    expect((await collection.POST(
      untrusted('/api/inbound-webhooks', 'POST', { name: 'Nope' }),
    )).status).toBe(401);
    expect((await detail.PATCH(
      untrusted('/api/inbound-webhooks/webhook-1', 'PATCH', { name: 'Nope' }),
      { params: Promise.resolve({ id: 'webhook-1' }) },
    )).status).toBe(401);
    expect((await detail.DELETE(
      untrusted('/api/inbound-webhooks/webhook-1', 'DELETE'),
      { params: Promise.resolve({ id: 'webhook-1' }) },
    )).status).toBe(401);
    expect(calls.inboundCreate).not.toHaveBeenCalled();
    expect(calls.inboundUpdate).not.toHaveBeenCalled();
    expect(calls.inboundDelete).not.toHaveBeenCalled();
  });

  it('maps the inbound webhook patch and delete conflict outcomes', async () => {
    const route = await import('@/app/api/inbound-webhooks/[id]/route');

    const patched = await route.PATCH(
      mutate('/api/inbound-webhooks/webhook-1', 'PATCH', { secret: '  ', enabled: false }),
      { params: Promise.resolve({ id: 'webhook-1' }) },
    );
    expect(patched.status).toBe(200);
    expect(calls.inboundUpdate).toHaveBeenCalledWith(expect.objectContaining({
      id: 'webhook-1',
      patch: { secret: null, enabled: false },
    }));

    calls.inboundUpdate.mockResolvedValue('secret-referenced');
    expect((await route.PATCH(
      mutate('/api/inbound-webhooks/webhook-1', 'PATCH', { secret: '' }),
      { params: Promise.resolve({ id: 'webhook-1' }) },
    )).status).toBe(409);

    expect((await route.DELETE(
      mutate('/api/inbound-webhooks/webhook-1', 'DELETE'),
      { params: Promise.resolve({ id: 'webhook-1' }) },
    )).status).toBe(200);

    calls.inboundDelete.mockResolvedValue('agent-referenced');
    expect((await route.DELETE(
      mutate('/api/inbound-webhooks/webhook-1', 'DELETE'),
      { params: Promise.resolve({ id: 'webhook-1' }) },
    )).status).toBe(409);
  });

  it('serves the bounded delivery log from the composed repository', async () => {
    const route = await import('@/app/api/inbound-webhooks/[id]/log/route');

    const response = await route.GET(
      get('/api/inbound-webhooks/webhook-1/log?limit=500'),
      { params: Promise.resolve({ id: 'webhook-1' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [] });
    expect(calls.inboundListLog).toHaveBeenCalledWith({ webhookId: 'webhook-1', limit: 100 });
  });

  it('receives an unsigned alert delivery end to end without SQLite', async () => {
    const route = await import('@/app/api/inbound-webhooks/[id]/receive/route');

    const response = await route.POST(
      mutate('/api/inbound-webhooks/webhook-1/receive', 'POST', {
        severity: 'urgent',
        title: 'Garage door open',
        actionUrl: 'https://example.test/open',
      }),
      { params: Promise.resolve({ id: 'webhook-1' }) },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ success: true, created: 'alert' });
    expect(calls.inboundClaimDelivery).toHaveBeenCalledWith(expect.objectContaining({
      webhookId: 'webhook-1',
      deliveryKey: expect.stringMatching(/^payload:[a-f0-9]{64}$/),
    }));
    expect(calls.inboundCreateAlert).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({ payload: { url: 'https://example.test/open' } }),
    }));
    expect(calls.inboundRecordStats).toHaveBeenCalledWith(expect.objectContaining({
      lastStatus: 201,
    }));
    expect(calls.inboundAppendLog).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ status: 'success', httpStatus: 201 }),
    }));
    expect(dispatcher.wakeNotificationDeliveryDispatcher).toHaveBeenCalled();
  });

  it('rejects an unknown endpoint, a disabled endpoint, and a replayed delivery', async () => {
    const route = await import('@/app/api/inbound-webhooks/[id]/receive/route');

    calls.inboundFindForDelivery.mockResolvedValue(null);
    expect((await route.POST(
      mutate('/api/inbound-webhooks/missing/receive', 'POST', { title: 'x' }),
      { params: Promise.resolve({ id: 'missing' }) },
    )).status).toBe(404);

    calls.inboundFindForDelivery.mockResolvedValue({
      id: 'webhook-2',
      name: 'Disabled',
      sourceLabel: 'Automation',
      secret: null,
      enabled: false,
      defaultAction: 'auto',
      fieldMappings: {},
    });
    expect((await route.POST(
      mutate('/api/inbound-webhooks/webhook-2/receive', 'POST', { title: 'x' }),
      { params: Promise.resolve({ id: 'webhook-2' }) },
    )).status).toBe(403);
    expect(calls.inboundAppendLog).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ status: 'auth_failed', httpStatus: 403 }),
    }));

    calls.inboundFindForDelivery.mockResolvedValue({
      id: 'webhook-3',
      name: 'Home Server',
      sourceLabel: 'Automation',
      secret: null,
      enabled: true,
      defaultAction: 'task',
      fieldMappings: {},
    });
    calls.inboundClaimDelivery.mockResolvedValue(false);
    const duplicate = await route.POST(
      mutate('/api/inbound-webhooks/webhook-3/receive', 'POST', { title: 'x' }),
      { params: Promise.resolve({ id: 'webhook-3' }) },
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ success: true, duplicate: true });
    expect(calls.inboundCreateTask).not.toHaveBeenCalled();
  });

  it('rejects a signed delivery whose signature does not verify', async () => {
    const route = await import('@/app/api/inbound-webhooks/[id]/receive/route');
    calls.inboundFindForDelivery.mockResolvedValue({
      id: 'webhook-4',
      name: 'Signed',
      sourceLabel: 'Automation',
      secret: 'shhh',
      enabled: true,
      defaultAction: 'task',
      fieldMappings: {},
    });

    const missing = await route.POST(
      mutate('/api/inbound-webhooks/webhook-4/receive', 'POST', { title: 'x' }),
      { params: Promise.resolve({ id: 'webhook-4' }) },
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Missing signature' });

    const wrong = await route.POST(
      new Request(`${BASE}/api/inbound-webhooks/webhook-4/receive`, {
        method: 'POST',
        headers: { ...TRUSTED, 'x-webhook-signature': `sha256=${'0'.repeat(64)}` },
        body: JSON.stringify({ title: 'x' }),
      }),
      { params: Promise.resolve({ id: 'webhook-4' }) },
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'Invalid signature' });
    expect(calls.inboundClaimDelivery).not.toHaveBeenCalled();
  });

  it('serves the n8n configuration read, save, and connectivity test', async () => {
    const route = await import('@/app/api/integrations/n8n/route');

    const read = await route.GET();
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      baseUrl: 'https://n8n.test',
      enabled: true,
      workflowCount: 2,
      connected: true,
    });

    const saved = await route.POST(
      mutate('/api/integrations/n8n', 'POST', {
        baseUrl: 'https://n8n2.test',
        apiKey: 'key',
        webhookSecret: 'rotated',
      }),
    );
    expect(saved.status).toBe(200);
    expect(calls.integrationsSave).toHaveBeenCalledWith(expect.objectContaining({
      id: 'n8n',
      baseUrl: 'https://n8n2.test',
      settings: expect.objectContaining({ webhookSecret: 'rotated' }),
    }));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }), {
        status: 200,
      }),
    );
    try {
      const tested = await route.PUT();
      expect(tested.status).toBe(200);
      expect(await tested.json()).toEqual({ success: true, workflowCount: 3 });
      expect(fetchSpy).toHaveBeenCalled();
      expect(calls.integrationsUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({
        settings: expect.objectContaining({ connected: true, workflowCount: 3 }),
      }));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('records an n8n connectivity failure without SQLite', async () => {
    const route = await import('@/app/api/integrations/n8n/route');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    try {
      const response = await route.PUT();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: false, error: 'boom' });
      expect(calls.integrationsUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({
        settings: expect.objectContaining({ connected: false, lastError: 'boom' }),
      }));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('ingests n8n task and alert webhooks and reindexes through the neutral seam', async () => {
    const route = await import('@/app/api/integrations/n8n/webhook/route');

    const unauthorized = await route.POST(
      mutate('/api/integrations/n8n/webhook', 'POST', { type: 'task.create' }),
    );
    expect(unauthorized.status).toBe(401);

    const signed = (body: unknown) => new Request(`${BASE}/api/integrations/n8n/webhook`, {
      method: 'POST',
      headers: { ...TRUSTED, 'X-N8N-Secret': 'n8n-secret' },
      body: JSON.stringify(body),
    });

    const task = await route.POST(signed({ type: 'task.create', payload: { title: 'T' } }));
    expect(task.status).toBe(201);
    expect(calls.ingestCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      connectorType: 'n8n',
      title: 'T',
    }));

    const alert = await route.POST(signed({
      type: 'alert.create',
      payload: { title: 'A', actionUrl: 'https://example.test/a' },
    }));
    expect(alert.status).toBe(201);
    expect(calls.ingestCreateNotification).toHaveBeenCalledWith(expect.objectContaining({
      openUrlAction: { url: 'https://example.test/a', label: 'Open' },
    }));
    expect(search.indexAlert).toHaveBeenCalledWith(searchProjection);
    expect(search.publishSemanticEntityUpsert).toHaveBeenCalledWith('alert', 'notification-1');

    const shipment = await route.POST(signed({
      type: 'shipment.update',
      payload: { shipmentId: 'ship-1' },
    }));
    expect(shipment.status).toBe(201);
    expect(calls.ingestUpsertNotification).toHaveBeenCalledWith(expect.objectContaining({
      match: { connectorType: 'n8n', sourceId: 'ship-1' },
    }));

    const unsupported = await route.POST(signed({ type: 'nope' }));
    expect(unsupported.status).toBe(400);
  });

  it('serves the RyMessage lifecycle receiver without SQLite', async () => {
    const route = await import('@/app/api/integrations/rymessage/route');

    const info = await route.GET();
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ authRequired: false });

    const created = await route.POST(mutate('/api/integrations/rymessage', 'POST', {
      event: 'action.created',
      action: { id: 'a-1', stableKey: 'k-1', chatGuid: 'c', title: 'Reply needed' },
    }));
    expect(created.status).toBe(201);
    expect(calls.ingestUpsertNotification).toHaveBeenCalledWith(expect.objectContaining({
      match: { connectorType: 'rymessage', sourceId: 'rymessage:k-1' },
    }));
    expect(search.indexAlert).toHaveBeenCalled();

    calls.ingestUpsertNotification.mockResolvedValue({
      id: 'notification-1',
      created: false,
      search: searchProjection,
    });
    const updated = await route.POST(mutate('/api/integrations/rymessage', 'POST', {
      event: 'action.updated',
      action: { id: 'a-1', stableKey: 'k-1', chatGuid: 'c', title: 'Reply needed' },
    }));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ action: 'updated' });

    const dismissed = await route.POST(mutate('/api/integrations/rymessage', 'POST', {
      event: 'action.dismissed',
      action: { id: 'a-1', stableKey: 'k-1', chatGuid: 'c', title: 'Reply needed' },
    }));
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toMatchObject({ action: 'deleted' });
    expect(search.removeAlertFromIndex).toHaveBeenCalledWith('notification-1');
    expect(search.publishSemanticEntityDelete).toHaveBeenCalledWith('alert', 'notification-1');

    const snoozed = await route.POST(mutate('/api/integrations/rymessage', 'POST', {
      event: 'action.snoozed',
      action: { id: 'a-1', stableKey: 'k-1', chatGuid: 'c', title: 'x', snoozedUntil: 1 },
    }));
    expect(snoozed.status).toBe(200);
    expect(calls.ingestSnoozeNotification).toHaveBeenCalled();

    const unsupported = await route.POST(mutate('/api/integrations/rymessage', 'POST', {
      event: 'action.exploded',
      action: { id: 'a-1', stableKey: 'k-1', chatGuid: 'c', title: 'x' },
    }));
    expect(unsupported.status).toBe(400);
  });

  it('serves outbound webhook configuration and the outbound test send', async () => {
    const collection = await import('@/app/api/integrations/webhooks/route');
    const detail = await import('@/app/api/integrations/webhooks/[id]/route');
    const test = await import('@/app/api/integrations/webhooks/[id]/test/route');

    const listed = await collection.GET();
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ webhooks: [] });

    const created = await collection.POST(mutate('/api/integrations/webhooks', 'POST', {
      name: 'Hook',
      url: 'https://example.test/hook',
      eventTypes: ['sync.completed'],
    }));
    expect(created.status).toBe(201);
    expect(calls.outboundCreate).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.test/hook',
      eventTypes: ['sync.completed'],
    }));

    const invalid = await collection.POST(mutate('/api/integrations/webhooks', 'POST', {
      name: 'Hook',
      url: 'not a url',
      eventTypes: ['sync.completed'],
    }));
    expect(invalid.status).toBe(400);

    const patched = await detail.PATCH(
      mutate('/api/integrations/webhooks/outbound-1', 'PATCH', { enabled: false }),
      { params: Promise.resolve({ id: 'outbound-1' }) },
    );
    expect(patched.status).toBe(200);
    expect(calls.outboundUpdate).toHaveBeenCalledWith('outbound-1', { enabled: false });

    const deleted = await detail.DELETE(
      mutate('/api/integrations/webhooks/outbound-1', 'DELETE'),
      { params: Promise.resolve({ id: 'outbound-1' }) },
    );
    expect(deleted.status).toBe(200);
    expect(calls.outboundDelete).toHaveBeenCalledWith('outbound-1');

    const sent = await test.POST(
      mutate('/api/integrations/webhooks/outbound-1/test', 'POST'),
      { params: Promise.resolve({ id: 'outbound-1' }) },
    );
    expect(sent.status).toBe(200);
    expect(calls.outboundFind).toHaveBeenCalledWith('outbound-1');
    expect(events.sendWebhookEvent).toHaveBeenCalled();
    expect(calls.outboundFind.mock.invocationCallOrder[0])
      .toBeLessThan(events.sendWebhookEvent.mock.invocationCallOrder[0]);

    calls.outboundFind.mockResolvedValue(null);
    const missing = await test.POST(
      mutate('/api/integrations/webhooks/missing/test', 'POST'),
      { params: Promise.resolve({ id: 'missing' }) },
    );
    expect(missing.status).toBe(404);
  });

  it('serves the per-connector receiver, its verification ping, and its status gates', async () => {
    const route = await import('@/app/api/webhooks/[connectorId]/route');

    const ping = await route.GET(
      get('/api/webhooks/custom-rest'),
      { params: Promise.resolve({ connectorId: 'custom-rest' }) },
    );
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ status: 'ready', connectorId: 'custom-rest' });

    const validation = await route.GET(
      get('/api/webhooks/custom-rest?validationToken=abc'),
      { params: Promise.resolve({ connectorId: 'custom-rest' }) },
    );
    expect(await validation.text()).toBe('abc');

    const received = await route.POST(
      mutate('/api/webhooks/custom-rest', 'POST', {
        id: 'door-42',
        severity: 'high',
        message: 'Garage door open',
        event_kind: 'door_open',
      }),
      { params: Promise.resolve({ connectorId: 'custom-rest' }) },
    );
    expect(received.status).toBe(200);
    expect(await received.json()).toMatchObject({ success: true, notificationsAdded: 1 });
    expect(calls.ingestCreateNotification).toHaveBeenCalledWith(expect.objectContaining({
      notification: expect.objectContaining({ templateKey: 'door_open' }),
    }));
    expect(calls.ingestAppendSyncLog).toHaveBeenCalledWith(expect.objectContaining({
      connectorId: 'custom-rest',
      success: true,
      notificationsAdded: 1,
    }));

    calls.ingestFindConnector.mockResolvedValue(null);
    expect((await route.POST(
      mutate('/api/webhooks/missing', 'POST', {}),
      { params: Promise.resolve({ connectorId: 'missing' }) },
    )).status).toBe(404);

    calls.ingestFindConnector.mockResolvedValue({
      id: 'custom-rest',
      type: 'custom-rest',
      enabled: false,
      settings: {},
    });
    expect((await route.POST(
      mutate('/api/webhooks/custom-rest', 'POST', {}),
      { params: Promise.resolve({ connectorId: 'custom-rest' }) },
    )).status).toBe(403);

    calls.ingestFindConnector.mockResolvedValue({
      id: 'custom-rest',
      type: 'custom-rest',
      enabled: true,
      settings: { webhookSecret: 'abc' },
    });
    expect((await route.POST(
      mutate('/api/webhooks/custom-rest', 'POST', {}),
      { params: Promise.resolve({ connectorId: 'custom-rest' }) },
    )).status).toBe(401);
  });

  it('routes GitHub issue events through the neutral task lookup and write', async () => {
    const route = await import('@/app/api/webhooks/[connectorId]/route');
    calls.ingestFindConnector.mockResolvedValue({
      id: 'github-work',
      type: 'github-issues',
      enabled: true,
      settings: {},
    });

    const opened = await route.POST(
      mutate('/api/webhooks/github-work', 'POST', {
        action: 'opened',
        issue: { number: 7, title: 'Issue', state: 'open' },
      }),
      { params: Promise.resolve({ connectorId: 'github-work' }) },
    );
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ tasksAdded: 1, tasksUpdated: 0 });
    expect(calls.ingestFindTask).toHaveBeenCalledWith('github:7');

    calls.ingestFindTask.mockResolvedValue({
      id: 'task-1',
      status: 'todo',
      completedAt: null,
      statusReason: null,
    });
    const closed = await route.POST(
      mutate('/api/webhooks/github-work', 'POST', {
        action: 'closed',
        issue: { number: 7, title: 'Issue', state: 'closed', state_reason: 'not_planned' },
      }),
      { params: Promise.resolve({ connectorId: 'github-work' }) },
    );
    expect(await closed.json()).toMatchObject({ tasksAdded: 0, tasksUpdated: 1 });
    expect(calls.ingestUpdateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
      status: 'done',
      statusReason: 'not_planned',
    }));
  });
});
