import { and, eq, gt, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { notifications } from '@/db/schema';
import { notificationIsInInbox } from './lifecycle-sql';
import type { NotificationQuery } from './query';
import {
  MAX_NOTIFICATION_MERCHANT_LABEL_LENGTH,
  NOTIFICATION_MERCHANT_KEY_LENGTH,
} from './query';
import { financeProviderFilterValues } from '@/lib/finance-insights/provider';

const PARTICIPATING_REASONS = ['author', 'comment', 'manual', 'state_change', 'subscribed'];

export function notificationMerchantMetadataCondition(merchant?: string | null): SQL {
  const merchantKey = sql<string>`json_extract(${notifications.presentation}, '$.financeMerchantKey')`;
  const merchantLabel = sql<string>`json_extract(${notifications.presentation}, '$.financeMerchantLabel')`;
  return and(
    sql`json_type(${notifications.presentation}, '$.financeMerchantKey') = 'text'`,
    sql`json_type(${notifications.presentation}, '$.financeMerchantLabel') = 'text'`,
    sql`length(${merchantKey}) = ${NOTIFICATION_MERCHANT_KEY_LENGTH}`,
    sql`substr(${merchantKey}, 1, 12) = 'merchant-v1_'`,
    sql`substr(${merchantKey}, 13) NOT GLOB '*[^A-Za-z0-9_-]*'`,
    sql`length(trim(${merchantLabel})) BETWEEN 1 AND ${MAX_NOTIFICATION_MERCHANT_LABEL_LENGTH}`,
    merchant ? sql`${merchantKey} = ${merchant}` : undefined,
  )!;
}

export function notificationInboxCondition(now = new Date()): SQL {
  return notificationIsInInbox(now);
}

export function buildNotificationConditions(
  query: NotificationQuery,
  cursor?: string | null,
): SQL[] {
  const conditions: SQL[] = [];

  if (!query.state) conditions.push(notificationInboxCondition());
  conditions.push(
    sql`${notifications.connectorInstanceId} NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)`,
  );

  if (query.q) {
    conditions.push(sql`(
      instr(lower(${notifications.title}), lower(${query.q})) > 0
      OR instr(lower(COALESCE(${notifications.body}, '')), lower(${query.q})) > 0
    )`);
  }
  if (query.source) {
    const sourceTypes = financeProviderFilterValues(query.source);
    conditions.push(sourceTypes.length === 1
      ? eq(notifications.connectorType, sourceTypes[0])
      : inArray(notifications.connectorType, [...sourceTypes]));
  }
  if (query.sourceAccount) conditions.push(eq(notifications.connectorInstanceId, query.sourceAccount));
  if (query.level) conditions.push(eq(notifications.level, query.level));
  if (query.category) conditions.push(eq(notifications.category, query.category));
  if (query.merchant) {
    conditions.push(notificationMerchantMetadataCondition(query.merchant));
  }
  switch (query.state) {
    case 'unread':
    case 'read':
      conditions.push(eq(notifications.readState, query.state));
      conditions.push(notificationInboxCondition());
      break;
    case 'dismissed':
      conditions.push(eq(notifications.disposition, 'dismissed'));
      break;
    case 'archived':
      conditions.push(eq(notifications.disposition, 'handled'));
      conditions.push(inArray(notifications.sourceState, ['active', 'unknown']));
      break;
    case 'resolved':
      conditions.push(inArray(notifications.sourceState, ['resolved', 'deleted']));
      conditions.push(sql`${notifications.disposition} <> 'dismissed'`);
      break;
  }
  if (query.actionableOnly) conditions.push(eq(notifications.isActionable, true));
  if (query.repository) {
    conditions.push(sql`json_extract(${notifications.presentation}, '$.repository') = ${query.repository}`);
  }
  if (query.owner) {
    conditions.push(sql`substr(
      json_extract(${notifications.presentation}, '$.repository'),
      1,
      instr(json_extract(${notifications.presentation}, '$.repository'), '/') - 1
    ) = ${query.owner}`);
  }
  if (query.reason) {
    conditions.push(sql`json_extract(${notifications.presentation}, '$.reason') = ${query.reason}`);
  }
  if (query.subjectType) {
    conditions.push(sql`json_extract(${notifications.presentation}, '$.subjectType') = ${query.subjectType}`);
  }
  if (query.participating) {
    conditions.push(sql`json_extract(${notifications.presentation}, '$.reason') IN (${sql.join(
      PARTICIPATING_REASONS.map(reason => sql`${reason}`),
      sql`, `,
    )})`);
  }
  if (query.dateRange) {
    const now = new Date();
    const since = query.dateRange === 'today'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
      : new Date(now.getTime() - (query.dateRange === 'week' ? 7 : 30) * 86_400_000);
    conditions.push(sql`${notifications.receivedAt} >= ${since.toISOString()}`);
  }

  if (cursor) {
    const separator = cursor.lastIndexOf('|');
    const cursorSortAt = separator > 0 ? cursor.slice(0, separator) : '';
    const cursorId = separator > 0 ? cursor.slice(separator + 1) : '';
    if (cursorSortAt && cursorId) {
      const sortComparison = query.sort === 'oldest'
        ? gt(notifications.sortAt, cursorSortAt)
        : lt(notifications.sortAt, cursorSortAt);
      const idComparison = query.sort === 'oldest'
        ? gt(notifications.id, cursorId)
        : lt(notifications.id, cursorId);
      conditions.push(sql`(${sortComparison} OR (${notifications.sortAt} = ${cursorSortAt} AND ${idComparison}))`);
    }
  }

  return conditions;
}

export function notificationWhere(query: NotificationQuery, cursor?: string | null): SQL | undefined {
  const conditions = buildNotificationConditions(query, cursor);
  return conditions.length ? and(...conditions) : undefined;
}

export function notificationCursor(sortAt: string, id: string): string {
  return `${sortAt}|${id}`;
}
