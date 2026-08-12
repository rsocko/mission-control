import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const webPushMocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}));

vi.mock('web-push', () => ({
  default: webPushMocks,
}));
vi.unmock('drizzle-orm');
process.env.MC_DB_PATH = ':memory:';
process.env.VAPID_PUBLIC_KEY = 'test-public-key';
process.env.VAPID_PRIVATE_KEY = 'test-private-key';

let db: typeof import('@/db').default;
let runTransaction: typeof import('@/db').runTransaction;
let schema: typeof import('@/db/schema');
let service: typeof import('@/lib/notifications/service');
let dispatcher: typeof import('@/lib/push/dispatcher');
let sender: typeof import('@/lib/push/web-push-sender');
let deleteConnector: typeof import('@/app/api/connectors/route').DELETE;
let deleteInboundWebhook: typeof import('@/app/api/inbound-webhooks/[id]/route').DELETE;
let eq: typeof import('drizzle-orm').eq;
let sequence = 0;

const BASE_TIME = new Date('2026-08-02T12:00:00.000Z');
const delivered = {
  classification: 'delivered',
  attempted: 1,
  sent: 1,
  failed: 0,
  transientFailures: 0,
  permanentFailures: 0,
  expiredSubscriptions: 0,
} as const;
const transientFailure = {
  classification: 'delivery_failure',
  attempted: 1,
  sent: 0,
  failed: 1,
  transientFailures: 1,
  permanentFailures: 0,
  expiredSubscriptions: 0,
} as const;

beforeAll(async () => {
  ({ default: db, runTransaction } = await import('@/db'));
  schema = await import('@/db/schema');
  service = await import('@/lib/notifications/service');
  dispatcher = await import('@/lib/push/dispatcher');
  sender = await import('@/lib/push/web-push-sender');
  ({ DELETE: deleteConnector } = await import('@/app/api/connectors/route'));
  ({ DELETE: deleteInboundWebhook } = await import('@/app/api/inbound-webhooks/[id]/route'));
  ({ eq } = await import('drizzle-orm'));
});

beforeEach(() => {
  sequence = 0;
  webPushMocks.sendNotification.mockReset();
  webPushMocks.setVapidDetails.mockReset();
  db.delete(schema.notificationDeliveryEvents).run();
  db.delete(schema.notifications).run();
  db.delete(schema.notificationPushRules).run();
  db.delete(schema.pushSubscriptions).run();
  db.delete(schema.pushPreferences).run();
  db.delete(schema.appSettings).run();
  db.delete(schema.financeInsightCutovers).run();
  db.delete(schema.connectorConfigs).run();

  db.insert(schema.connectorConfigs).values({
    id: 'github-work',
    type: 'github-issues',
    name: 'GitHub Work',
    enabled: true,
    syncMode: 'poll',
    pollIntervalMinutes: 5,
    capabilities: {},
    credentials: {
      accessToken: 'must-never-enter-a-snapshot',
    },
    settings: {
      webhookSecret: 'must-never-enter-a-snapshot',
    },
    syncedLists: [],
    createdAt: BASE_TIME.toISOString(),
    updatedAt: BASE_TIME.toISOString(),
  }).run();
  db.insert(schema.notificationPushRules).values({
    id: 'rule-review',
    connectorInstanceId: 'github-work',
    templateKey: 'pr_review_requested',
    enabled: true,
    minLevel: 'action_needed',
    preview: 'title_and_body',
    maxPerHour: null,
    createdAt: BASE_TIME.toISOString(),
    updatedAt: BASE_TIME.toISOString(),
  }).run();
  db.insert(schema.pushSubscriptions).values({
    id: 'subscription-1',
    platform: 'web',
    endpoint: 'https://push.example.test/secret-endpoint',
    keys: { p256dh: 'key', auth: 'auth-secret' },
    userAgent: 'test',
    createdAt: BASE_TIME.toISOString(),
  }).run();
});

function input(overrides: Partial<import('@/lib/notifications/service').CreateNotificationInput> = {}) {
  sequence += 1;
  return {
    id: `notification-${sequence}`,
    sourceId: `github:notification:${sequence}`,
    connectorType: 'github-issues',
    connectorInstanceId: 'github-work',
    title: 'Review requested',
    body: 'token=super-secret review this pull request',
    level: 'action_needed',
    category: 'tasks',
    templateKey: 'pr_review_requested',
    navigationTarget: '/notifications?filter=reviews',
    metadata: {
      rawWebhookPayload: 'must-never-enter-a-snapshot',
      accessToken: 'must-never-enter-a-snapshot',
    },
    ...overrides,
  } satisfies import('@/lib/notifications/service').CreateNotificationInput;
}

