import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';
import db from '@/db';
import { notificationPushRules } from '@/db/schema';
import type { NotificationLevel } from '@/types';
import { isNotificationLevel } from '@/lib/notifications/levels';
import type {
  ConnectorNotificationTypeDefinition,
  PushPreview,
} from './catalog';
import { isPreviewSafeForType, isPushPreview } from './catalog';

export const MAX_NOTIFICATION_PUSHES_PER_HOUR = 1_000;

export type NotificationPushRule = typeof notificationPushRules.$inferSelect;

export interface SaveNotificationPushRuleInput {
  id?: string;
  connectorInstanceId: string;
  templateKey: string;
  enabled: boolean;
  minLevel: NotificationLevel;
  preview: PushPreview;
  maxPerHour?: number | null;
}

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
  const now = new Date().toISOString();
  const row = {
    id: input.id ?? crypto.randomUUID(),
    connectorInstanceId: input.connectorInstanceId,
    templateKey: input.templateKey,
    enabled: input.enabled,
    minLevel: input.minLevel,
    preview: input.preview,
    maxPerHour: input.maxPerHour ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const [saved] = await db.insert(notificationPushRules).values(row).onConflictDoUpdate({
    target: [
      notificationPushRules.connectorInstanceId,
      notificationPushRules.templateKey,
    ],
    set: {
      enabled: row.enabled,
      minLevel: row.minLevel,
      preview: row.preview,
      maxPerHour: row.maxPerHour,
      updatedAt: row.updatedAt,
    },
  }).returning();
  if (!saved) throw new Error('Notification push rule was not persisted');
  return saved;
}

export async function getNotificationPushRuleOverrides(
  connectorInstanceId: string,
  templateKey?: string,
): Promise<NotificationPushRule[]> {
  const keys = templateKey ? [templateKey, '*'] : null;
  return db.select().from(notificationPushRules).where(
    keys
      ? and(
          eq(notificationPushRules.connectorInstanceId, connectorInstanceId),
          inArray(notificationPushRules.templateKey, keys),
        )
      : eq(notificationPushRules.connectorInstanceId, connectorInstanceId),
  ).all();
}

export async function resetNotificationPushRule(
  connectorInstanceId: string,
  templateKey: string,
): Promise<void> {
  if (!connectorInstanceId.trim()) throw new Error('connectorInstanceId is required');
  if (!templateKey.trim()) throw new Error('templateKey is required');
  db.delete(notificationPushRules).where(and(
    eq(notificationPushRules.connectorInstanceId, connectorInstanceId),
    eq(notificationPushRules.templateKey, templateKey),
  )).run();
}
