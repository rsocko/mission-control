import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateNotificationInput,
  CreateNotificationResult,
  NotificationDeliveryRepository,
} from '@/db/persistence/notification-delivery';
import type { NotificationWebPersistence } from '@/db/persistence/notification-web';
import type { AlertmanagerRepository } from '@/db/persistence/webhook-integrations';

const mocks = vi.hoisted(() => ({
  classify: vi.fn(async () => ({ suggestions: [] })),
  enrich: vi.fn(),
  wake: vi.fn(),
}));

vi.mock('@/lib/api/trusted-request', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api/trusted-request')>(),
  isTrustedMutationRequest: () => true,
}));
vi.mock('@/lib/notifications/dispatcher-wake', () => ({
  wakeNotificationDeliveryDispatcher: mocks.wake,
}));
vi.mock('@/lib/ai/features/notification-classifier', () => ({
  classifyNotificationItems: mocks.classify,
}));
vi.mock('@/lib/notifications/enrichment', () => ({
  enrichAlert: mocks.enrich,
}));
vi.mock('@/lib/notifications/providers', () => ({
  executeNotificationProviderAction: vi.fn(async () => null),
  materializeNotificationActions: vi.fn(() => []),
  normalizeInternalNavigationTarget: (value: unknown) => (
    typeof value === 'string' && value.startsWith('/') ? value : null
  ),
  normalizeNotificationUrl: (value: unknown) => (
    typeof value === 'string' && /^https?:\/\//.test(value) ? value : null
  ),
  registerDefaultNotificationProviders: vi.fn(),
}));

const calls = vi.hoisted(() => ({
  audits: [] as Array<{ outcome: string }>,
  saved: [] as string[],
  selectedScopes: [] as unknown[],
  creationInputs: [] as unknown[],
}));

const actionNotification = {
  id: 'notification-1',
  sourceId: 'source-1',
  connectorType: 'test',
  connectorInstanceId: 'test-1',
  title: 'Notification',
  body: 'Body',
  level: 'heads_up',
  category: 'general',
  templateKey: null,
  state: 'unread',
  readState: 'unread',
  disposition: 'inbox',
  sourceState: 'active',
  navigationTarget: '/notifications',
  relatedTaskId: null,
  relatedProjectId: null,
  groupKey: null,
  metadata: {},
  presentation: {},
  lastSourceActivityAt: null,
  lastSourceActivityKey: null,
};

const web = {
  findNotificationForAction: vi.fn(async () => actionNotification),
  findNotificationAction: vi.fn(async () => ({
    id: 'action-1',
    notificationId: 'notification-1',
    actionType: 'open_url',
    payload: { url: 'https://example.test/item' },
  })),
  updateNotificationFromAction: vi.fn(async () => undefined),
  listNotificationsForReEnrichment: vi.fn(async (scope: unknown) => {
    calls.selectedScopes.push(scope);
    return [
      {
        ...actionNotification,
        id: 'enrich-ok',
        sourceId: 'source-ok',
        isActionable: false,
      },
      {
        ...actionNotification,
        id: 'enrich-failed',
        sourceId: 'source-failed',
        isActionable: false,
      },
    ];
  }),
  saveReEnrichedNotification: vi.fn(async ({ id }: { id: string }) => {
    calls.saved.push(id);
  }),
  listNotificationsForClassification: vi.fn(async () => [{
    id: 'notification-1',
    title: 'Notification',
    level: 'heads_up',
    category: 'general',
    isActionable: false,
    connectorType: 'test',
    receivedAt: '2026-09-06T12:00:00.000Z',
  }]),
} satisfies Pick<
  NotificationWebPersistence,
  | 'findNotificationForAction'
  | 'findNotificationAction'
  | 'updateNotificationFromAction'
  | 'listNotificationsForReEnrichment'
  | 'saveReEnrichedNotification'
  | 'listNotificationsForClassification'
>;

