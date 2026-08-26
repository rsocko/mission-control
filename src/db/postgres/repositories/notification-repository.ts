import { and, eq, notInArray } from 'drizzle-orm';
import type { NotificationAction, NotificationItem } from '@/types';
import type { NotificationRepository } from '@/db/persistence/core-repositories';
import type { PostgresDatabase, PostgresTransaction } from '../runtime';
import { notificationActions, notifications } from '../schema';

type NotificationRow = typeof notifications.$inferSelect;
type NotificationActionRow = typeof notificationActions.$inferSelect;

type Queryable = PostgresDatabase | PostgresTransaction;

function toNotificationAction(row: NotificationActionRow): NotificationAction {
  return {
    id: row.id,
    notificationId: row.notificationId,
    actionType: row.actionType,
    label: row.label,
    icon: row.icon ?? undefined,
    variant: row.variant as NotificationAction['variant'],
    isPrimary: row.isPrimary,
    sortOrder: row.sortOrder,
    payload: row.payload as Record<string, unknown>,
    opensExternal: row.opensExternal,
    requiresConfirmation: row.requiresConfirmation,
    createdBy: row.createdBy as NotificationAction['createdBy'],
  };
}

function toNotificationItem(
  row: NotificationRow,
  actions: NotificationAction[],
): NotificationItem {
  return {
    id: row.id,
    sourceId: row.sourceId,
    connectorType: row.connectorType,
    connectorInstanceId: row.connectorInstanceId,
    title: row.title,
    body: row.body,
    level: row.level as NotificationItem['level'],
    levelRank: row.levelRank,
    category: row.category,
    templateKey: row.templateKey,
    state: row.state as NotificationItem['state'],
    readState: row.readState as NotificationItem['readState'],
    disposition: row.disposition as NotificationItem['disposition'],
    sourceState: row.sourceState as NotificationItem['sourceState'],
    syncState: row.syncState as NotificationItem['syncState'],
    readAt: row.readAt,
    handledAt: row.handledAt,
    dismissedAt: row.dismissedAt,
    resolvedAt: row.resolvedAt,
    archivedAt: row.archivedAt,
    mutedAt: row.mutedAt,
    snoozedUntil: row.snoozedUntil,
    sourceResolvedAt: row.sourceResolvedAt,
    lastSourceActivityAt: row.lastSourceActivityAt,
    lastSourceActivityKey: row.lastSourceActivityKey,
    handledSourceActivityAt: row.handledSourceActivityAt,
    handledSourceActivityKey: row.handledSourceActivityKey,
    lastSourceSyncedAt: row.lastSourceSyncedAt,
    isActionable: row.isActionable,
    primaryActionId: row.primaryActionId,
    aiSuggestedActionId: row.aiSuggestedActionId,
    receivedAt: row.receivedAt,
    sortAt: row.sortAt,
    expiresAt: row.expiresAt,
    groupKey: row.groupKey,
    dedupeKey: row.dedupeKey,
    relatedTaskId: row.relatedTaskId,
    relatedProjectId: row.relatedProjectId,
    relatedEntityType: row.relatedEntityType,
    relatedEntityId: row.relatedEntityId,
    navigationTarget: row.navigationTarget,
    metadata: row.metadata as Record<string, unknown>,
    presentation: row.presentation as Record<string, unknown>,
    actions,
  };
}

async function loadActions(
  client: Queryable,
  notificationId: string,
): Promise<NotificationAction[]> {
  const rows = await client
    .select()
    .from(notificationActions)
    .where(eq(notificationActions.notificationId, notificationId));
  return rows.map(toNotificationAction);
}

/**
 * Replaces the notification's action set with `actions`, preserving each
 * surviving action's execution-lifecycle columns (`executionState`,
 * `claimedAt`, `completedAt`, `lastError`) since those aren't part of the
 * portable `NotificationAction` domain type and are only ever mutated by the
 * action-execution pipeline, never by this repository.
 */
