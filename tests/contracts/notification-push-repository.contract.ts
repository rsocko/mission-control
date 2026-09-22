import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PUSH_PREFERENCES,
  type NotificationPushPersistence,
  type NotificationPushPreferences,
} from '@/db/persistence/notification-push';

export const NOTIFICATION_PUSH_TEST_TIME = '2026-09-05T12:00:00.000Z';

export interface NotificationPushContractHarness {
  repository: NotificationPushPersistence;
  reset(): Promise<void>;
  seedSetting(key: string, value: unknown): Promise<void>;
  seedCalendarConnector(input: {
    id: string;
    enabled?: boolean;
    deleted?: boolean;
    credentials: unknown;
  }): Promise<void>;
}

function preferences(
  overrides: Partial<NotificationPushPreferences> = {},
): NotificationPushPreferences {
  return {
    ...DEFAULT_NOTIFICATION_PUSH_PREFERENCES,
    ...overrides,
  };
}

export function describeNotificationPushRepositoryContract(
  createHarness: () => Promise<NotificationPushContractHarness>,
): void {
  let harness: NotificationPushContractHarness;

  beforeEach(async () => {
    harness = await createHarness();
    await harness.reset();
  });

  describe('notification push persistence contract', () => {
    it('returns portable defaults when no rows exist', async () => {
      await expect(harness.repository.getPreferences()).resolves.toEqual(
        DEFAULT_NOTIFICATION_PUSH_PREFERENCES,
      );
      await expect(harness.repository.getPushDeliveryEnabled()).resolves.toBe(true);
      await expect(harness.repository.getScheduledSummariesEnabled()).resolves.toBe(true);
    });

    it('round-trips booleans, hours, thresholds, and nullable quiet hours', async () => {
      const expected = preferences({
        morningEnabled: false,
        morningHour: 6,
        triageNudgeEnabled: false,
        triageNudgeThreshold: 12,
        carryForwardEnabled: false,
        carryForwardHour: 21,
        quietStart: 22,
        quietEnd: 7,
        doNotDisturb: true,
      });

      await harness.repository.savePreferences({
        preferences: expected,
        pushDeliveryEnabled: false,
        updatedAt: NOTIFICATION_PUSH_TEST_TIME,
      });

      await expect(harness.repository.getPreferences()).resolves.toEqual(expected);
      await expect(harness.repository.getPushDeliveryEnabled()).resolves.toBe(false);
    });

    it('preserves a disabled master switch across concurrent legacy-client saves', async () => {
      await harness.repository.savePreferences({
        preferences: preferences(),
        pushDeliveryEnabled: false,
        updatedAt: NOTIFICATION_PUSH_TEST_TIME,
      });

      await Promise.all(Array.from({ length: 8 }, (_, index) => (
        harness.repository.savePreferences({
          preferences: preferences({ morningHour: index }),
          updatedAt: new Date(Date.parse(NOTIFICATION_PUSH_TEST_TIME) + index).toISOString(),
        })
      )));

      await expect(harness.repository.getPushDeliveryEnabled()).resolves.toBe(false);
    });

    it('persists scheduler enablement independently from preferences', async () => {
      await harness.repository.setScheduledSummariesEnabled(false, NOTIFICATION_PUSH_TEST_TIME);
      await expect(harness.repository.getScheduledSummariesEnabled()).resolves.toBe(false);
      await expect(harness.repository.getPreferences()).resolves.toEqual(
        DEFAULT_NOTIFICATION_PUSH_PREFERENCES,
      );

      await harness.repository.setScheduledSummariesEnabled(
        true,
        new Date(Date.parse(NOTIFICATION_PUSH_TEST_TIME) + 1).toISOString(),
      );
      await expect(harness.repository.getScheduledSummariesEnabled()).resolves.toBe(true);
    });

    it('accepts legacy object settings and rejects all other shapes as disabled', async () => {
      await harness.seedSetting('push_delivery_enabled', { enabled: true });
      await expect(harness.repository.getPushDeliveryEnabled()).resolves.toBe(true);

      await harness.seedSetting('push_delivery_enabled', { enabled: false });
      await expect(harness.repository.getPushDeliveryEnabled()).resolves.toBe(false);

      await harness.seedSetting('push_delivery_enabled', 'not-a-boolean');
      await expect(harness.repository.getPushDeliveryEnabled()).resolves.toBe(false);
    });

    it('projects only active calendar access tokens in stable connector order', async () => {
      await harness.seedCalendarConnector({
        id: 'calendar-b',
        credentials: { access_token: 'token-b', refreshToken: 'secret-b' },
      });
      await harness.seedCalendarConnector({
        id: 'calendar-a',
        credentials: { accessToken: 'token-a', refreshToken: 'secret-a' },
      });
      await harness.seedCalendarConnector({
        id: 'calendar-disabled',
        enabled: false,
        credentials: { accessToken: 'token-disabled' },
      });
      await harness.seedCalendarConnector({
        id: 'calendar-deleted',
        deleted: true,
        credentials: { accessToken: 'token-deleted' },
      });
      await harness.seedCalendarConnector({
        id: 'calendar-no-token',
        credentials: { refreshToken: 'secret-only' },
      });

      await expect(harness.repository.listActiveCalendarAccessTokens()).resolves.toEqual([
        'token-a',
        'token-b',
      ]);
    });
  });
}