const alertmanager = {
  getControl: vi.fn(async () => ({ paused: false, updatedAt: null })),
  setPaused: vi.fn(async input => ({ paused: input.paused, updatedAt: input.updatedAt })),
  recordEvent: vi.fn(async ({ event }) => {
    calls.audits.push({ outcome: event.outcome });
  }),
  getStatus: vi.fn(async () => ({
    control: { paused: false, updatedAt: null },
    lastRequest: null,
    lastAuthenticatedReceipt: null,
    lastSuccessfulProjection: null,
    lastSyntheticTest: null,
    recentFailures: [],
    counts: {
      requests: 0,
      failures: 0,
      intentionalDrops: 0,
      accepted: 0,
      applied: 0,
      created: 0,
      updated: 0,
      stale: 0,
      duplicateReceipts: 0,
    },
  })),
  ingestBatch: vi.fn(async input => ({
    accepted: input.events.length,
    applied: input.events.length,
    stale: 0,
    created: input.events.length,
    updated: 0,
    duplicateReceipts: 0,
    pendingDelivery: true,
  })),
  inspectSyntheticLifecycle: vi.fn(async () => ({
    projectionCount: 1,
    sourceState: 'resolved',
    receiptCount: 2,
    firingDeliveryCount: 2,
  })),
  cleanupSyntheticLifecycle: vi.fn(async () => undefined),
} satisfies AlertmanagerRepository;

function createdNotification(
  input: CreateNotificationInput,
  index: number,
): CreateNotificationResult {
  const receivedAt = input.receivedAt ?? '2026-09-06T12:00:00.000Z';
  return {
    notification: {
      id: input.id ?? `created-${index}`,
      sourceId: input.sourceId,
      connectorType: input.connectorType,
      connectorInstanceId: input.connectorInstanceId,
      title: input.title,
      body: input.body ?? null,
      level: input.level ?? 'fyi',
      levelRank: 3,
      category: input.category ?? 'general',
      templateKey: input.templateKey ?? null,
      state: input.state ?? 'unread',
      readState: input.readState ?? 'unread',
      disposition: input.disposition ?? 'inbox',
      sourceState: input.sourceState ?? 'active',
      syncState: input.syncState ?? 'synced',
      readAt: null,
      handledAt: null,
      dismissedAt: null,
      resolvedAt: null,
      archivedAt: null,
      mutedAt: null,
      snoozedUntil: null,
      sourceResolvedAt: null,
      lastSourceActivityAt: input.sourceActivityAt ?? receivedAt,
      lastSourceActivityKey: input.sourceActivityKey ?? null,
      handledSourceActivityAt: null,
      handledSourceActivityKey: null,
      lastSourceSyncedAt: null,
      isActionable: input.isActionable ?? false,
      primaryActionId: input.primaryActionId ?? null,
      aiSuggestedActionId: input.aiSuggestedActionId ?? null,
      receivedAt,
      sortAt: input.sortAt ?? receivedAt,
      expiresAt: input.expiresAt ?? null,
      groupKey: input.groupKey ?? null,
      dedupeKey: input.dedupeKey ?? null,
      relatedTaskId: input.relatedTaskId ?? null,
      relatedProjectId: input.relatedProjectId ?? null,
      relatedEntityType: input.relatedEntityType ?? null,
      relatedEntityId: input.relatedEntityId ?? null,
      navigationTarget: input.navigationTarget ?? null,
      reconcileAttempts: 0,
      lastReconciledAt: null,
      staleSince: null,
      autoResolveReason: null,
      metadata: input.metadata ?? {},
      presentation: input.presentation ?? {},
      enrichmentRevision: input.enrichmentRevision ?? null,
      enrichmentGeneration: 0,
    },
    created: true,
    deliveryEvent: null,
    deliveryEvents: [],
  };
}

const delivery = {
  web: web as unknown as NotificationWebPersistence,
  push: {
    getPreferences: vi.fn(async () => ({
      triageNudgeEnabled: true,
      triageNudgeThreshold: 5,
    })),
  },
  scheduledTriggers: {
    getTriageSnapshot: vi.fn(async () => ({ pendingCount: 6, highWater: null })),
  },
  creation: {
    createNotifications: vi.fn(async (inputs: readonly CreateNotificationInput[]) => {
      calls.creationInputs.push(...inputs);
      return inputs.map(createdNotification);
    }),
  },
} as unknown as NotificationDeliveryRepository;

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    notificationDelivery: delivery,
    webhookIntegrations: { alertmanager },
  }),
}));

function alertmanagerPayload() {
  return {
    version: '4',
    groupKey: '{}:{alertname="NodeDown"}',
    truncatedAlerts: 0,
    status: 'firing',
    receiver: 'mission-control',
    groupLabels: { alertname: 'NodeDown' },
    commonLabels: { severity: 'critical' },
    commonAnnotations: {},
    externalURL: 'https://alertmanager.example',
    alerts: [{
      status: 'firing',
      labels: {
        alertname: 'NodeDown',
        severity: 'critical',
        notification_type: 'homelab_service_unavailable',
      },
      annotations: { summary: 'Node is unavailable' },
      startsAt: '2026-09-06T12:00:00.000Z',
      endsAt: '2026-09-06T12:05:00.000Z',
      generatorURL: 'https://prometheus.example/graph',
      fingerprint: 'abcdef0123456789',
    }],
  };
}

