import 'server-only';

import { isNotificationLevel } from '@/lib/notifications/levels';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type {
  ConnectorNotificationTypeDefinition,
} from './catalog';
import { isPreviewSafeForType, isPushPreview } from './catalog';
import { MAX_NOTIFICATION_PUSHES_PER_HOUR } from './constants';
import type {
  NotificationPushRule,
  SaveNotificationPushRuleInput,
} from '@/db/persistence/notification-delivery';

export { MAX_NOTIFICATION_PUSHES_PER_HOUR } from './constants';

export type { NotificationPushRule, SaveNotificationPushRuleInput };

export function validateNotificationPushRule(
  input: SaveNotificationPushRuleInput,
  definition?: ConnectorNotificationTypeDefinition,
): void {
  if (!input.connectorInstanceId.trim()) throw new Error('connectorInstanceId is required');
  if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean');
  if (
    input.templateKey !== '*'
    && !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(input.templateKey)
  ) {
    throw new Error('templateKey must be "*" or lowercase snake case');
  }
  if (!isNotificationLevel(input.minLevel)) {
    throw new Error(`Invalid notification level: ${String(input.minLevel)}`);
  }
  if (!isPushPreview(input.preview)) {
    throw new Error(`Invalid push preview: ${String(input.preview)}`);
  }
  if (input.templateKey !== '*' && !definition) {
    throw new Error('An eligible catalog definition is required for exact rules');
  }
  if (definition && definition.key !== input.templateKey) {
    throw new Error(`Notification type "${definition.key}" does not match the rule templateKey`);
  }
  if (definition && !definition.pushEligible) {
    throw new Error(`Notification type "${definition.key}" is not push-eligible`);
  }
  if (definition && !isPreviewSafeForType(definition, input.preview)) {
    throw new Error(`Notification type "${definition.key}" does not allow body previews`);
  }
  if (
    input.maxPerHour !== undefined
    && input.maxPerHour !== null
    && (
      !Number.isInteger(input.maxPerHour)
      || input.maxPerHour < 1
      || input.maxPerHour > MAX_NOTIFICATION_PUSHES_PER_HOUR
    )
  ) {
    throw new Error(
      `maxPerHour must be null or an integer from 1 to ${MAX_NOTIFICATION_PUSHES_PER_HOUR}`,
    );
  }
}

export async function saveNotificationPushRule(
  input: SaveNotificationPushRuleInput,
  definition?: ConnectorNotificationTypeDefinition,
): Promise<NotificationPushRule> {
  validateNotificationPushRule(input, definition);
  return (await getWorkerPersistenceRepositories()).notificationDelivery.pushRules
    .save(input, definition);
}

export async function getNotificationPushRuleOverrides(
  connectorInstanceId: string,
  templateKey?: string,
): Promise<NotificationPushRule[]> {
  return (await getWorkerPersistenceRepositories()).notificationDelivery.pushRules
    .listOverrides(connectorInstanceId, templateKey);
}

export async function resetNotificationPushRule(
  connectorInstanceId: string,
  templateKey: string,
): Promise<void> {
  if (!connectorInstanceId.trim()) throw new Error('connectorInstanceId is required');
  if (!templateKey.trim()) throw new Error('templateKey is required');
  await (await getWorkerPersistenceRepositories()).notificationDelivery.pushRules
    .reset(connectorInstanceId, templateKey);
}
