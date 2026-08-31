import 'server-only';

import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';
import db, { sqlite } from '@/db';
import * as schema from '@/db/schema';
import { notificationActions, notifications } from '@/db/schema';
import {
  createNotificationsInTransaction,
  type CreateNotificationInput,
  type CreateNotificationResult,
} from '@/lib/notifications/service';
import {
  materializeNotificationActions,
  registerDefaultNotificationProviders,
  resolveNotificationProvider,
} from '@/lib/notifications/providers';
import type { InboundNotification } from '@/types';
import type { InsightOccurrenceSummaryV1 } from '@/lib/finance-insights/contract';
import {
  isOccurrenceNotificationEligible,
  notificationMetadata,
  type FinanceNotificationEnvironment,
} from '@/lib/finance-insights/notification-shared';
import type {
  FinanceInsightNotificationIngestItem,
  FinanceInsightNotificationLifecycleOutcome,
  FinanceInsightNotificationLifecyclePersistence,
  FinanceInsightNotificationReconcileItem,
} from './finance-insights';

/**
 * SQLite-only finance-insight notification lifecycle helpers.
 *
 * This module has two halves:
 *
 * - `reconcileFinanceInsightNotificationLifecycle` / `syncFinanceProviderPresentation`
 *   are moved unchanged from the former `src/lib/finance-insights/notification-lifecycle.ts`
 *   (deleted). `cutover.ts` (SQLite-only, not part of the migrated Layer 5B
 *   path) runs its own atomic transaction and needs synchronous,
 *   transaction-scoped access to these two using the lib's own
 *   `InsightOccurrenceSummaryV1` occurrence shape.
 * - `createSqliteFinanceInsightNotificationLifecyclePersistence` implements
 *   `FinanceInsightPersistence.notifications` (the portable port used by the
 *   migrated `notification-ingestion.ts` path): same reconcile/create-dedupe/
 *   presentation-sync behavior, but operating on the backend-neutral
 *   `FinanceInsightNotificationReconcileItem` / `ConnectorNotificationInput`
 *   shapes instead of lib-specific occurrence summaries.
 */

type SqliteDatabase = Database.Database;
type DrizzleDatabase = BetterSQLite3Database<typeof schema>;
type NotificationTransaction = Parameters<typeof createNotificationsInTransaction>[0];

// ─── cutover.ts-only legacy helpers (unchanged behavior) ────────────────────

export function reconcileFinanceInsightNotificationLifecycle(
  transaction: NotificationTransaction,
  connectorId: string,
  items: readonly InsightOccurrenceSummaryV1[],
  now: Date,
  environment: FinanceNotificationEnvironment = process.env,
): void {
  const nowIso = now.toISOString();
  for (const item of items) {
    if (
      item.sourceLifecycle === 'open'
      && isOccurrenceNotificationEligible(item, now, environment)
    ) {
      continue;
    }

    const sourceId = `finance-insight:${connectorId}:${item.occurrenceId}`;
    const existing = transaction.select({
      id: notifications.id,
      disposition: notifications.disposition,
      sourceResolvedAt: notifications.sourceResolvedAt,
    }).from(notifications).where(and(
      eq(notifications.sourceId, sourceId),
      eq(notifications.connectorType, 'finance-manager'),
      eq(notifications.connectorInstanceId, connectorId),
    )).get();
    if (!existing) continue;

    const state = existing.disposition === 'dismissed'
      ? 'dismissed'
      : existing.disposition === 'handled'
        ? 'archived'
        : 'resolved';
    transaction.update(notifications).set({
      state,
      sourceState: 'resolved',
      sourceResolvedAt: existing.sourceResolvedAt ?? item.resolvedAt ?? nowIso,
      lastSourceActivityAt: item.updatedAt,
      lastSourceActivityKey: `${item.occurrenceId}:${item.deliveryRevision}`,
      lastSourceSyncedAt: nowIso,
      isActionable: false,
      primaryActionId: null,
      metadata: notificationMetadata(item),
    }).where(eq(notifications.id, existing.id)).run();
    transaction.delete(notificationActions).where(and(
      eq(notificationActions.notificationId, existing.id),
      eq(notificationActions.createdBy, 'connector'),
    )).run();
  }
}

function providerNotification(
  result: CreateNotificationResult,
): InboundNotification {
  const notification = result.notification;
  return {
    id: notification.id,
    sourceId: notification.sourceId,
    connectorType: notification.connectorType,
    connectorInstanceId: notification.connectorInstanceId,
    title: notification.title,
    body: notification.body ?? undefined,
    level: notification.level as InboundNotification['level'],
    category: notification.category,
    isRead: notification.readState === 'read',
    isActionable: notification.isActionable,
    receivedAt: notification.receivedAt,
    hubProjectIds: [],
    tags: [],
    metadata: notification.metadata as Record<string, unknown>,
  };
}

