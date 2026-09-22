import { expect, it } from 'vitest';
import type {
  NotificationDeliveryRepository,
} from '@/db/persistence/notification-delivery';

export const NOTIFICATION_DELIVERY_BASE_TIME = new Date('2026-08-31T12:00:00.000Z');

export interface NotificationDeliveryEventState {
  status: string;
  attemptCount: number;
  claimToken: string | null;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  suppressionReason: string | null;
  subscriptionsAttempted: number;
  subscriptionsSent: number;
  subscriptionsFailed: number;
}

export interface NotificationDeliveryContractHarness {
  repository: NotificationDeliveryRepository;
  reset(): Promise<void>;
  seedEvent(input: {
    id: string;
    createdAt?: string;
    nextAttemptAt?: string | null;
    status?: 'pending' | 'sending';
    attemptCount?: number;
    leaseExpiresAt?: string | null;
    claimToken?: string | null;
    payload?: unknown;
    connectorType?: string;
    connectorEnabled?: boolean;
    webhookEnabled?: boolean;
    financeDeliveryEnabled?: boolean;
    readState?: string;
  }): Promise<void>;
  getEvent(id: string): Promise<NotificationDeliveryEventState>;
  setDnd(enabled: boolean): Promise<void>;
  setQuietHours(start: number, end: number): Promise<void>;
  setChannelEnabled(enabled: boolean): Promise<void>;
  seedWebPushSubscription(id: string): Promise<void>;
  hasWebPushSubscription(id: string): Promise<boolean>;
  seedApnsRegistration(id: string): Promise<void>;
  getApnsInvalidation(id: string): Promise<string | null>;
}

const PAYLOAD = {
  notificationId: 'notification-contract',
  title: 'Portable notification',
  tag: 'mc:notification-contract',
  url: '/notifications?id=notification-contract',
};