describe('notification delivery web routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.audits.length = 0;
    calls.saved.length = 0;
    calls.selectedScopes.length = 0;
    calls.creationInputs.length = 0;
    process.env.MC_ALERTMANAGER_WEBHOOK_TOKEN = 'test-token-with-at-least-32-characters';
    process.env.MC_ALERTMANAGER_INTEGRATION_ID = 'notification-parity-test';
    process.env.CRON_SECRET = 'cron-secret';
    mocks.enrich.mockImplementation(async (item: { id: string }) => {
      if (item.id === 'enrich-failed') throw new Error('provider unavailable');
      return {
        ...item,
        body: item.id,
        templateKey: null,
        relatedTaskId: null,
        relatedProjectId: null,
        relatedEntityType: null,
        relatedEntityId: null,
        navigationTarget: '/notifications',
        metadata: {},
        presentation: {},
        providerSignature: null,
        actions: [],
      };
    });
  });

  it('serves all three Alertmanager handlers with audit ordering intact', async () => {
    const [controlRoute, testRoute, webhookRoute] = await Promise.all([
      import('@/app/api/integrations/alertmanager/route'),
      import('@/app/api/integrations/alertmanager/test/route'),
      import('@/app/api/integrations/alertmanager/webhook/route'),
    ]);

    expect((await controlRoute.GET()).status).toBe(200);
    expect((await controlRoute.PATCH(new Request(
      'http://localhost/api/integrations/alertmanager',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused: false }),
      },
    ))).status).toBe(200);
    expect((await testRoute.POST(new Request(
      'http://localhost/api/integrations/alertmanager/test',
      { method: 'POST' },
    ))).status).toBe(200);
    const webhookResponse = await webhookRoute.POST(new Request(
      'http://localhost/api/integrations/alertmanager/webhook',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token-with-at-least-32-characters',
          'content-type': 'application/json',
        },
        body: JSON.stringify(alertmanagerPayload()),
      },
    ));
    expect(webhookResponse.status).toBe(200);
    expect(calls.audits.at(-1)).toEqual({ outcome: 'projected' });
  });

  it('executes notification actions and keeps re-enrichment partial results', async () => {
    const [actionRoute, reEnrichRoute] = await Promise.all([
      import('@/app/api/notifications/[id]/actions/[actionId]/route'),
      import('@/app/api/notifications/re-enrich/route'),
    ]);
    const actionResponse = await actionRoute.POST(
      new Request('http://localhost/api/notifications/notification-1/actions/action-1', {
        method: 'POST',
        body: '{}',
      }),
      { params: Promise.resolve({ id: 'notification-1', actionId: 'action-1' }) },
    );
    expect(actionResponse.status).toBe(200);
    expect(web.updateNotificationFromAction).toHaveBeenCalledWith(expect.objectContaining({
      notificationId: 'notification-1',
      state: 'read',
    }));

    const enrichmentResponse = await reEnrichRoute.POST(new Request(
      'http://localhost/api/notifications/re-enrich',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'unenriched', limit: 10 }),
      },
    ));
    expect(enrichmentResponse.status).toBe(200);
    await expect(enrichmentResponse.json()).resolves.toMatchObject({
      success: true,
      processed: 2,
      enriched: 1,
      errors: ['enrich-failed: provider unavailable'],
    });
    expect(calls.saved).toEqual(['enrich-ok']);
  });

  it('classifies through the clean seam and preserves scheduled-trigger dedupe inputs', async () => {
    const [triageRoute, pushRoute] = await Promise.all([
      import('@/app/api/notifications/triage/route'),
      import('@/app/api/push/trigger/route'),
    ]);
    expect((await triageRoute.GET()).status).toBe(200);
    expect(mocks.classify).toHaveBeenCalledOnce();

    const pushResponse = await pushRoute.POST(new Request(
      'http://localhost/api/push/trigger?type=triage',
      {
        method: 'POST',
        headers: { authorization: 'Bearer cron-secret' },
      },
    ));
    expect(pushResponse.status).toBe(200);
    expect(calls.creationInputs).toEqual([
      expect.objectContaining({
        sourceId: expect.stringContaining('push:triage_nudge:'),
        dedupeKey: expect.stringContaining('push:triage_nudge:'),
        occurrenceKey: '6',
      }),
    ]);
  });
});
