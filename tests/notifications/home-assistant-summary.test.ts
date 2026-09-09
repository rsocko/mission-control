import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listEnabled: vi.fn(),
  queryNotifications: vi.fn(),
  enqueueCustomDeliveries: vi.fn(),
}));

vi.mock('@/lib/mode', () => ({
  getTimezone: () => 'UTC',
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    connectors: { listEnabled: mocks.listEnabled },
    notificationDelivery: {
      web: { queryNotifications: mocks.queryNotifications },
      enqueueCustomDeliveries: mocks.enqueueCustomDeliveries,
    },
  }),
}));

import { triggerHomeAssistantUpdateSummaries } from '@/lib/push/triggers';

function update(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notification-1',
    connectorInstanceId: 'ha-lake',
    title: 'Router is available',
    templateKey: 'ha_update_available',
    disposition: 'inbox',
    sourceState: 'active',
    readState: 'unread',
    metadata: { pushDelivery: 'daily_summary' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listEnabled.mockResolvedValue([{
    id: 'ha-lake',
    type: 'home-assistant',
    settings: {
      baseUrl: 'https://ha.example.test',
      outboundDelivery: {
        updatePush: 'daily_summary',
        dailySummaryTime: '09:00',
      },
    },
  }]);
  mocks.queryNotifications.mockResolvedValue({ items: [update()], nextCursor: null });
  mocks.enqueueCustomDeliveries.mockResolvedValue(2);
});

describe('Home Assistant outbound update summaries', () => {
  it('queues one device-only summary at the configured local time', async () => {
    const now = new Date('2025-07-01T09:00:00.000Z');

    await expect(triggerHomeAssistantUpdateSummaries(now)).resolves.toBe(true);
    expect(mocks.enqueueCustomDeliveries).toHaveBeenCalledOnce();
    expect(mocks.enqueueCustomDeliveries).toHaveBeenCalledWith({
      notificationId: 'notification-1',
      dedupeKey: 'home-assistant-update-summary:ha-lake:2025-07-01',
      nextAttemptAt: now.toISOString(),
      payload: {
        notificationId: 'notification-1',
        title: '1 Home Assistant update available',
        body: 'Router',
        tag: 'ha-update-summary:ha-lake:2025-07-01',
        url: '/notifications?source=home-assistant&sourceAccount=ha-lake',
      },
    });
  });

  it('does not queue before the configured time or include immediate critical updates', async () => {
    await expect(triggerHomeAssistantUpdateSummaries(
      new Date('2025-07-01T08:59:00.000Z'),
    )).resolves.toBe(false);
    expect(mocks.enqueueCustomDeliveries).not.toHaveBeenCalled();

    mocks.queryNotifications.mockResolvedValue({
      items: [update({
        id: 'critical-update',
        templateKey: 'ha_update_critical',
        metadata: { pushDelivery: 'immediate' },
      })],
      nextCursor: null,
    });
    await expect(triggerHomeAssistantUpdateSummaries(
      new Date('2025-07-01T09:00:00.000Z'),
    )).resolves.toBe(false);
    expect(mocks.enqueueCustomDeliveries).not.toHaveBeenCalled();
  });

  it('excludes read updates so a read anchor cannot suppress an unread summary', async () => {
    mocks.queryNotifications.mockResolvedValue({
      items: [
        update({ id: 'read-update', readState: 'read' }),
        update({ id: 'unread-update', title: 'ESPHome is available' }),
      ],
      nextCursor: null,
    });

    await triggerHomeAssistantUpdateSummaries(new Date('2025-07-01T09:00:00.000Z'));

    expect(mocks.enqueueCustomDeliveries).toHaveBeenCalledWith(expect.objectContaining({
      notificationId: 'unread-update',
      payload: expect.objectContaining({
        title: '1 Home Assistant update available',
        body: 'ESPHome',
      }),
    }));
  });

  it('groups only active individual updates from the matching instance', async () => {
    mocks.queryNotifications.mockResolvedValue({
      items: [
        update(),
        update({ id: 'notification-2', title: 'ESPHome is available' }),
        update({ id: 'resolved', disposition: 'handled' }),
        update({ id: 'other-home', connectorInstanceId: 'ha-city' }),
      ],
      nextCursor: null,
    });

    await triggerHomeAssistantUpdateSummaries(new Date('2025-07-01T09:00:00.000Z'));

    expect(mocks.enqueueCustomDeliveries).toHaveBeenCalledWith(expect.objectContaining({
      notificationId: 'notification-1',
      payload: expect.objectContaining({
        title: '2 Home Assistant updates available',
        body: 'Router, ESPHome',
      }),
    }));
  });
});