async function createPending(
  overrides: Partial<import('@/lib/notifications/service').CreateNotificationInput> = {},
) {
  return service.createNotification(input(overrides), {
    now: BASE_TIME,
    timezone: 'UTC',
    channelConfigured: true,
    wakeDispatcher: false,
  });
}

function getEvent(id: string) {
  return db.select().from(schema.notificationDeliveryEvents).where(
    eq(schema.notificationDeliveryEvents.id, id),
  ).get();
}

describe('transaction-aware notification creation', () => {
  it('commits the notification and pending delivery intent atomically', async () => {
    const result = await createPending();

    expect(result.created).toBe(true);
    expect(result.deliveryEvent).toMatchObject({
      notificationId: result.notification.id,
      status: 'pending',
      attemptCount: 0,
      dedupeKey: `web_push:${result.notification.id}:initial`,
    });
    expect(result.deliveryEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'web_push', status: 'pending' }),
      expect.objectContaining({
        channel: 'apns',
        status: 'suppressed',
        suppressionReason: 'channel_unconfigured',
      }),
    ]));
    expect(db.select().from(schema.notifications).all()).toHaveLength(1);
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toHaveLength(2);
  });

  it('rolls back both records when an enclosing transaction fails', () => {
    expect(() => runTransaction(transaction => {
      service.createNotificationsInTransaction(transaction, [input()], {
        now: BASE_TIME,
        timezone: 'UTC',
        channelConfigured: true,
        wakeDispatcher: false,
      });
      throw new Error('connector transaction failed');
    })).toThrow('connector transaction failed');

    expect(db.select().from(schema.notifications).all()).toEqual([]);
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toEqual([]);
  });

  it('creates a batch in one transaction and reuses persisted policy', async () => {
    const results = await service.createNotifications([input(), input()], {
      now: BASE_TIME,
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });

    expect(results).toHaveLength(2);
    expect(results.every(result => result.deliveryEvent?.status === 'pending')).toBe(true);
    expect(results.every(result => result.deliveryEvents.length === 2)).toBe(true);
    expect(db.select().from(schema.notifications).all()).toHaveLength(2);
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toHaveLength(4);
  });

  it('deduplicates notification and initial delivery across repeated creation', async () => {
    const originalInput = input();
    const first = await service.createNotification(originalInput, {
      now: BASE_TIME,
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });
    const duplicate = await service.createNotification({
      ...originalInput,
      id: 'different-id',
    }, {
      now: BASE_TIME,
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });

    expect(duplicate.created).toBe(false);
    expect(duplicate.notification.id).toBe(first.notification.id);
    expect(duplicate.deliveryEvent?.id).toBe(first.deliveryEvent?.id);
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toHaveLength(2);
  });

  it('allows an explicit occurrence to resurface one persisted notification once', async () => {
    const originalInput = input();
    const first = await service.createNotification(originalInput, {
      now: BASE_TIME,
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });
    const resurfaced = await service.createNotification({
      ...originalInput,
      occurrenceKey: 'queue-growth-12',
    }, {
      now: BASE_TIME,
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });

    expect(resurfaced.notification.id).toBe(first.notification.id);
    expect(resurfaced.deliveryEvent?.dedupeKey).toBe(
      `web_push:${first.notification.id}:queue-growth-12`,
    );
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toHaveLength(4);
  });
});