export function describeNotificationDeliveryRepositoryContract(
  createHarness: () => Promise<NotificationDeliveryContractHarness>,
): void {
  let harness: NotificationDeliveryContractHarness;

  it('claims one owner, excludes live leases, recovers expiry, and fences stale owners', async () => {
    harness = await createHarness();
    await harness.reset();
    await harness.seedEvent({ id: 'ownership', payload: PAYLOAD });

    const [first, concurrent] = await Promise.all([
      harness.repository.claimNext({
        now: NOTIFICATION_DELIVERY_BASE_TIME,
        leaseMs: 60_000,
        maxAttempts: 5,
      }),
      harness.repository.claimNext({
        now: NOTIFICATION_DELIVERY_BASE_TIME,
        leaseMs: 60_000,
        maxAttempts: 5,
      }),
    ]);
    const owner = first ?? concurrent;
    expect(owner).not.toBeNull();
    expect(first === null || concurrent === null).toBe(true);
    expect(await harness.repository.claimNext({
      now: new Date(NOTIFICATION_DELIVERY_BASE_TIME.getTime() + 59_999),
      leaseMs: 60_000,
      maxAttempts: 5,
    })).toBeNull();

    const recovered = await harness.repository.claimNext({
      now: new Date(NOTIFICATION_DELIVERY_BASE_TIME.getTime() + 60_000),
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    expect(recovered).toMatchObject({ id: 'ownership', attemptCount: 2 });
    expect(recovered?.claimToken).not.toBe(owner?.claimToken);
    expect(await harness.repository.finalize(owner!, {
      status: 'sent',
      sentAt: NOTIFICATION_DELIVERY_BASE_TIME.toISOString(),
    })).toBe(false);
    expect(await harness.repository.finalize(recovered!, {
      status: 'sent',
      counters: { attempted: 1, sent: 1, failed: 0 },
      sentAt: NOTIFICATION_DELIVERY_BASE_TIME.toISOString(),
    })).toBe(true);
    expect(await harness.getEvent('ownership')).toMatchObject({
      status: 'sent',
      attemptCount: 2,
      claimToken: null,
      subscriptionsSent: 1,
    });
  });

  it('terminalizes exhausted and malformed rows without blocking the next event', async () => {
    harness = await createHarness();
    await harness.reset();
    await harness.seedEvent({
      id: 'exhausted',
      attemptCount: 2,
      payload: PAYLOAD,
      createdAt: '2026-08-31T11:58:00.000Z',
    });
    await harness.seedEvent({
      id: 'malformed',
      payload: 'not-an-object',
      createdAt: '2026-08-31T11:59:00.000Z',
    });
    await harness.seedEvent({ id: 'valid', payload: PAYLOAD });

    const claim = await harness.repository.claimNext({
      now: NOTIFICATION_DELIVERY_BASE_TIME,
      leaseMs: 60_000,
      maxAttempts: 2,
    });
    expect(claim?.id).toBe('valid');
    expect(await harness.getEvent('exhausted')).toMatchObject({
      status: 'failed',
      lastError: 'retry_limit_exhausted',
    });
    expect(await harness.getEvent('malformed')).toMatchObject({
      status: 'failed',
      lastError: 'invalid_payload',
    });
  });

  it('orders wakeups and enforces retry eligibility with token fencing', async () => {
    harness = await createHarness();
    await harness.reset();
    await harness.seedEvent({
      id: 'later',
      payload: PAYLOAD,
      nextAttemptAt: '2026-08-31T12:02:00.000Z',
    });

    await harness.seedEvent({
      id: 'earlier',
      payload: PAYLOAD,
      nextAttemptAt: '2026-08-31T12:01:00.000Z',
    });
    expect(await harness.repository.getNextWakeAt()).toBe('2026-08-31T12:01:00.000Z');
    expect(await harness.repository.claimNext({
      now: NOTIFICATION_DELIVERY_BASE_TIME,
      leaseMs: 60_000,
      maxAttempts: 5,
    })).toBeNull();

    const claim = await harness.repository.claimNext({
      now: new Date('2026-08-31T12:01:00.000Z'),
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    expect(claim?.id).toBe('earlier');
    expect(await harness.repository.scheduleRetry(claim!, {
      nextAttemptAt: '2026-08-31T12:03:00.000Z',
      counters: { attempted: 1, sent: 0, failed: 1 },
      lastError: 'transient_delivery_failure',
    })).toBe(true);
    expect(await harness.repository.scheduleRetry(claim!, {
      nextAttemptAt: '2026-08-31T12:04:00.000Z',
      lastError: 'stale',
    })).toBe(false);
    expect(await harness.getEvent('earlier')).toMatchObject({
      status: 'pending',
      nextAttemptAt: '2026-08-31T12:03:00.000Z',
      claimToken: null,
    });
  });

  it('persists sent, partial, terminal failure, and suppressed outcomes', async () => {
    harness = await createHarness();
    for (const [id, values, expected] of [
      [
        'sent-outcome',
        {
          status: 'sent' as const,
          counters: { attempted: 1, sent: 1, failed: 0 },
          sentAt: NOTIFICATION_DELIVERY_BASE_TIME.toISOString(),
        },
        { status: 'sent', subscriptionsSent: 1 },
      ],
      [
        'partial-outcome',
        {
          status: 'partial' as const,
          counters: { attempted: 2, sent: 1, failed: 1 },
          sentAt: NOTIFICATION_DELIVERY_BASE_TIME.toISOString(),
          lastError: 'partial_delivery_failure',
        },
        { status: 'partial', subscriptionsSent: 1, subscriptionsFailed: 1 },
      ],
      [
        'failed-outcome',
        {
          status: 'failed' as const,
          counters: { attempted: 1, sent: 0, failed: 1 },
          lastError: 'permanent_delivery_failure',
        },
        { status: 'failed', lastError: 'permanent_delivery_failure' },
      ],
      [
        'suppressed-outcome',
        {
          status: 'suppressed' as const,
          suppressionReason: 'connector_disabled' as const,
        },
        { status: 'suppressed', suppressionReason: 'connector_disabled' },
      ],
    ] as const) {
      await harness.reset();
      await harness.seedEvent({ id, payload: PAYLOAD });
      const claim = await harness.repository.claimNext({
        now: NOTIFICATION_DELIVERY_BASE_TIME,
        leaseMs: 60_000,
        maxAttempts: 5,
      });
      expect(await harness.repository.finalize(claim!, values)).toBe(true);
      expect(await harness.getEvent(id)).toMatchObject(expected);
    }
  });

  it('rechecks DND, attention, connector, webhook, and finance cutover state', async () => {
    harness = await createHarness();
    await harness.reset();
    await harness.seedEvent({ id: 'dnd', payload: PAYLOAD });
    await harness.setDnd(true);
    const dnd = await harness.repository.claimNext({
      now: NOTIFICATION_DELIVERY_BASE_TIME,
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    expect(await harness.repository.resolveSuppression(dnd!, {
      now: NOTIFICATION_DELIVERY_BASE_TIME,
      currentHour: 12,
      channelConfigured: true,
    })).toBe('dnd');

    await harness.reset();
    await harness.seedEvent({ id: 'quiet', payload: PAYLOAD });
    await harness.setQuietHours(11, 13);
    const quiet = await harness.repository.claimNext({
      now: NOTIFICATION_DELIVERY_BASE_TIME,
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    expect(await harness.repository.resolveSuppression(quiet!, {
      now: NOTIFICATION_DELIVERY_BASE_TIME,
      currentHour: 12,
      channelConfigured: true,
    })).toBe('quiet_hours');

    await harness.reset();
    await harness.seedEvent({ id: 'channel', payload: PAYLOAD });
    await harness.setChannelEnabled(false);
    const channel = await harness.repository.claimNext({
      now: NOTIFICATION_DELIVERY_BASE_TIME,
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    expect(await harness.repository.resolveSuppression(channel!, {
      now: NOTIFICATION_DELIVERY_BASE_TIME,
      currentHour: 12,
      channelConfigured: true,
    })).toBe('channel_disabled');

    await harness.reset();
    await harness.seedEvent({ id: 'read', payload: PAYLOAD, readState: 'read' });
    const read = await harness.repository.claimNext({
      now: NOTIFICATION_DELIVERY_BASE_TIME,
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    expect(await harness.repository.resolveSuppression(read!, {
      now: NOTIFICATION_DELIVERY_BASE_TIME,
      currentHour: 12,
      channelConfigured: true,
    })).toBe('not_attention_eligible');

    for (const scenario of [
      { id: 'connector', connectorEnabled: false },
      { id: 'webhook', connectorType: 'inbound-webhook', webhookEnabled: false },
      {
        id: 'finance',
        connectorType: 'finance-manager',
        financeDeliveryEnabled: false,
      },
    ]) {
      await harness.reset();
      await harness.seedEvent({ ...scenario, payload: PAYLOAD });
      const claim = await harness.repository.claimNext({
        now: NOTIFICATION_DELIVERY_BASE_TIME,
        leaseMs: 60_000,
        maxAttempts: 5,
      });
      expect(await harness.repository.resolveSuppression(claim!, {
        now: NOTIFICATION_DELIVERY_BASE_TIME,
        currentHour: 12,
        channelConfigured: true,
      })).toBe('connector_disabled');
    }
  });

  it('retires Web Push subscriptions and invalidates APNs registrations', async () => {
    harness = await createHarness();
    await harness.reset();
    await harness.seedWebPushSubscription('web-contract');
    expect(await harness.repository.listWebPushSubscriptions()).toHaveLength(1);
    expect(await harness.repository.retireWebPushSubscription('web-contract')).toBe(true);
    expect(await harness.hasWebPushSubscription('web-contract')).toBe(false);

    await harness.seedApnsRegistration('apns-contract');
    expect(await harness.repository.listApnsRegistrations({
      environment: 'development',
      topic: 'app.mission-control.test',
    })).toHaveLength(1);
    expect(await harness.repository.invalidateApnsRegistration({
      id: 'apns-contract',
      invalidatedAt: NOTIFICATION_DELIVERY_BASE_TIME.toISOString(),
      reason: 'BadDeviceToken',
    })).toBe(true);
    expect(await harness.getApnsInvalidation('apns-contract')).toBe('BadDeviceToken');
  });
}
