import { describe, expectTypeOf, it } from 'vitest';
import type {
  NotificationCreationPersistence,
  NotificationDeliveryRepository,
  NotificationPushPolicyPersistence,
  NotificationPushRulePersistence,
  ScheduledNotificationTriggerPersistence,
} from '@/db/persistence/notification-delivery';
import type { NotificationWebPersistence } from '@/db/persistence/notification-web';
import type {
  AlertmanagerRepository,
  WebhookIntegrationsPersistence,
} from '@/db/persistence/webhook-integrations';

describe('notification delivery web composition contract', () => {
  it('keeps every migrated capability backend-neutral and asynchronous', () => {
    expectTypeOf<NotificationDeliveryRepository['creation']>()
      .toEqualTypeOf<NotificationCreationPersistence>();
    expectTypeOf<NotificationDeliveryRepository['pushRules']>()
      .toEqualTypeOf<NotificationPushRulePersistence>();
    expectTypeOf<NotificationDeliveryRepository['policy']>()
      .toEqualTypeOf<NotificationPushPolicyPersistence>();
    expectTypeOf<NotificationDeliveryRepository['scheduledTriggers']>()
      .toEqualTypeOf<ScheduledNotificationTriggerPersistence>();
    expectTypeOf<NotificationDeliveryRepository['web']>()
      .toEqualTypeOf<NotificationWebPersistence>();
    expectTypeOf<NonNullable<WebhookIntegrationsPersistence['alertmanager']>>()
      .toEqualTypeOf<AlertmanagerRepository>();

    expectTypeOf<ReturnType<NotificationCreationPersistence['createNotifications']>>()
      .toExtend<Promise<unknown>>();
    expectTypeOf<ReturnType<NotificationWebPersistence['applyReminderAction']>>()
      .toExtend<Promise<unknown>>();
    expectTypeOf<ReturnType<NotificationWebPersistence['finalizeWorkflowAction']>>()
      .toEqualTypeOf<Promise<boolean>>();
    expectTypeOf<ReturnType<AlertmanagerRepository['ingestBatch']>>()
      .toExtend<Promise<unknown>>();
  });

  it('gives both adapters the same complete repository shape', () => {
    expectTypeOf<
      ReturnType<typeof import('@/db/persistence/sqlite-notification-delivery-repository')
        .createSqliteNotificationDeliveryRepository>
    >().toEqualTypeOf<NotificationDeliveryRepository>();
    expectTypeOf<
      ReturnType<typeof import('@/db/postgres/repositories/notification-delivery-repository')
        .createPostgresNotificationDeliveryRepository>
    >().toEqualTypeOf<NotificationDeliveryRepository>();
    expectTypeOf<
      ReturnType<typeof import('@/db/persistence/sqlite-notification-web-repository')
        .createSqliteNotificationWebRepository>
    >().toExtend<NotificationWebPersistence>();
    expectTypeOf<
      ReturnType<typeof import('@/db/postgres/repositories/notification-web-repository')
        .createPostgresNotificationWebRepository>
    >().toEqualTypeOf<NotificationWebPersistence>();
    expectTypeOf<
      ReturnType<typeof import('@/db/persistence/sqlite-webhook-integrations-repository')
        .createSqliteWebhookIntegrationsRepository>
    >().toEqualTypeOf<WebhookIntegrationsPersistence>();
    expectTypeOf<
      ReturnType<typeof import('@/db/postgres/repositories/webhook-integrations-repository')
        .createPostgresWebhookIntegrationsRepository>
    >().toEqualTypeOf<WebhookIntegrationsPersistence>();
  });
});