describe('source activity lifecycle', () => {
  const firstActivity = '2026-08-02T10:00:00.000Z';
  const nextActivity = '2026-08-02T11:00:00.000Z';

  async function createSourceNotification() {
    const sourceInput = input({
      sourceActivityAt: firstActivity,
      sourceActivityKey: 'activity-1',
      occurrenceKey: 'activity-1',
    });
    const created = await service.createNotification(sourceInput, {
      now: BASE_TIME,
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });
    return { sourceInput, created };
  }

  function setDisposition(
    notificationId: string,
    disposition: 'handled' | 'dismissed',
  ) {
    db.update(schema.notifications).set({
      state: disposition === 'handled' ? 'archived' : 'dismissed',
      readState: 'read',
      disposition,
      readAt: BASE_TIME.toISOString(),
      handledAt: disposition === 'handled' ? BASE_TIME.toISOString() : null,
      dismissedAt: disposition === 'dismissed' ? BASE_TIME.toISOString() : null,
      handledSourceActivityAt: firstActivity,
      handledSourceActivityKey: 'activity-1',
    }).where(eq(schema.notifications.id, notificationId)).run();
  }

  it('does not reopen handled work when source activity is unchanged', async () => {
    const { sourceInput, created } = await createSourceNotification();
    setDisposition(created.notification.id, 'handled');

    const repeated = await service.createNotification(sourceInput, {
      now: new Date('2026-08-02T12:05:00.000Z'),
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });

    expect(repeated.notification).toMatchObject({
      state: 'archived',
      readState: 'read',
      disposition: 'handled',
      sortAt: created.notification.sortAt,
    });
  });

  it('does not treat synthetic receipt times as new activity or clear pending synchronization', async () => {
    const { sourceInput, created } = await createSourceNotification();
    setDisposition(created.notification.id, 'handled');
    db.update(schema.notifications).set({
      syncState: 'pending',
    }).where(eq(schema.notifications.id, created.notification.id)).run();

    const repeated = await service.createNotification({
      ...sourceInput,
      sourceActivityAt: undefined,
      sourceActivityKey: undefined,
      receivedAt: '2026-08-02T12:05:00.000Z',
      sortAt: '2026-08-02T12:05:00.000Z',
    }, {
      now: new Date('2026-08-02T12:05:00.000Z'),
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });

    expect(repeated.notification).toMatchObject({
      state: 'archived',
      disposition: 'handled',
      syncState: 'pending',
      sortAt: created.notification.sortAt,
    });
  });

  it('reopens handled work as unread and advances sort order for new activity', async () => {
    const { sourceInput, created } = await createSourceNotification();
    setDisposition(created.notification.id, 'handled');

    const repeated = await service.createNotification({
      ...sourceInput,
      sourceActivityAt: nextActivity,
      sourceActivityKey: 'activity-2',
      occurrenceKey: 'activity-2',
    }, {
      now: new Date('2026-08-02T12:05:00.000Z'),
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });

    expect(repeated.notification).toMatchObject({
      state: 'unread',
      readState: 'unread',
      disposition: 'inbox',
      sourceState: 'active',
      sortAt: nextActivity,
      lastSourceActivityAt: nextActivity,
      lastSourceActivityKey: 'activity-2',
    });
  });

  it('keeps dismissed work closed unless the provider explicitly opts in', async () => {
    const { sourceInput, created } = await createSourceNotification();
    setDisposition(created.notification.id, 'dismissed');

    const defaultResult = await service.createNotification({
      ...sourceInput,
      sourceActivityAt: nextActivity,
      sourceActivityKey: 'activity-2',
      occurrenceKey: 'activity-2',
    }, {
      now: new Date('2026-08-02T12:05:00.000Z'),
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });
    expect(defaultResult.notification.disposition).toBe('dismissed');

    const optedIn = await service.createNotification({
      ...sourceInput,
      sourceActivityAt: '2026-08-02T12:00:00.000Z',
      sourceActivityKey: 'activity-3',
      occurrenceKey: 'activity-3',
      reopenPolicy: 'handled_and_dismissed',
    }, {
      now: new Date('2026-08-02T12:05:00.000Z'),
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });
    expect(optedIn.notification).toMatchObject({
      state: 'unread',
      readState: 'unread',
      disposition: 'inbox',
    });
  });

  it('records source resolution without erasing local disposition history', async () => {
    const { sourceInput, created } = await createSourceNotification();
    setDisposition(created.notification.id, 'handled');

    const resolved = await service.createNotification({
      ...sourceInput,
      sourceState: 'resolved',
      occurrenceKey: 'resolved',
    }, {
      now: new Date('2026-08-02T12:05:00.000Z'),
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });

    expect(resolved.notification).toMatchObject({
      state: 'resolved',
      disposition: 'handled',
      sourceState: 'resolved',
      readState: 'read',
    });
    expect(resolved.notification.sourceResolvedAt).not.toBeNull();
  });
});