async function syncActions(
  tx: PostgresTransaction,
  notificationId: string,
  actions: NotificationAction[],
): Promise<void> {
  const keepIds = actions.map((action) => action.id);
  if (keepIds.length > 0) {
    await tx
      .delete(notificationActions)
      .where(
        and(
          eq(notificationActions.notificationId, notificationId),
          notInArray(notificationActions.id, keepIds),
        ),
      );
  } else {
    await tx
      .delete(notificationActions)
      .where(eq(notificationActions.notificationId, notificationId));
  }

  for (const action of actions) {
    await tx
      .insert(notificationActions)
      .values({
        id: action.id,
        notificationId,
        actionType: action.actionType,
        label: action.label,
        icon: action.icon ?? null,
        variant: action.variant,
        isPrimary: action.isPrimary,
        sortOrder: action.sortOrder,
        payload: action.payload,
        opensExternal: action.opensExternal,
        requiresConfirmation: action.requiresConfirmation,
        createdBy: action.createdBy,
      })
      .onConflictDoUpdate({
        target: notificationActions.id,
        set: {
          notificationId,
          actionType: action.actionType,
          label: action.label,
          icon: action.icon ?? null,
          variant: action.variant,
          isPrimary: action.isPrimary,
          sortOrder: action.sortOrder,
          payload: action.payload,
          opensExternal: action.opensExternal,
          requiresConfirmation: action.requiresConfirmation,
          createdBy: action.createdBy,
        },
      });
  }
}

/**
 * PostgreSQL-backed implementation of the portable `NotificationRepository`
 * contract. Notification actions are hydrated on every `get` and are only
 * written when `notification.actions` is provided on `upsert` (matching the
 * "hydrated on read" contract for `NotificationItem.actions`) — omitting
 * `actions` leaves the existing action rows untouched.
 */
export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async get(id: string): Promise<NotificationItem | null> {
    const [row] = await this.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, id))
      .limit(1);
    if (!row) return null;
    const actions = await loadActions(this.db, id);
    return toNotificationItem(row, actions);
  }

  async upsert(notification: NotificationItem): Promise<NotificationItem> {
    return this.db.transaction(async (tx) => {
      const values = {
        id: notification.id,
        sourceId: notification.sourceId,
        connectorType: notification.connectorType,
        connectorInstanceId: notification.connectorInstanceId,
        title: notification.title,
        body: notification.body ?? null,
        level: notification.level,
        levelRank: notification.levelRank,
        category: notification.category,
        templateKey: notification.templateKey ?? null,
        state: notification.state,
        readState: notification.readState,
        disposition: notification.disposition,
        sourceState: notification.sourceState,
        syncState: notification.syncState,
        readAt: notification.readAt ?? null,
        handledAt: notification.handledAt ?? null,
        dismissedAt: notification.dismissedAt ?? null,
        resolvedAt: notification.resolvedAt ?? null,
        archivedAt: notification.archivedAt ?? null,
        mutedAt: notification.mutedAt ?? null,
        snoozedUntil: notification.snoozedUntil ?? null,
        sourceResolvedAt: notification.sourceResolvedAt ?? null,
        lastSourceActivityAt: notification.lastSourceActivityAt ?? null,
        lastSourceActivityKey: notification.lastSourceActivityKey ?? null,
        handledSourceActivityAt: notification.handledSourceActivityAt ?? null,
        handledSourceActivityKey: notification.handledSourceActivityKey ?? null,
        lastSourceSyncedAt: notification.lastSourceSyncedAt ?? null,
        isActionable: notification.isActionable,
        primaryActionId: notification.primaryActionId ?? null,
        aiSuggestedActionId: notification.aiSuggestedActionId ?? null,
        receivedAt: notification.receivedAt,
        sortAt: notification.sortAt,
        expiresAt: notification.expiresAt ?? null,
        groupKey: notification.groupKey ?? null,
        dedupeKey: notification.dedupeKey ?? null,
        relatedTaskId: notification.relatedTaskId ?? null,
        relatedProjectId: notification.relatedProjectId ?? null,
        relatedEntityType: notification.relatedEntityType ?? null,
        relatedEntityId: notification.relatedEntityId ?? null,
        navigationTarget: notification.navigationTarget ?? null,
        metadata: notification.metadata,
        presentation: notification.presentation,
      };

      const [row] = await tx
        .insert(notifications)
        .values(values)
        .onConflictDoUpdate({
          target: notifications.id,
          set: values,
        })
        .returning();

      if (notification.actions) {
        await syncActions(tx, notification.id, notification.actions);
      }

      const actions = await loadActions(tx, notification.id);
      return toNotificationItem(row, actions);
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.delete(notificationActions).where(eq(notificationActions.notificationId, id));
      const deleted = await tx
        .delete(notifications)
        .where(eq(notifications.id, id))
        .returning({ id: notifications.id });
      return deleted.length > 0;
    });
  }
}