export function syncFinanceProviderPresentation(
  transaction: NotificationTransaction,
  results: readonly CreateNotificationResult[],
): void {
  registerDefaultNotificationProviders();
  for (const result of results) {
    const resolved = resolveNotificationProvider(providerNotification(result));
    if (!resolved) continue;
    const active = result.notification.sourceState === 'active';
    const drafts = active
      ? (resolved.presentation.actions ?? []).filter((action) => action.actionType !== 'create_task')
      : [];
    const actionRecords = materializeNotificationActions(
      result.notification.id,
      drafts,
      (() => {
        let index = 0;
        return () => `${result.notification.id}:finance-action:${index++}`;
      })(),
    );
    transaction.delete(notificationActions).where(and(
      eq(notificationActions.notificationId, result.notification.id),
      eq(notificationActions.createdBy, 'connector'),
    )).run();
    if (actionRecords.length > 0) {
      transaction.insert(notificationActions).values(actionRecords).run();
    }
    transaction.update(notifications).set({
      title: resolved.presentation.title ?? result.notification.title,
      body: resolved.presentation.body ?? result.notification.body,
      presentation: {
        ...(result.notification.presentation !== null
          && typeof result.notification.presentation === 'object'
          && !Array.isArray(result.notification.presentation)
          ? result.notification.presentation
          : {}),
        ...(resolved.presentation.presentation ?? {}),
      },
      isActionable: active && (resolved.presentation.isActionable ?? actionRecords.length > 0),
      primaryActionId: actionRecords.find((action) => action.isPrimary)?.id ?? null,
    }).where(eq(notifications.id, result.notification.id)).run();
  }
}

// ─── Portable FinanceInsightPersistence.notifications adapter ──────────────

interface SqliteFinanceInsightNotificationHandles {
  sqlite: SqliteDatabase;
  db: DrizzleDatabase;
}

function defaultHandles(): SqliteFinanceInsightNotificationHandles {
  return { sqlite, db };
}

function toCreateNotificationInput(
  item: FinanceInsightNotificationIngestItem,
): CreateNotificationInput {
  const input = item.input;
  return {
    id: input.id,
    sourceId: input.sourceId,
    connectorType: input.connectorType,
    connectorInstanceId: input.connectorInstanceId,
    title: input.title,
    body: input.body,
    level: input.level,
    category: input.category,
    templateKey: input.templateKey,
    readState: input.readState,
    disposition: input.disposition,
    sourceState: input.sourceState,
    syncState: input.syncState,
    sourceActivityAt: input.sourceActivityAt,
    sourceActivityKey: input.sourceActivityKey,
    reopenPolicy: input.reopenPolicy,
    occurrenceKey: input.occurrenceKey,
    isActionable: input.isActionable,
    primaryActionId: input.primaryActionId,
    receivedAt: input.receivedAt,
    sortAt: input.sortAt,
    relatedTaskId: input.relatedTaskId,
    relatedProjectId: input.relatedProjectId,
    relatedEntityType: input.relatedEntityType,
    relatedEntityId: input.relatedEntityId,
    navigationTarget: input.navigationTarget,
    metadata: input.metadata,
    presentation: input.presentation,
    groupKey: item.groupKey,
    dedupeKey: item.dedupeKey,
  };
}

function reconcilePortable(
  transaction: NotificationTransaction,
  connectorId: string,
  items: readonly FinanceInsightNotificationReconcileItem[],
  nowIso: string,
): void {
  for (const item of items) {
    const existing = transaction.select({
      id: notifications.id,
      disposition: notifications.disposition,
      sourceResolvedAt: notifications.sourceResolvedAt,
    }).from(notifications).where(and(
      eq(notifications.sourceId, item.sourceId),
      eq(notifications.connectorType, 'finance-manager'),
      eq(notifications.connectorInstanceId, connectorId),
    )).get();
    if (!existing) continue;

    const state = existing.disposition === 'dismissed'
      ? 'dismissed'
      : existing.disposition === 'handled'
        ? 'archived'
        : 'resolved';
    transaction.update(notifications).set({
      state,
      sourceState: 'resolved',
      sourceResolvedAt: existing.sourceResolvedAt ?? item.sourceResolvedAt ?? nowIso,
      lastSourceActivityAt: item.lastSourceActivityAt,
      lastSourceActivityKey: item.lastSourceActivityKey,
      lastSourceSyncedAt: nowIso,
      isActionable: false,
      primaryActionId: null,
      metadata: item.metadata,
    }).where(eq(notifications.id, existing.id)).run();
    transaction.delete(notificationActions).where(and(
      eq(notificationActions.notificationId, existing.id),
      eq(notificationActions.createdBy, 'connector'),
    )).run();
  }
}

export function createSqliteFinanceInsightNotificationLifecyclePersistence(
  handles: SqliteFinanceInsightNotificationHandles = defaultHandles(),
): FinanceInsightNotificationLifecyclePersistence {
  return {
    async isDeliveryEnabled(connectorId) {
      const row = handles.sqlite.prepare(`
        SELECT delivery_enabled AS deliveryEnabled
        FROM finance_insight_cutovers WHERE connector_id = ?
      `).get(connectorId) as { deliveryEnabled: number } | undefined;
      return row?.deliveryEnabled === 1;
    },

    async runLifecycle(input): Promise<FinanceInsightNotificationLifecycleOutcome> {
      const now = new Date(input.now);
      const results = handles.db.transaction((transaction) => {
        reconcilePortable(transaction, input.connectorId, input.reconcile, input.now);
        const createInputs = input.ingest.map(toCreateNotificationInput);
        const created = createNotificationsInTransaction(transaction, createInputs, {
          now,
          wakeDispatcher: false,
        });
        syncFinanceProviderPresentation(transaction, created);
        return created.map((entry) => ({
          id: entry.notification.id,
          created: entry.created,
          pendingDelivery: entry.deliveryEvents.some((event) => event.status === 'pending'),
        }));
      }, { behavior: 'immediate' });
      return {
        results,
        hasPendingDelivery: results.some((entry) => entry.pendingDelivery),
      };
    },
  };
}