describe('policy, privacy, and suppression decisions', () => {
  it('stores only a redacted payload and minimal policy snapshot', async () => {
    const result = await createPending();
    const event = result.deliveryEvent!;
    const serialized = JSON.stringify({
      payload: event.payloadSnapshot,
      policy: event.policySnapshot,
    });

    expect(event.payloadSnapshot).toEqual({
      notificationId: result.notification.id,
      title: 'Review requested',
      body: 'token=[redacted] review this pull request',
      tag: `mc:${result.notification.id}`,
      url: '/notifications?filter=reviews',
    });
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('must-never-enter-a-snapshot');
    expect(serialized).not.toContain('secret-endpoint');
    expect(serialized).not.toContain('auth-secret');
  });

  it('redacts bearer tokens and JSON-formatted credentials', () => {
    const redacted = service.redactPushText(
      'Bearer abc.def Authorization: Basic dXNlcjpwYXNz credential=top-secret-value '
        + '{"password":"hunter2","access_token":"abc123"}',
      512,
    );
    expect(redacted).not.toContain('abc.def');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('dXNlcjpwYXNz');
    expect(redacted).not.toContain('top-secret-value');
    expect(redacted).toContain('Bearer [redacted]');
  });

  it('omits bodies for sensitive notification types even with an unsafe stored rule', async () => {
    db.delete(schema.notificationPushRules).run();
    db.insert(schema.notificationPushRules).values({
      id: 'rule-security',
      connectorInstanceId: 'github-work',
      templateKey: 'security_alert',
      enabled: true,
      minLevel: 'urgent',
      preview: 'title_and_body',
      maxPerHour: null,
      createdAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).run();

    const result = await createPending({
      templateKey: 'security_alert',
      level: 'urgent',
      body: 'password=hunter2',
    });

    expect(result.deliveryEvent?.payloadSnapshot).not.toHaveProperty('body');
    expect(result.deliveryEvent?.policySnapshot).toMatchObject({
      preview: 'title_only',
    });
  });

  it('drops external navigation and snapshots a safe internal fallback', async () => {
    const result = await createPending({
      navigationTarget: 'https://evil.example.test/phish',
    });
    expect(result.notification.navigationTarget).toBeNull();
    expect(result.deliveryEvent?.payloadSnapshot).toMatchObject({
      url: `/notifications?id=${result.notification.id}`,
    });
  });

  it.each([
    ['channel_disabled', { channelEnabled: false, channelConfigured: true }],
    ['channel_unconfigured', { channelEnabled: true, channelConfigured: false }],
  ] as const)('records %s as a final suppression', async (reason, overrides) => {
    const result = await service.createNotification(input(), {
      now: BASE_TIME,
      timezone: 'UTC',
      wakeDispatcher: false,
      ...overrides,
    });
    expect(result.deliveryEvent).toMatchObject({
      status: 'suppressed',
      suppressionReason: reason,
    });
  });

  it('honors the persisted global push channel switch', async () => {
    db.insert(schema.appSettings).values({
      key: service.PUSH_DELIVERY_SETTING_KEY,
      value: false,
      updatedAt: BASE_TIME.toISOString(),
    }).run();

    const result = await createPending();
    expect(result.deliveryEvent).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'channel_disabled',
    });
  });

  it('distinguishes disabled rules from notifications below their threshold', async () => {
    db.update(schema.notificationPushRules).set({ enabled: false }).run();
    const disabled = await createPending();
    expect(disabled.deliveryEvent).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'rule_disabled',
    });

    db.update(schema.notificationPushRules).set({
      enabled: true,
      minLevel: 'urgent',
    }).run();
    const belowThreshold = await createPending();
    expect(belowThreshold.deliveryEvent).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'below_minimum_level',
    });
  });

  it('records DND, quiet hours, and no-subscription suppression', async () => {
    db.insert(schema.pushPreferences).values({
      id: 'default',
      morningEnabled: true,
      morningHour: 8,
      triageNudgeEnabled: true,
      triageNudgeThreshold: 5,
      carryForwardEnabled: true,
      carryForwardHour: 18,
      quietStart: null,
      quietEnd: null,
      doNotDisturb: true,
      updatedAt: BASE_TIME.toISOString(),
    }).run();
    const dnd = await createPending();
    expect(dnd.deliveryEvent).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'dnd',
    });

    db.delete(schema.pushPreferences).run();
    db.insert(schema.pushPreferences).values({
      id: 'default',
      morningEnabled: true,
      morningHour: 8,
      triageNudgeEnabled: true,
      triageNudgeThreshold: 5,
      carryForwardEnabled: true,
      carryForwardHour: 18,
      quietStart: 11,
      quietEnd: 13,
      doNotDisturb: false,
      updatedAt: BASE_TIME.toISOString(),
    }).run();
    const quiet = await createPending();
    expect(quiet.deliveryEvent).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'quiet_hours',
    });

    db.delete(schema.pushPreferences).run();
    db.delete(schema.pushSubscriptions).run();
    const noSubscription = await createPending();
    expect(noSubscription.deliveryEvent).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'no_subscription',
    });
  });

  it('enforces global and per-rule hourly limits transactionally', async () => {
    const first = await createPending();
    const globallyLimited = await service.createNotification(input(), {
      now: BASE_TIME,
      timezone: 'UTC',
      channelConfigured: true,
      globalMaxPerHour: 1,
      wakeDispatcher: false,
    });
    expect(first.deliveryEvent?.status).toBe('pending');
    expect(globallyLimited.deliveryEvent).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'rate_limited',
    });

    db.delete(schema.notificationDeliveryEvents).run();
    db.delete(schema.notifications).run();
    db.update(schema.notificationPushRules).set({ maxPerHour: 1 }).run();
    const ruleFirst = await createPending();
    const ruleLimited = await createPending();
    expect(ruleFirst.deliveryEvent?.status).toBe('pending');
    expect(ruleLimited.deliveryEvent).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'rate_limited',
    });
  });

  it('applies wildcard rule limits across all connector notification types', async () => {
    db.delete(schema.notificationPushRules).run();
    db.insert(schema.notificationPushRules).values({
      id: 'rule-wildcard',
      connectorInstanceId: 'github-work',
      templateKey: '*',
      enabled: true,
      minLevel: 'action_needed',
      preview: 'title_only',
      maxPerHour: 1,
      createdAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).run();

    const first = await createPending();
    const second = await createPending({
      templateKey: 'ci_failure',
      title: 'CI failed',
    });

    expect(first.deliveryEvent?.status).toBe('pending');
    expect(second.deliveryEvent).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'rate_limited',
    });
  });

  it('does not create outbox rows for unknown or ineligible catalog types', async () => {
    const unknown = await createPending({ templateKey: 'unknown_type' });
    const ineligible = await createPending({ templateKey: 'github_activity' });

    expect(unknown.deliveryEvent).toBeNull();
    expect(ineligible.deliveryEvent).toBeNull();
    expect(db.select().from(schema.notifications).all()).toHaveLength(2);
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toEqual([]);
  });

  it('keeps the notification committed when stored push policy is invalid', async () => {
    db.update(schema.notificationPushRules).set({ maxPerHour: 1_001 }).run();

    const result = await createPending();

    expect(result.created).toBe(true);
    expect(result.deliveryEvent).toMatchObject({
      status: 'failed',
      lastError: 'policy_resolution_failed',
    });
    expect(db.select().from(schema.notifications).where(
      eq(schema.notifications.id, result.notification.id),
    ).get()).toBeDefined();
  });

  it('lets a system wildcard override scheduled reminder defaults', async () => {
    db.insert(schema.notificationPushRules).values({
      id: 'system-wildcard',
      connectorInstanceId: 'push-triggers',
      templateKey: '*',
      enabled: false,
      minLevel: 'urgent',
      preview: 'title_only',
      maxPerHour: null,
      createdAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).run();

    const result = await service.createNotification({
      id: 'system-notification',
      sourceId: 'push:morning_start_day:2026-08-02',
      connectorType: 'system',
      connectorInstanceId: 'push-triggers',
      title: 'Start your day',
      body: 'One task planned',
      level: 'fyi',
      category: 'tasks',
      templateKey: 'morning_start_day',
      navigationTarget: '/today',
    }, {
      now: BASE_TIME,
      timezone: 'UTC',
      channelConfigured: true,
      wakeDispatcher: false,
    });

    expect(result.deliveryEvent).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'rule_disabled',
    });
  });

  it('purges retained push rules only when a connector is permanently deleted', async () => {
    db.insert(schema.financeInsightTransactionProjectionState).values({
      connectorId: 'github-work',
      status: 'succeeded',
      successfulGenerationId: 'history-generation',
      createdAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).run();
    db.insert(schema.financeInsightTransactionProjectionWindows).values({
      connectorId: 'github-work',
      generationId: 'history-generation',
      windowIndex: 0,
      coverageStart: '2026-08-01',
      coverageEnd: '2026-08-02',
      sourceAsOf: BASE_TIME.toISOString(),
      itemCount: 1,
      contentDigest: `sha256:${'a'.repeat(64)}`,
    }).run();
    db.insert(schema.financeInsightTransactionProjectionFacts).values({
      connectorId: 'github-work',
      generationId: 'history-generation',
      sourceRef: 'transaction-one',
      occurredOn: '2026-08-01',
      payload: { sourceRef: 'transaction-one' },
    }).run();
    db.insert(schema.financeInsightCutovers).values({
      connectorId: 'github-work',
      cutoverAt: BASE_TIME.toISOString(),
      sourceGeneration: 'source-generation',
      sourceSequence: 1,
      legacyDisabled: true,
      deliveryEnabled: true,
      createdAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).run();
    db.insert(schema.financeInsightTransactionBackfillPlans).values({
      id: 'backfill-plan',
      connectorId: 'github-work',
      idempotencyKey: 'operator-key',
      horizonMonths: 37,
      coverageStart: '2023-08-01',
      coverageEnd: '2026-08-31',
      currency: 'USD',
      bridgeContractVersion: '1.0',
      windowCount: 4,
      nextWindowOrdinal: 1,
      status: 'running',
      createdAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).run();
    db.insert(schema.financeInsightTransactionWindowProofs).values({
      planId: 'backfill-plan',
      connectorId: 'github-work',
      windowOrdinal: 0,
      generationRef: 'window-generation',
      windowStart: '2023-08-01',
      windowEnd: '2024-07-30',
      sourceAsOf: BASE_TIME.toISOString(),
      itemCount: 1,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      currency: 'USD',
      bridgeContractVersion: '1.0',
      createdAt: BASE_TIME.toISOString(),
    }).run();
    const softDelete = await deleteConnector(new Request(
      'http://localhost/api/connectors?id=github-work',
      { method: 'DELETE' },
    ));
    expect(softDelete.status).toBe(200);
    expect(db.select().from(schema.notificationPushRules).all()).toHaveLength(1);
    expect(db.select().from(schema.financeInsightCutovers).all()).toHaveLength(1);
    expect(db.select().from(schema.financeInsightTransactionBackfillPlans).all())
      .toHaveLength(1);

    db.insert(schema.connectorOperationLeases).values({
      connectorId: 'github-work',
      operationType: 'sync',
      owner: 'sync:test-worker',
      leaseExpiresAt: '9999-12-31T23:59:59.999Z',
      createdAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).run();
    const busyDelete = await deleteConnector(new Request(
      'http://localhost/api/connectors?id=github-work&permanent=true',
      { method: 'DELETE' },
    ));
    expect(busyDelete.status).toBe(409);
    expect(db.select().from(schema.financeInsightTransactionProjectionState).all())
      .toHaveLength(1);
    db.delete(schema.connectorOperationLeases)
      .where(eq(schema.connectorOperationLeases.connectorId, 'github-work'))
      .run();

    const permanentDelete = await deleteConnector(new Request(
      'http://localhost/api/connectors?id=github-work&permanent=true',
      { method: 'DELETE' },
    ));
    expect(permanentDelete.status).toBe(200);
    expect(db.select().from(schema.notificationPushRules).all()).toEqual([]);
    expect(db.select().from(schema.financeInsightTransactionProjectionState).all()).toEqual([]);
    expect(db.select().from(schema.financeInsightTransactionProjectionWindows).all()).toEqual([]);
    expect(db.select().from(schema.financeInsightTransactionProjectionFacts).all()).toEqual([]);
    expect(db.select().from(schema.financeInsightCutovers).all()).toEqual([]);
    expect(db.select().from(schema.financeInsightTransactionBackfillPlans).all()).toEqual([]);
    expect(db.select().from(schema.financeInsightTransactionWindowProofs).all()).toEqual([]);
  });

  it('purges push rules when an inbound webhook is permanently deleted', async () => {
    db.insert(schema.inboundWebhooks).values({
      id: 'webhook-local',
      name: 'Local webhook',
      sourceLabel: 'Automation',
      secret: null,
      enabled: true,
      defaultAction: 'alert',
      fieldMappings: {},
      totalReceived: 0,
      lastReceivedAt: null,
      lastStatus: null,
      createdAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).run();
    db.insert(schema.notificationPushRules).values({
      id: 'webhook-rule',
      connectorInstanceId: 'webhook-local',
      templateKey: '*',
      enabled: true,
      minLevel: 'urgent',
      preview: 'title_only',
      maxPerHour: null,
      createdAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).run();

    process.env.MC_API_KEY = 'durable-push-test-key';
    const response = await deleteInboundWebhook(
      new Request('http://localhost/api/inbound-webhooks/webhook-local', {
        method: 'DELETE',
        headers: { 'x-mc-api-key': 'durable-push-test-key' },
      }),
      { params: Promise.resolve({ id: 'webhook-local' }) },
    );
    delete process.env.MC_API_KEY;

    expect(response.status).toBe(200);
    expect(db.select().from(schema.notificationPushRules).where(
      eq(schema.notificationPushRules.connectorInstanceId, 'webhook-local'),
    ).all()).toEqual([]);
  });
});

describe('leased Web Push dispatcher', () => {
  it('uses compare-and-set claims so only one dispatcher owns an active event', async () => {
    const event = (await createPending()).deliveryEvent!;

    const first = dispatcher.claimNotificationDelivery(BASE_TIME, 60_000);
    const concurrent = dispatcher.claimNotificationDelivery(BASE_TIME, 60_000);

    expect(first?.id).toBe(event.id);
    expect(concurrent).toBeNull();
    expect(getEvent(event.id)).toMatchObject({
      status: 'sending',
      attemptCount: 1,
    });
  });

  it('recovers a stale lease after restart without reclaiming a live lease', async () => {
    const event = (await createPending()).deliveryEvent!;
    dispatcher.claimNotificationDelivery(BASE_TIME, 60_000);

    expect(dispatcher.claimNotificationDelivery(
      new Date(BASE_TIME.getTime() + 59_999),
      60_000,
    )).toBeNull();
    const recovered = dispatcher.claimNotificationDelivery(
      new Date(BASE_TIME.getTime() + 60_000),
      60_000,
    );

    expect(recovered?.id).toBe(event.id);
    expect(recovered?.attemptCount).toBe(2);
  });

  it('fails an exhausted stale lease without sending another attempt', async () => {
    const event = (await createPending()).deliveryEvent!;
    dispatcher.claimNotificationDelivery(BASE_TIME, 60_000, 1);

    const exhausted = dispatcher.claimNotificationDelivery(
      new Date(BASE_TIME.getTime() + 60_000),
      60_000,
      1,
    );

    expect(exhausted).toBeNull();
    expect(getEvent(event.id)).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      lastError: 'retry_limit_exhausted',
    });
  });

  it('persists successful and partial endpoint outcomes', async () => {
    const sentEvent = (await createPending()).deliveryEvent!;
    await dispatcher.dispatchNotificationDeliveries({
      now: () => BASE_TIME,
      sender: vi.fn().mockResolvedValue(delivered),
    });
    expect(getEvent(sentEvent.id)).toMatchObject({
      status: 'sent',
      subscriptionsAttempted: 1,
      subscriptionsSent: 1,
      subscriptionsFailed: 0,
      sentAt: BASE_TIME.toISOString(),
    });

    const partialEvent = (await createPending()).deliveryEvent!;
    await dispatcher.dispatchNotificationDeliveries({
      now: () => BASE_TIME,
      sender: vi.fn().mockResolvedValue({
        classification: 'delivery_failure',
        attempted: 2,
        sent: 1,
        failed: 1,
        transientFailures: 1,
        permanentFailures: 0,
        expiredSubscriptions: 0,
      }),
    });
    expect(getEvent(partialEvent.id)).toMatchObject({
      status: 'partial',
      subscriptionsAttempted: 2,
      subscriptionsSent: 1,
      subscriptionsFailed: 1,
      lastError: 'partial_delivery_failure',
    });
  });

  it('retries transient failures across dispatcher restarts with bounded backoff', async () => {
    const event = (await createPending()).deliveryEvent!;
    await dispatcher.dispatchNotificationDeliveries({
      now: () => BASE_TIME,
      retryBaseMs: 30_000,
      sender: vi.fn().mockResolvedValue(transientFailure),
    });
    expect(getEvent(event.id)).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      nextAttemptAt: '2026-08-02T12:00:30.000Z',
      lastError: 'transient_delivery_failure',
    });

    expect(await dispatcher.dispatchNotificationDeliveries({
      now: () => new Date('2026-08-02T12:00:29.999Z'),
      sender: vi.fn().mockResolvedValue(delivered),
    })).toBe(0);
    await dispatcher.dispatchNotificationDeliveries({
      now: () => new Date('2026-08-02T12:00:30.000Z'),
      sender: vi.fn().mockResolvedValue(delivered),
    });
    expect(getEvent(event.id)).toMatchObject({
      status: 'sent',
      attemptCount: 2,
    });
    expect(dispatcher.calculateRetryDelayMs(5, 30_000)).toBe(480_000);
    expect(dispatcher.calculateRetryDelayMs(20, 30_000)).toBe(3_600_000);
  });

  it('stops retrying at the configured bound and keeps committed notifications', async () => {
    const result = await createPending();
    const throwingSender = vi.fn().mockRejectedValue(new Error('network unavailable'));

    await dispatcher.dispatchNotificationDeliveries({
      now: () => BASE_TIME,
      maxAttempts: 1,
      sender: throwingSender,
    });

    expect(getEvent(result.deliveryEvent!.id)).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      lastError: 'retry_limit_exhausted',
    });
    expect(db.select().from(schema.notifications).where(
      eq(schema.notifications.id, result.notification.id),
    ).get()).toBeDefined();
  });

  it('fails malformed stored payloads without retrying or blocking later claims', async () => {
    const malformed = (await createPending()).deliveryEvent!;
    const valid = (await createPending()).deliveryEvent!;
    db.update(schema.notificationDeliveryEvents).set({
      payloadSnapshot: 'not-an-object',
    }).where(eq(schema.notificationDeliveryEvents.id, malformed.id)).run();

    const claims = [
      dispatcher.claimNotificationDelivery(BASE_TIME),
      dispatcher.claimNotificationDelivery(BASE_TIME),
    ].filter(claim => claim !== null);

    expect(getEvent(malformed.id)).toMatchObject({
      status: 'failed',
      lastError: 'invalid_payload',
    });
    expect(claims.map(claim => claim.id)).toContain(valid.id);
  });

  it('durably classifies channel and subscription disappearance at dispatch time', async () => {
    const noSubscriptionEvent = (await createPending()).deliveryEvent!;
    await dispatcher.dispatchNotificationDeliveries({
      now: () => BASE_TIME,
      sender: vi.fn().mockResolvedValue({
        ...delivered,
        classification: 'no_subscription',
        attempted: 0,
        sent: 0,
      }),
    });

    expect(getEvent(noSubscriptionEvent.id)).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'no_subscription',
    });

    const unavailableEvent = (await createPending()).deliveryEvent!;
    await dispatcher.dispatchNotificationDeliveries({
      now: () => BASE_TIME,
      sender: vi.fn().mockResolvedValue({
        ...delivered,
        classification: 'channel_unconfigured',
        attempted: 0,
        sent: 0,
      }),
    });
    expect(getEvent(unavailableEvent.id)).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'channel_unconfigured',
    });
  });

  it('suppresses a queued event when its connector is deleted before dispatch', async () => {
    const event = (await createPending()).deliveryEvent!;
    db.update(schema.connectorConfigs).set({
      deletedAt: new Date(BASE_TIME.getTime() + 1_000).toISOString(),
      enabled: false,
    }).where(eq(schema.connectorConfigs.id, 'github-work')).run();
    const send = vi.fn().mockResolvedValue(delivered);

    await dispatcher.dispatchNotificationDeliveries({
      now: () => BASE_TIME,
      sender: send,
    });

    expect(send).not.toHaveBeenCalled();
    expect(getEvent(event.id)).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'connector_deleted',
    });
  });

  it('suppresses a claimed Finance digest when cutover rolls back before dispatch', async () => {
    db.insert(schema.connectorConfigs).values({
      id: 'finance-work',
      type: 'finance-manager',
      name: 'Finance Work',
      enabled: true,
      syncMode: 'poll',
      capabilities: {},
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).run();
    db.insert(schema.financeInsightCutovers).values({
      connectorId: 'finance-work',
      cutoverAt: BASE_TIME.toISOString(),
      sourceGeneration: 'source-generation',
      sourceSequence: 1,
      legacyDisabled: true,
      deliveryEnabled: true,
      createdAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).run();
    db.insert(schema.notificationPushRules).values({
      id: 'finance-digest-rule',
      connectorInstanceId: 'finance-work',
      templateKey: 'finance-insight-monthly-movers-digest',
      enabled: true,
      minLevel: 'digest',
      preview: 'title_and_body',
      maxPerHour: null,
      createdAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).run();
    const event = (await createPending({
      sourceId: 'finance-insight-digest:finance-work:2026-07',
      connectorType: 'finance-manager',
      connectorInstanceId: 'finance-work',
      level: 'digest',
      category: 'finance',
      templateKey: 'finance-insight-monthly-movers-digest',
    })).deliveryEvent!;
    db.update(schema.notificationDeliveryEvents).set({
      status: 'pending',
      suppressionReason: null,
      nextAttemptAt: BASE_TIME.toISOString(),
    }).where(eq(schema.notificationDeliveryEvents.id, event.id)).run();
    db.update(schema.financeInsightCutovers).set({
      deliveryEnabled: false,
      rolledBackAt: BASE_TIME.toISOString(),
      updatedAt: BASE_TIME.toISOString(),
    }).where(eq(schema.financeInsightCutovers.connectorId, 'finance-work')).run();
    const send = vi.fn().mockResolvedValue(delivered);

    await dispatcher.dispatchNotificationDeliveries({
      now: () => BASE_TIME,
      sender: send,
    });

    expect(send).not.toHaveBeenCalled();
    expect(getEvent(event.id)).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'connector_disabled',
    });
  });

  it('suppresses a queued event when it no longer needs attention before dispatch', async () => {
    const result = await createPending();
    db.update(schema.notifications).set({
      state: 'read',
      readState: 'read',
      readAt: BASE_TIME.toISOString(),
    }).where(eq(schema.notifications.id, result.notification.id)).run();
    const send = vi.fn().mockResolvedValue(delivered);

    await dispatcher.dispatchNotificationDeliveries({
      now: () => BASE_TIME,
      sender: send,
    });

    expect(send).not.toHaveBeenCalled();
    expect(getEvent(result.deliveryEvent!.id)).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'not_attention_eligible',
    });
  });

  it('rechecks mutable global suppression before a queued retry sends', async () => {
    const event = (await createPending()).deliveryEvent!;
    db.insert(schema.pushPreferences).values({
      id: 'default',
      morningEnabled: true,
      morningHour: 8,
      triageNudgeEnabled: true,
      triageNudgeThreshold: 5,
      carryForwardEnabled: true,
      carryForwardHour: 18,
      quietStart: null,
      quietEnd: null,
      doNotDisturb: true,
      updatedAt: BASE_TIME.toISOString(),
    }).run();
    const send = vi.fn().mockResolvedValue(delivered);

    await dispatcher.dispatchNotificationDeliveries({
      now: () => BASE_TIME,
      sender: send,
    });

    expect(send).not.toHaveBeenCalled();
    expect(getEvent(event.id)).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'dnd',
    });
  });

  it.each([404, 410])(
    'removes HTTP %s subscriptions and records a permanent failure',
    async statusCode => {
    const event = (await createPending()).deliveryEvent!;
    webPushMocks.sendNotification.mockRejectedValueOnce({ statusCode });

    await dispatcher.dispatchNotificationDeliveries({
      now: () => BASE_TIME,
      sender: sender.sendWebPushPayload,
    });

    expect(db.select().from(schema.pushSubscriptions).all()).toEqual([]);
    expect(getEvent(event.id)).toMatchObject({
      status: 'failed',
      subscriptionsAttempted: 1,
      subscriptionsFailed: 1,
      lastError: 'permanent_delivery_failure',
    });
    },
  );
});
