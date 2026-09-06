import 'server-only';

import type { NotificationDeliveryChannel } from './push-payload';
import {
  getWorkerPersistenceRepositories,
} from '@/lib/persistence/worker-runtime';
import { wakeNotificationDeliveryDispatcher } from './dispatcher-wake';
import {
  normalizeInternalNavigationTarget,
  type MissionControlPushPayload,
} from './push-payload';
import { NOTIFICATION_CREATION_TRANSACTION } from '@/db/persistence/notification-delivery';
import type {
  CreateNotificationInput,
  CreateNotificationOptions,
  CreateNotificationResult,
  NotificationDeliveryStatus,
  NotificationSuppressionReason,
} from '@/db/persistence/notification-delivery';

export const PUSH_DELIVERY_SETTING_KEY = 'push_delivery_enabled';
export const DEFAULT_GLOBAL_PUSHES_PER_HOUR = 100;

export { wakeNotificationDeliveryDispatcher };
export {
  normalizeInternalNavigationTarget,
  type MissionControlPushPayload,
  type NotificationDeliveryChannel,
};
export type {
  CreateNotificationInput,
  CreateNotificationOptions,
  CreateNotificationResult,
  NotificationDeliveryStatus,
  NotificationSuppressionReason,
};

export function redactPushText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[^\s,;]+/gi,
      'Authorization: [redacted]',
    )
    .replace(
      /["']?\b(access[_-]?token|api[_-]?key|password|secret|token|credential|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1=[redacted]',
    );
  return redacted.slice(0, maxLength);
}

async function selectedNotificationDelivery() {
  return (await getWorkerPersistenceRepositories()).notificationDelivery;
}

export async function resolveCurrentGlobalPushSuppression(
  now = new Date(),
  channel: NotificationDeliveryChannel = 'web_push',
): Promise<'channel_disabled' | 'channel_unconfigured' | 'dnd' | 'quiet_hours' | null> {
  return (await selectedNotificationDelivery()).creation
    .resolveCurrentGlobalPushSuppression(now, channel);
}

export async function createNotifications(
  inputs: readonly CreateNotificationInput[],
  options: CreateNotificationOptions = {},
): Promise<CreateNotificationResult[]> {
  if (inputs.length === 0) return [];
  const results = await (await selectedNotificationDelivery()).creation
    .createNotifications(inputs, options);
  if (
    options.wakeDispatcher !== false
    && results.some(result => result.deliveryEvents.some(event => event.status === 'pending'))
  ) {
    wakeNotificationDeliveryDispatcher();
  }
  return results;
}

export function createNotificationsInTransaction(
  transaction: unknown,
  inputs: readonly CreateNotificationInput[],
  options: CreateNotificationOptions = {},
): CreateNotificationResult[] {
  if (
    transaction === null
    || (typeof transaction !== 'object' && typeof transaction !== 'function')
  ) {
    throw new Error('Notification creation transaction capability is unavailable');
  }
  const capability = Reflect.get(transaction, NOTIFICATION_CREATION_TRANSACTION);
  if (typeof capability !== 'function') {
    throw new Error('Notification creation transaction capability is unavailable');
  }
  return capability.call(transaction, inputs, options) as CreateNotificationResult[];
}

export async function createNotification(
  input: CreateNotificationInput,
  options: CreateNotificationOptions = {},
): Promise<CreateNotificationResult> {
  const [result] = await createNotifications([input], options);
  return result;
}

export async function countPendingNotificationDeliveries(): Promise<number> {
  return (await selectedNotificationDelivery()).creation.countPendingDeliveries();
}
