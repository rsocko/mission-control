import { NextResponse } from 'next/server';
import db from '@/db';
import { notifications, notificationActions } from '@/db/schema';
import { eq, desc, and, inArray, sql, asc, lt } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import {
  MAX_NOTIFICATION_MERCHANT_FACETS,
  UNKNOWN_NOTIFICATION_MERCHANT_QUERY_ERROR,
  notificationQueryValidationError,
  parseNotificationQuery,
} from '@/lib/notifications/query';
import {
  notificationCursor,
  notificationMerchantMetadataCondition,
  notificationWhere,
} from '@/lib/notifications/query-server';
import {
  legacyStateFromLifecycle,
  legacyStateMutationPatch,
} from '@/lib/notifications/lifecycle';
import {
  notificationIsInInbox,
  notificationNeedsAttention,
} from '@/lib/notifications/lifecycle-sql';
import type { NotificationState } from '@/types';
import { normalizeFinanceProviderFacets } from '@/lib/finance-insights/provider';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const queryError = notificationQueryValidationError(searchParams);
  if (queryError) return ApiErrors.badRequest(queryError);
  const query = parseNotificationQuery(searchParams);
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10), 1), 200);
  const cursor = searchParams.get('cursor');

  try {
    let selectedMerchantFacet: { key: string; label: string; count: number } | null = null;
    if (query.merchant) {
      const merchantLabel = sql<string>`json_extract(${notifications.presentation}, '$.financeMerchantLabel')`;
      const knownMerchant = await db.select({
        label: sql<string>`MIN(${merchantLabel})`,
        count: sql<number>`COUNT(*)`,
      })
        .from(notifications)
        .where(and(
          sql`${notifications.connectorInstanceId} NOT IN (
            SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL
          )`,
          notificationMerchantMetadataCondition(query.merchant),
        ))
        .limit(1);
      if (!knownMerchant[0] || Number(knownMerchant[0].count) === 0) {
        return ApiErrors.badRequest(UNKNOWN_NOTIFICATION_MERCHANT_QUERY_ERROR);
      }
      selectedMerchantFacet = {
        key: query.merchant,
        label: knownMerchant[0].label,
        count: Number(knownMerchant[0].count),
      };
    }

    const recoveryCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    db.transaction((tx) => {
      const staleActions = tx.select({
        id: notificationActions.id,
        notificationId: notificationActions.notificationId,
        isPrimary: notificationActions.isPrimary,
      })
        .from(notificationActions)
        .where(and(
          eq(notificationActions.actionType, 'run_workflow'),
          eq(notificationActions.executionState, 'running'),
          lt(notificationActions.claimedAt, recoveryCutoff),
        ))
        .all();
      if (staleActions.length === 0) return;

      tx.update(notificationActions)
        .set({ executionState: 'pending', claimedAt: null })
        .where(inArray(notificationActions.id, staleActions.map(action => action.id)))
        .run();
      for (const action of staleActions) {
        if (!action.isPrimary) continue;
        tx.update(notifications)
          .set({ isActionable: true, primaryActionId: action.id })
          .where(eq(notifications.id, action.notificationId))
          .run();
      }
    });

    const where = notificationWhere(query, cursor);
    const unpaginatedWhere = notificationWhere(query);
    const order = query.sort === 'oldest'
      ? [asc(notifications.sortAt), asc(notifications.id)]
      : [desc(notifications.sortAt), desc(notifications.id)];

    const rows = await db.select()
      .from(notifications)
      .where(where)
      .orderBy(...order)
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    // Hydrate actions for each notification
    const notificationIds = items.map(n => n.id);
    const actions = notificationIds.length > 0
      ? await db.select().from(notificationActions)
          .where(and(
            inArray(notificationActions.notificationId, notificationIds),
            eq(notificationActions.executionState, 'pending'),
          ))
          .orderBy(asc(notificationActions.sortOrder))
      : [];

    const actionsByNotification = new Map<string, typeof actions>();
    for (const action of actions) {
      const existing = actionsByNotification.get(action.notificationId) || [];
      existing.push(action);
      actionsByNotification.set(action.notificationId, existing);
    }

    const hydratedItems = items.map(item => ({
      ...item,
      state: legacyStateFromLifecycle(item),
      actions: actionsByNotification.get(item.id) || [],
    }));

    // Compute stats (always unfiltered so tab badges remain accurate)
    const baseCondition = and(
      notificationIsInInbox(),
      sql`${notifications.connectorInstanceId} NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)`,
    );
    const attentionCondition = notificationNeedsAttention();

    const stats = await db.select({
      total: sql<number>`COUNT(*)`,
      unread: sql<number>`COALESCE(SUM(CASE WHEN read_state = 'unread' THEN 1 ELSE 0 END), 0)`,
      attention: sql<number>`COALESCE(SUM(CASE WHEN ${attentionCondition} THEN 1 ELSE 0 END), 0)`,
      urgent: sql<number>`COALESCE(SUM(CASE WHEN level = 'urgent' AND read_state = 'unread' THEN 1 ELSE 0 END), 0)`,
      actionNeeded: sql<number>`COALESCE(SUM(CASE WHEN level = 'action_needed' AND read_state = 'unread' THEN 1 ELSE 0 END), 0)`,
      headsUp: sql<number>`COALESCE(SUM(CASE WHEN level = 'heads_up' AND read_state = 'unread' THEN 1 ELSE 0 END), 0)`,
      fyi: sql<number>`COALESCE(SUM(CASE WHEN level = 'fyi' AND read_state = 'unread' THEN 1 ELSE 0 END), 0)`,
      digest: sql<number>`COALESCE(SUM(CASE WHEN level = 'digest' AND read_state = 'unread' THEN 1 ELSE 0 END), 0)`,
      actionable: sql<number>`COALESCE(SUM(CASE WHEN ${notifications.isActionable} = 1 THEN 1 ELSE 0 END), 0)`,
    }).from(notifications).where(baseCondition);

    // Compute facets (unfiltered counts for sidebar badges)
    const connectorCondition = sql`${notifications.connectorInstanceId} NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)`;

    const merchantKey = sql<string>`json_extract(${notifications.presentation}, '$.financeMerchantKey')`;
    const merchantLabel = sql<string>`json_extract(${notifications.presentation}, '$.financeMerchantLabel')`;
    const merchantCount = sql<number>`COUNT(*)`;
    const [levelFacets, categoryFacets, sourceFacets, stateFacets, merchantFacets, matching] = await Promise.all([
      db.select({
        value: notifications.level,
        count: sql<number>`COUNT(*)`,
      }).from(notifications).where(baseCondition).groupBy(notifications.level),

      db.select({
        value: notifications.category,
        count: sql<number>`COUNT(*)`,
      }).from(notifications).where(baseCondition).groupBy(notifications.category),

      db.select({
        value: notifications.connectorType,
        count: sql<number>`COUNT(*)`,
      }).from(notifications).where(baseCondition).groupBy(notifications.connectorType),

      // State facets use a broader condition (no state exclusion) so
      // dismissed/archived counts are visible in the sidebar
      db.select({
        value: notifications.state,
        count: sql<number>`COUNT(*)`,
      }).from(notifications).where(connectorCondition).groupBy(notifications.state),

      db.select({
        key: merchantKey,
        label: sql<string>`MIN(${merchantLabel})`,
        count: merchantCount,
      }).from(notifications).where(and(
        baseCondition,
        notificationMerchantMetadataCondition(),
      )).groupBy(merchantKey)
        .orderBy(desc(merchantCount), asc(merchantKey))
        .limit(MAX_NOTIFICATION_MERCHANT_FACETS),

      db.select({ count: sql<number>`COUNT(*)` })
        .from(notifications)
        .where(unpaginatedWhere),
    ]);

    const toRecord = (rows: { value: string | null; count: number }[]) =>
      Object.fromEntries(rows.filter(r => r.value).map(r => [r.value!, Number(r.count)]));
    const normalizedMerchantFacets = merchantFacets.map(facet => ({
      key: facet.key,
      label: facet.label,
      count: Number(facet.count),
    }));
    if (
      selectedMerchantFacet
      && !normalizedMerchantFacets.some(facet => facet.key === selectedMerchantFacet?.key)
    ) {
      if (normalizedMerchantFacets.length === MAX_NOTIFICATION_MERCHANT_FACETS) {
        normalizedMerchantFacets.pop();
      }
      normalizedMerchantFacets.push(selectedMerchantFacet);
    }

    return NextResponse.json({
      notifications: hydratedItems,
      stats: stats[0] || {
        total: 0,
        unread: 0,
        attention: 0,
        urgent: 0,
        actionNeeded: 0,
        headsUp: 0,
        fyi: 0,
        digest: 0,
        actionable: 0,
      },
      facets: {
        level: toRecord(levelFacets),
        category: toRecord(categoryFacets),
        source: normalizeFinanceProviderFacets(sourceFacets),
        state: toRecord(stateFacets),
        merchant: normalizedMerchantFacets,
      },
      matchingCount: Number(matching[0]?.count ?? 0),
      hasMore,
      cursor: items.length > 0
        ? notificationCursor(items[items.length - 1].sortAt, items[items.length - 1].id)
        : null,
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch notifications', error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    if (Array.isArray(body.restore)) {
      const snapshots = body.restore as Array<Record<string, unknown>>;
      if (snapshots.length === 0 || snapshots.length > 500) {
        return ApiErrors.badRequest('restore must contain between 1 and 500 notifications');
      }
      const validReadStates = new Set(['unread', 'read']);
      const validDispositions = new Set(['inbox', 'handled', 'dismissed']);
      if (snapshots.some(snapshot =>
        typeof snapshot.id !== 'string'
        || !validReadStates.has(String(snapshot.readState))
        || !validDispositions.has(String(snapshot.disposition))
      )) {
        return ApiErrors.badRequest('Invalid notification restore snapshot');
      }

      const ids = [...new Set(snapshots.map(snapshot => String(snapshot.id)))];
      const current = await db.select({
        id: notifications.id,
        sourceState: notifications.sourceState,
      }).from(notifications).where(inArray(notifications.id, ids));
      const sourceStateById = new Map(current.map(row => [row.id, row.sourceState]));
      let updatedCount = 0;

      for (const snapshot of snapshots) {
        const id = String(snapshot.id);
        const sourceState = sourceStateById.get(id);
        if (!sourceState) continue;
        const readState = String(snapshot.readState) as 'unread' | 'read';
        const disposition = String(snapshot.disposition) as 'inbox' | 'handled' | 'dismissed';
        const nullableString = (value: unknown) => typeof value === 'string' ? value : null;
        const restoreResult = await db.update(notifications)
          .set({
            state: legacyStateFromLifecycle({ readState, disposition, sourceState }),
            readState,
            disposition,
            readAt: nullableString(snapshot.readAt),
            handledAt: nullableString(snapshot.handledAt),
            dismissedAt: nullableString(snapshot.dismissedAt),
            archivedAt: nullableString(snapshot.archivedAt),
            handledSourceActivityAt: nullableString(snapshot.handledSourceActivityAt),
            handledSourceActivityKey: nullableString(snapshot.handledSourceActivityKey),
          })
          .where(eq(notifications.id, id));
        updatedCount += restoreResult.changes;
      }

      return NextResponse.json({ success: true, updatedCount });
    }

    const ids = Array.isArray(body.ids) ? body.ids : [];
    const newState = body.state as string | undefined;

    const VALID_STATES = ['unread', 'read', 'dismissed', 'resolved', 'archived'];
    if (!ids.length || !newState) {
      return ApiErrors.badRequest('ids and state are required');
    }
    if (!VALID_STATES.includes(newState)) {
      return ApiErrors.badRequest(`Invalid state. Must be one of: ${VALID_STATES.join(', ')}`);
    }

    const now = new Date().toISOString();
    const current = await db.select({
      id: notifications.id,
      readState: notifications.readState,
      disposition: notifications.disposition,
      sourceState: notifications.sourceState,
      lastSourceActivityAt: notifications.lastSourceActivityAt,
      lastSourceActivityKey: notifications.lastSourceActivityKey,
    }).from(notifications).where(inArray(notifications.id, ids));

    for (const notification of current) {
      await db.update(notifications)
        .set(legacyStateMutationPatch(notification, newState as NotificationState, now))
        .where(eq(notifications.id, notification.id));
    }

    return NextResponse.json({ success: true, updatedCount: current.length });
  } catch (error) {
    return ApiErrors.internal('Failed to update notifications', error);
  }
}
