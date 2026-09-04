import type { Pool } from 'pg';
import type {
  NotificationWebPersistence,
  NotificationRow,
  NotificationActionRow,
  NotificationStats,
  NotificationQueryResult,
  RestoreSnapshot,
  BulkSelectedRow,
  SavedViewRow,
  WritebackStatusResult,
  WritebackJob,
  WritebackClaimRow,
  WebSubscriptionInput,
  NotificationMutationAction,
  NotificationMutationResult,
} from '@/db/persistence/notification-web';
import type { NotificationQuery } from '@/lib/notifications/query';
import type { NotificationState } from '@/types';
import { legacyStateFromLifecycle, legacyStateMutationPatch } from '@/lib/notifications/lifecycle';
import {
  NOTIFICATION_MERCHANT_KEY_LENGTH,
  MAX_NOTIFICATION_MERCHANT_LABEL_LENGTH,
  MAX_NOTIFICATION_MERCHANT_FACETS,
} from '@/lib/notifications/query';
import { normalizeFinanceProviderFacets, financeProviderFilterValues } from '@/lib/finance-insights/provider';
import { wakeNotificationWritebackDispatcher } from '@/lib/notifications/notification-writeback';

const PARTICIPATING_REASONS = ['author', 'comment', 'manual', 'state_change', 'subscribed'];

const NOTIFICATION_SELECT_COLUMNS = `
  id,
  source_id AS "sourceId",
  connector_type AS "connectorType",
  connector_instance_id AS "connectorInstanceId",
  title,
  body,
  level,
  level_rank AS "levelRank",
  category,
  template_key AS "templateKey",
  state,
  read_state AS "readState",
  disposition,
  source_state AS "sourceState",
  sync_state AS "syncState",
  read_at AS "readAt",
  handled_at AS "handledAt",
  dismissed_at AS "dismissedAt",
  resolved_at AS "resolvedAt",
  archived_at AS "archivedAt",
  muted_at AS "mutedAt",
  snoozed_until AS "snoozedUntil",
  source_resolved_at AS "sourceResolvedAt",
  last_source_activity_at AS "lastSourceActivityAt",
  last_source_activity_key AS "lastSourceActivityKey",
  handled_source_activity_at AS "handledSourceActivityAt",
  handled_source_activity_key AS "handledSourceActivityKey",
  last_source_synced_at AS "lastSourceSyncedAt",
  is_actionable AS "isActionable",
  primary_action_id AS "primaryActionId",
  ai_suggested_action_id AS "aiSuggestedActionId",
  received_at AS "receivedAt",
  sort_at AS "sortAt",
  expires_at AS "expiresAt",
  group_key AS "groupKey",
  dedupe_key AS "dedupeKey",
  related_task_id AS "relatedTaskId",
  related_project_id AS "relatedProjectId",
  related_entity_type AS "relatedEntityType",
  related_entity_id AS "relatedEntityId",
  navigation_target AS "navigationTarget",
  reconcile_attempts AS "reconcileAttempts",
  last_reconciled_at AS "lastReconciledAt",
  stale_since AS "staleSince",
  auto_resolve_reason AS "autoResolveReason",
  metadata,
  presentation,
  enrichment_revision AS "enrichmentRevision",
  enrichment_generation AS "enrichmentGeneration"
`;

const NOTIFICATION_ACTION_SELECT_COLUMNS = `
  id,
  notification_id AS "notificationId",
  action_type AS "actionType",
  label,
  icon,
  variant,
  is_primary AS "isPrimary",
  sort_order AS "sortOrder",
  payload,
  opens_external AS "opensExternal",
  requires_confirmation AS "requiresConfirmation",
  created_by AS "createdBy",
  execution_state AS "executionState",
  claimed_at AS "claimedAt",
  completed_at AS "completedAt",
  last_error AS "lastError"
`;

type WritebackSourceRow = {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

/**
 * PostgreSQL WHERE builder for bulk selection by query. Mirrors the SQLite
 * `buildWhereClauses` reference (cursor-free) so bulk selection is
 * backend-neutral. Appends bound values to `params` and returns the full
 * `WHERE ...` clause (or an empty string when unconstrained).
 */
function buildBulkWhereClausesPg(query: NotificationQuery, params: unknown[]): string {
  const now = new Date().toISOString();
  const conditions: string[] = [];

  if (!query.state) {
    const inbox = inboxConditionPg(params.length + 1);
    conditions.push(`(${inbox.sql})`);
    params.push(now);
  }
  conditions.push(`connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)`);

  if (query.q) {
    const i = params.length + 1;
    conditions.push(`(position(lower($${i}) in lower(title)) > 0 OR position(lower($${i + 1}) in lower(COALESCE(body, ''))) > 0)`);
    params.push(query.q, query.q);
  }
  if (query.source) {
    const sourceTypes = financeProviderFilterValues(query.source);
    if (sourceTypes.length === 1) {
      conditions.push(`connector_type = $${params.length + 1}`);
      params.push(sourceTypes[0]);
    } else {
      const start = params.length + 1;
      const placeholders = sourceTypes.map((_, i) => `$${start + i}`).join(',');
      conditions.push(`connector_type IN (${placeholders})`);
      params.push(...sourceTypes);
    }
  }
  if (query.sourceAccount) { conditions.push(`connector_instance_id = $${params.length + 1}`); params.push(query.sourceAccount); }
  if (query.level) { conditions.push(`level = $${params.length + 1}`); params.push(query.level); }
  if (query.category) { conditions.push(`category = $${params.length + 1}`); params.push(query.category); }
  if (query.merchant) {
    const m = merchantMetadataConditionPg(params.length + 1, query.merchant);
    conditions.push(`(${m.sql})`);
    params.push(...m.params);
  }
  switch (query.state) {
    case 'unread': case 'read': {
      conditions.push(`read_state = $${params.length + 1}`);
      params.push(query.state);
      const inbox = inboxConditionPg(params.length + 1);
      conditions.push(`(${inbox.sql})`);
      params.push(now);
      break;
    }
    case 'dismissed': conditions.push(`disposition = 'dismissed'`); break;
    case 'archived': conditions.push(`disposition = 'handled'`); conditions.push(`source_state IN ('active', 'unknown')`); break;
    case 'resolved': conditions.push(`source_state IN ('resolved', 'deleted')`); conditions.push(`disposition <> 'dismissed'`); break;
  }
  if (query.actionableOnly) conditions.push(`is_actionable = true`);
  if (query.repository) { conditions.push(`presentation->>'repository' = $${params.length + 1}`); params.push(query.repository); }
  if (query.owner) { conditions.push(`split_part(presentation->>'repository', '/', 1) = $${params.length + 1}`); params.push(query.owner); }
  if (query.reason) { conditions.push(`presentation->>'reason' = $${params.length + 1}`); params.push(query.reason); }
  if (query.subjectType) { conditions.push(`presentation->>'subjectType' = $${params.length + 1}`); params.push(query.subjectType); }
  if (query.participating) {
    const start = params.length + 1;
    const placeholders = PARTICIPATING_REASONS.map((_, i) => `$${start + i}`).join(',');
    conditions.push(`presentation->>'reason' IN (${placeholders})`);
    params.push(...PARTICIPATING_REASONS);
  }
  if (query.dateRange) {
    const dateNow = new Date();
    const since = query.dateRange === 'today'
      ? new Date(dateNow.getFullYear(), dateNow.getMonth(), dateNow.getDate())
      : new Date(dateNow.getTime() - (query.dateRange === 'week' ? 7 : 30) * 86_400_000);
    conditions.push(`received_at >= $${params.length + 1}`); params.push(since.toISOString());
  }
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
}

/**
 * PostgreSQL writeback mutation SQL builder. Mirrors the SQLite
 * `mutationUpdateSql` reference. `idCount` is the number of notification ids
 * appended after the SET-clause parameters; id placeholders are numbered
 * immediately after the SET parameters.
 */
function mutationUpdateSqlPg(
  action: NotificationMutationAction | 'dismiss',
  idCount: number,
): { sql: string; parameters: (changedAt: string) => string[] } {
  const idPlaceholders = (offset: number) =>
    Array.from({ length: idCount }, (_, i) => `$${offset + i + 1}`).join(',');
  switch (action) {
    case 'mark_read':
      return {
        sql: `UPDATE notifications
          SET read_state = 'read',
              read_at = COALESCE(read_at, $1),
              state = CASE
                WHEN disposition = 'dismissed' THEN 'dismissed'
                WHEN source_state IN ('resolved', 'deleted') THEN 'resolved'
                WHEN disposition = 'handled' THEN 'archived'
                ELSE 'read'
              END
          WHERE id IN (${idPlaceholders(1)})`,
        parameters: (changedAt) => [changedAt],
      };
    case 'mark_done':
      return {
        sql: `UPDATE notifications
          SET disposition = 'handled',
              handled_at = $1,
              archived_at = $2,
              handled_source_activity_at = last_source_activity_at,
              handled_source_activity_key = last_source_activity_key,
              state = CASE
                WHEN source_state IN ('resolved', 'deleted') THEN 'resolved'
                ELSE 'archived'
              END
          WHERE id IN (${idPlaceholders(2)})`,
        parameters: (changedAt) => [changedAt, changedAt],
      };
    case 'mute':
      return {
        sql: `UPDATE notifications
          SET read_state = 'read',
              read_at = COALESCE(read_at, $1),
              disposition = 'dismissed',
              dismissed_at = $2,
              muted_at = $3,
              state = 'dismissed'
          WHERE id IN (${idPlaceholders(3)})`,
        parameters: (changedAt) => [changedAt, changedAt, changedAt],
      };
    case 'unmute':
      return {
        sql: `UPDATE notifications
          SET disposition = 'inbox',
              dismissed_at = NULL,
              muted_at = NULL,
              state = CASE
                WHEN source_state IN ('resolved', 'deleted') THEN 'resolved'
                WHEN read_state = 'unread' THEN 'unread'
                ELSE 'read'
              END
          WHERE id IN (${idPlaceholders(0)})`,
        parameters: () => [],
      };
    case 'dismiss':
      return {
        sql: `UPDATE notifications
          SET read_state = 'read',
              read_at = COALESCE(read_at, $1),
              disposition = 'dismissed',
              dismissed_at = $2,
              state = 'dismissed'
          WHERE id IN (${idPlaceholders(2)})`,
        parameters: (changedAt) => [changedAt, changedAt],
      };
  }
}

const NOTIFICATION_SYNC_STATE_CASE_SQL = `CASE
        WHEN EXISTS (
          SELECT 1 FROM notification_writeback_jobs jobs
          WHERE jobs.notification_id = notifications.id AND jobs.status = 'failed'
        ) THEN 'failed'
        WHEN EXISTS (
          SELECT 1 FROM notification_writeback_jobs jobs
          WHERE jobs.notification_id = notifications.id
            AND jobs.status IN ('pending', 'sending')
        ) THEN 'pending'
        ELSE 'synced'
      END`;

function inboxConditionPg(paramIndex: number): { sql: string; nextParam: number } {
  return {
    sql: `disposition = 'inbox' AND source_state IN ('active', 'unknown') AND (snoozed_until IS NULL OR snoozed_until <= $${paramIndex})`,
    nextParam: paramIndex + 1,
  };
}

function attentionConditionPg(paramIndex: number): { sql: string; nextParam: number } {
  const inbox = inboxConditionPg(paramIndex);
  return {
    sql: `(${inbox.sql}) AND level <> 'digest' AND (level IN ('urgent', 'action_needed') OR read_state = 'unread')`,
    nextParam: inbox.nextParam,
  };
}

function merchantMetadataConditionPg(startParam: number, merchant?: string | null): { sql: string; params: unknown[]; nextParam: number } {
  const parts = [
    `jsonb_typeof(presentation->'financeMerchantKey') = 'string'`,
    `jsonb_typeof(presentation->'financeMerchantLabel') = 'string'`,
    `length(presentation->>'financeMerchantKey') = ${NOTIFICATION_MERCHANT_KEY_LENGTH}`,
    `left(presentation->>'financeMerchantKey', 12) = 'merchant-v1_'`,
    `length(trim(presentation->>'financeMerchantLabel')) BETWEEN 1 AND ${MAX_NOTIFICATION_MERCHANT_LABEL_LENGTH}`,
  ];
  const params: unknown[] = [];
  let nextParam = startParam;
  if (merchant) {
    parts.push(`presentation->>'financeMerchantKey' = $${nextParam}`);
    params.push(merchant);
    nextParam += 1;
  }
  return { sql: parts.join(' AND '), params, nextParam };
}

function normalizeWritebackSourceId(sourceId: string): string {
  const separator = sourceId.indexOf(':');
  const connectorSourceId = separator === -1 ? sourceId : sourceId.slice(separator + 1);
  return connectorSourceId.replace(/^docintel-/, '');
}

export function createPostgresNotificationWebRepository(
  pool: Pool,
): NotificationWebPersistence {

  type PgExecutor = {
    query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  };

  async function refreshSyncStateOn(executor: PgExecutor, notificationId: string): Promise<void> {
    await executor.query(`
      UPDATE notifications
      SET sync_state = ${NOTIFICATION_SYNC_STATE_CASE_SQL}
      WHERE id = $1
    `, [notificationId]);
  }

  async function refreshSyncState(notificationId: string): Promise<void> {
    await refreshSyncStateOn(pool, notificationId);
  }

  async function insertDismissalWritebackRowsPg(
    executor: PgExecutor,
    rows: WritebackSourceRow[],
    now: string,
  ): Promise<number> {
    let queued = 0;
    for (const row of rows) {
      const result = await executor.query(`
        INSERT INTO notification_writeback_jobs (
          id, notification_id, connector_instance_id, connector_type, source_id,
          action_type, dedupe_key, status, attempt_count, max_attempts, next_attempt_at,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'mark_done', $6, 'pending', 0, 3, $7, $8, $9)
        ON CONFLICT (dedupe_key) DO UPDATE SET
          status = 'pending',
          attempt_count = 0,
          next_attempt_at = EXCLUDED.next_attempt_at,
          lease_expires_at = NULL,
          last_error = NULL,
          completed_at = NULL,
          updated_at = EXCLUDED.updated_at
        WHERE notification_writeback_jobs.status = 'failed'
      `, [
        crypto.randomUUID(), row.id, row.connectorInstanceId, row.connectorType,
        normalizeWritebackSourceId(row.sourceId), `dismiss:${row.id}`, now, now, now,
      ]);
      queued += result.rowCount ?? 0;
    }
    return queued;
  }

  async function insertTypedWritebackRowPg(
    executor: PgExecutor,
    row: WritebackSourceRow,
    action: string,
    now: string,
  ): Promise<{ queued: number; pending: boolean }> {
    const baseDedupeKey = `${action}:${row.id}:${now}`;
    const existing = await executor.query(`
      SELECT jobs.status
      FROM notification_writeback_jobs jobs
      WHERE jobs.dedupe_key = $1
        AND NOT EXISTS (
          SELECT 1
          FROM notification_writeback_jobs newer
          WHERE newer.notification_id = jobs.notification_id
            AND (newer.created_at, newer.id) > (jobs.created_at, jobs.id)
            AND newer.status <> 'superseded'
        )
    `, [baseDedupeKey]);
    const existingStatus = existing.rows[0]?.status as string | undefined;
    if (existingStatus && ['pending', 'sending', 'succeeded'].includes(existingStatus)) {
      return {
        queued: 0,
        pending: existingStatus === 'pending' || existingStatus === 'sending',
      };
    }
    const clash = await executor.query(
      `SELECT 1 FROM notification_writeback_jobs WHERE dedupe_key = $1`,
      [baseDedupeKey],
    );
    const dedupeKey = (clash.rowCount ?? 0) > 0
      ? `${baseDedupeKey}:${crypto.randomUUID()}`
      : baseDedupeKey;
    if (action === 'mute' || action === 'unmute') {
      await executor.query(`
        UPDATE notification_writeback_jobs
        SET status = 'superseded',
            retryable = false,
            completed_at = $1,
            updated_at = $2,
            last_error = 'Superseded by a newer notification action'
        WHERE notification_id = $3
          AND status IN ('pending', 'failed')
          AND action_type IN ('mute', 'unmute')
          AND action_type <> $4
      `, [now, now, row.id, action]);
    }
    const inserted = await executor.query(`
      INSERT INTO notification_writeback_jobs (
        id, notification_id, connector_instance_id, connector_type, source_id,
        action_type, dedupe_key, status, retryable, attempt_count, max_attempts,
        next_attempt_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', true, 0, 5, $8, $9, $10)
      ON CONFLICT (dedupe_key) DO NOTHING
    `, [
      crypto.randomUUID(), row.id, row.connectorInstanceId, row.connectorType,
      normalizeWritebackSourceId(row.sourceId), action, dedupeKey, now, now, now,
    ]);
    const queued = inserted.rowCount ?? 0;
    return { queued, pending: queued === 1 };
  }

  return {
    async queryNotifications(input) {
      const { query, limit, cursor } = input;
      const now = new Date().toISOString();

      // Merchant validation
      let selectedMerchantFacet: { key: string; label: string; count: number } | null = null;
      if (query.merchant) {
        const merchant = merchantMetadataConditionPg(1, query.merchant);
        const result = await pool.query(`
          SELECT MIN(presentation->>'financeMerchantLabel') AS label, COUNT(*) AS count
          FROM notifications
          WHERE connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
            AND ${merchant.sql}
        `, merchant.params);
        if (!result.rows[0] || Number(result.rows[0].count) === 0) {
          return {
            items: [], actions: [], hasMore: false, cursor: null,
            stats: { total: 0, unread: 0, attention: 0, urgent: 0, actionNeeded: 0, headsUp: 0, fyi: 0, digest: 0, actionable: 0 },
            facets: { level: {}, category: {}, source: {}, state: {}, merchant: [] },
            matchingCount: 0,
          };
        }
        selectedMerchantFacet = { key: query.merchant, label: result.rows[0].label, count: Number(result.rows[0].count) };
      }

      // Build paginated query
      const params: unknown[] = [];
      let paramIdx = 1;
      const conditions: string[] = [];

      if (!query.state) {
        const inbox = inboxConditionPg(paramIdx);
        conditions.push(`(${inbox.sql})`);
        params.push(now);
        paramIdx = inbox.nextParam;
      }
      conditions.push(`connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)`);

      if (query.q) {
        conditions.push(`(position(lower($${paramIdx}) in lower(title)) > 0 OR position(lower($${paramIdx + 1}) in lower(COALESCE(body, ''))) > 0)`);
        params.push(query.q, query.q);
        paramIdx += 2;
      }
      if (query.source) {
        const sourceTypes = financeProviderFilterValues(query.source);
        if (sourceTypes.length === 1) {
          conditions.push(`connector_type = $${paramIdx}`);
          params.push(sourceTypes[0]);
          paramIdx += 1;
        } else {
          const placeholders = sourceTypes.map((_, i) => `$${paramIdx + i}`).join(',');
          conditions.push(`connector_type IN (${placeholders})`);
          params.push(...sourceTypes);
          paramIdx += sourceTypes.length;
        }
      }
      if (query.sourceAccount) { conditions.push(`connector_instance_id = $${paramIdx}`); params.push(query.sourceAccount); paramIdx += 1; }
      if (query.level) { conditions.push(`level = $${paramIdx}`); params.push(query.level); paramIdx += 1; }
      if (query.category) { conditions.push(`category = $${paramIdx}`); params.push(query.category); paramIdx += 1; }
      if (query.merchant) {
        const m = merchantMetadataConditionPg(paramIdx, query.merchant);
        conditions.push(`(${m.sql})`);
        params.push(...m.params);
        paramIdx = m.nextParam;
      }
      switch (query.state) {
        case 'unread': case 'read': {
          conditions.push(`read_state = $${paramIdx}`);
          params.push(query.state); paramIdx += 1;
          const inbox = inboxConditionPg(paramIdx);
          conditions.push(`(${inbox.sql})`);
          params.push(now); paramIdx = inbox.nextParam;
          break;
        }
        case 'dismissed': conditions.push(`disposition = 'dismissed'`); break;
        case 'archived': conditions.push(`disposition = 'handled'`); conditions.push(`source_state IN ('active', 'unknown')`); break;
        case 'resolved': conditions.push(`source_state IN ('resolved', 'deleted')`); conditions.push(`disposition <> 'dismissed'`); break;
      }
      if (query.actionableOnly) conditions.push(`is_actionable = true`);
      if (query.repository) { conditions.push(`presentation->>'repository' = $${paramIdx}`); params.push(query.repository); paramIdx += 1; }
      if (query.owner) { conditions.push(`split_part(presentation->>'repository', '/', 1) = $${paramIdx}`); params.push(query.owner); paramIdx += 1; }
      if (query.reason) { conditions.push(`presentation->>'reason' = $${paramIdx}`); params.push(query.reason); paramIdx += 1; }
      if (query.subjectType) { conditions.push(`presentation->>'subjectType' = $${paramIdx}`); params.push(query.subjectType); paramIdx += 1; }
      if (query.participating) {
        const placeholders = PARTICIPATING_REASONS.map((_, i) => `$${paramIdx + i}`).join(',');
        conditions.push(`presentation->>'reason' IN (${placeholders})`);
        params.push(...PARTICIPATING_REASONS); paramIdx += PARTICIPATING_REASONS.length;
      }
      if (query.dateRange) {
        const dateNow = new Date();
        const since = query.dateRange === 'today'
          ? new Date(dateNow.getFullYear(), dateNow.getMonth(), dateNow.getDate())
          : new Date(dateNow.getTime() - (query.dateRange === 'week' ? 7 : 30) * 86_400_000);
        conditions.push(`received_at >= $${paramIdx}`); params.push(since.toISOString()); paramIdx += 1;
      }
      // Save unpaginated query for matching count
      const unpaginatedWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const unpaginatedParams = [...params];

      if (cursor) {
        const separator = cursor.lastIndexOf('|');
        const cursorSortAt = separator > 0 ? cursor.slice(0, separator) : '';
        const cursorId = separator > 0 ? cursor.slice(separator + 1) : '';
        if (cursorSortAt && cursorId) {
          if (query.sort === 'oldest') {
            conditions.push(`(sort_at > $${paramIdx} OR (sort_at = $${paramIdx + 1} AND id > $${paramIdx + 2}))`);
          } else {
            conditions.push(`(sort_at < $${paramIdx} OR (sort_at = $${paramIdx + 1} AND id < $${paramIdx + 2}))`);
          }
          params.push(cursorSortAt, cursorSortAt, cursorId);
          paramIdx += 3;
        }
      }

      const paginatedWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderDir = query.sort === 'oldest' ? 'ASC' : 'DESC';
      params.push(limit + 1);
      const queryResult = await pool.query(
        `SELECT ${NOTIFICATION_SELECT_COLUMNS} FROM notifications ${paginatedWhere} ORDER BY sort_at ${orderDir}, id ${orderDir} LIMIT $${paramIdx}`,
        params,
      );
      const rows = queryResult.rows as NotificationRow[];
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;

      // Hydrate actions
      const notificationIds = items.map(n => n.id);
      let actions: NotificationActionRow[] = [];
      if (notificationIds.length > 0) {
        const ph = notificationIds.map((_, i) => `$${i + 1}`).join(',');
        const actionResult = await pool.query(
          `SELECT ${NOTIFICATION_ACTION_SELECT_COLUMNS} FROM notification_actions WHERE notification_id IN (${ph}) AND execution_state = 'pending' ORDER BY sort_order ASC`,
          notificationIds,
        );
        actions = actionResult.rows as NotificationActionRow[];
      }

      // Stats, facets, matching count in parallel
      const [statsResult, levelResult, categoryResult, sourceResult, stateResult, merchantResult, matchingResult] = await Promise.all([
        pool.query(`
          SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN read_state = 'unread' THEN 1 ELSE 0 END), 0) AS unread,
            COALESCE(SUM(CASE WHEN ${attentionConditionPg(2).sql} THEN 1 ELSE 0 END), 0) AS attention,
            COALESCE(SUM(CASE WHEN level = 'urgent' THEN 1 ELSE 0 END), 0) AS urgent,
            COALESCE(SUM(CASE WHEN level = 'action_needed' THEN 1 ELSE 0 END), 0) AS "actionNeeded",
            COALESCE(SUM(CASE WHEN level = 'heads_up' AND read_state = 'unread' THEN 1 ELSE 0 END), 0) AS "headsUp",
            COALESCE(SUM(CASE WHEN level = 'fyi' AND read_state = 'unread' THEN 1 ELSE 0 END), 0) AS fyi,
            COALESCE(SUM(CASE WHEN level = 'digest' AND read_state = 'unread' THEN 1 ELSE 0 END), 0) AS digest,
            COALESCE(SUM(CASE WHEN is_actionable = true THEN 1 ELSE 0 END), 0) AS actionable
          FROM notifications
          WHERE ${inboxConditionPg(1).sql} AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
        `, [now, now]),
        pool.query(`SELECT level AS value, COUNT(*) AS count FROM notifications WHERE ${inboxConditionPg(1).sql} AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL) GROUP BY level`, [now]),
        pool.query(`SELECT category AS value, COUNT(*) AS count FROM notifications WHERE ${inboxConditionPg(1).sql} AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL) GROUP BY category`, [now]),
        pool.query(`SELECT connector_type AS value, COUNT(*) AS count FROM notifications WHERE ${inboxConditionPg(1).sql} AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL) GROUP BY connector_type`, [now]),
        pool.query(`SELECT state AS value, COUNT(*) AS count FROM notifications WHERE connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL) GROUP BY state`),
        pool.query(`
          SELECT presentation->>'financeMerchantKey' AS key,
                 MIN(presentation->>'financeMerchantLabel') AS label,
                 COUNT(*) AS count
          FROM notifications
          WHERE ${inboxConditionPg(1).sql}
            AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
            AND ${merchantMetadataConditionPg(2).sql}
          GROUP BY presentation->>'financeMerchantKey'
          ORDER BY COUNT(*) DESC, presentation->>'financeMerchantKey' ASC
          LIMIT ${MAX_NOTIFICATION_MERCHANT_FACETS}
        `, [now]),
        pool.query(`SELECT COUNT(*) AS count FROM notifications ${unpaginatedWhere}`, unpaginatedParams),
      ]);

      const statsRow = statsResult.rows[0];
      const toRecord = (rows: { value: string | null; count: number }[]) =>
        Object.fromEntries(rows.filter(r => r.value).map(r => [r.value!, Number(r.count)]));
      const normalizedMerchantFacets = merchantResult.rows.map((f: Record<string, unknown>) => ({
        key: f.key as string, label: f.label as string, count: Number(f.count),
      }));
      if (selectedMerchantFacet && !normalizedMerchantFacets.some((f: { key: string }) => f.key === selectedMerchantFacet?.key)) {
        if (normalizedMerchantFacets.length === MAX_NOTIFICATION_MERCHANT_FACETS) normalizedMerchantFacets.pop();
        normalizedMerchantFacets.push(selectedMerchantFacet);
      }

      return {
        items,
        actions,
        hasMore,
        cursor: items.length > 0 ? `${items[items.length - 1].sortAt}|${items[items.length - 1].id}` : null,
        stats: {
          total: Number(statsRow.total), unread: Number(statsRow.unread),
          attention: Number(statsRow.attention), urgent: Number(statsRow.urgent),
          actionNeeded: Number(statsRow.actionNeeded), headsUp: Number(statsRow.headsUp),
          fyi: Number(statsRow.fyi), digest: Number(statsRow.digest),
          actionable: Number(statsRow.actionable),
        },
        facets: {
          level: toRecord(levelResult.rows),
          category: toRecord(categoryResult.rows),
          source: normalizeFinanceProviderFacets(sourceResult.rows),
          state: toRecord(stateResult.rows),
          merchant: normalizedMerchantFacets,
        },
        matchingCount: Number(matchingResult.rows[0]?.count ?? 0),
      };
    },

    async recoverStaleActions(recoveryCutoff) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const staleActions = await client.query(`
          SELECT id, notification_id AS "notificationId", is_primary AS "isPrimary"
          FROM notification_actions
          WHERE action_type = 'run_workflow' AND execution_state = 'running' AND claimed_at < $1
        `, [recoveryCutoff]);
        if (staleActions.rows.length === 0) { await client.query('COMMIT'); return; }
        const ids = staleActions.rows.map((r: Record<string, unknown>) => r.id as string);
        const ph = ids.map((_: unknown, i: number) => `$${i + 1}`).join(',');
        await client.query(`UPDATE notification_actions SET execution_state = 'pending', claimed_at = NULL WHERE id IN (${ph})`, ids);
        for (const action of staleActions.rows) {
          if (!action.isPrimary) continue;
          await client.query(`UPDATE notifications SET is_actionable = true, primary_action_id = $1 WHERE id = $2`, [action.id, action.notificationId]);
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    },

    async restoreSnapshots(snapshots) {
      const ids = [...new Set(snapshots.map(s => s.id))];
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const current = await pool.query(`SELECT id, source_state FROM notifications WHERE id IN (${ph})`, ids);
      const sourceStateById = new Map(current.rows.map((r: Record<string, unknown>) => [r.id, r.source_state as string]));
      let updatedCount = 0;
      for (const snapshot of snapshots) {
        const sourceState = sourceStateById.get(snapshot.id);
        if (!sourceState) continue;
        const state = legacyStateFromLifecycle({ readState: snapshot.readState, disposition: snapshot.disposition, sourceState });
        const result = await pool.query(`
          UPDATE notifications SET state = $1, read_state = $2, disposition = $3,
            read_at = $4, handled_at = $5, dismissed_at = $6, archived_at = $7,
            handled_source_activity_at = $8, handled_source_activity_key = $9
          WHERE id = $10
        `, [state, snapshot.readState, snapshot.disposition,
            snapshot.readAt ?? null, snapshot.handledAt ?? null, snapshot.dismissedAt ?? null,
            snapshot.archivedAt ?? null, snapshot.handledSourceActivityAt ?? null,
            snapshot.handledSourceActivityKey ?? null, snapshot.id]);
        updatedCount += result.rowCount ?? 0;
      }
      return { updatedCount };
    },

    async mutateStates(ids, state, now) {
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const current = await pool.query(`
        SELECT id, read_state, disposition, source_state,
               last_source_activity_at, last_source_activity_key
        FROM notifications WHERE id IN (${ph})
      `, ids);
      for (const row of current.rows) {
        const patch = legacyStateMutationPatch({
          readState: row.read_state, disposition: row.disposition, sourceState: row.source_state,
          lastSourceActivityAt: row.last_source_activity_at, lastSourceActivityKey: row.last_source_activity_key,
        }, state as NotificationState, now);
        const entries = Object.entries(patch);
        const sets = entries.map(([key, _], i) => `${key.replace(/([A-Z])/g, '_$1').toLowerCase()} = $${i + 1}`).join(', ');
        const values = entries.map(([, v]) => v ?? null);
        values.push(row.id);
        await pool.query(`UPDATE notifications SET ${sets} WHERE id = $${values.length}`, values);
      }
      return { updatedCount: current.rowCount ?? 0 };
    },

    async snoozeNotification(id, snoozeUntil) {
      const row = await pool.query(`SELECT id, metadata FROM notifications WHERE id = $1`, [id]);
      if (row.rows.length === 0) return false;
      let existingMeta: Record<string, unknown> = {};
      const meta = row.rows[0].metadata;
      if (typeof meta === 'string') { try { existingMeta = JSON.parse(meta); } catch { /* ignore */ } }
      else if (meta && typeof meta === 'object') { existingMeta = meta as Record<string, unknown>; }
      await pool.query(`UPDATE notifications SET snoozed_until = $1, metadata = $2 WHERE id = $3`, [
        snoozeUntil,
        JSON.stringify({ ...existingMeta, snoozedUntil: snoozeUntil, snoozedAt: new Date().toISOString() }),
        id,
      ]);
      return true;
    },

    async selectForBulkByIds(ids, limit) {
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const params = [...ids, limit];
      const result = await pool.query(`
        SELECT id, read_state AS "readState", disposition, source_state AS "sourceState", muted_at AS "mutedAt"
        FROM notifications WHERE id IN (${ph})
          AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
        LIMIT $${ids.length + 1}
      `, params);
      return result.rows as BulkSelectedRow[];
    },

    async selectForBulkByQuery(query, limit) {
      const params: unknown[] = [];
      const where = buildBulkWhereClausesPg(query, params);
      params.push(limit);
      const result = await pool.query(`
        SELECT id, read_state AS "readState", disposition, source_state AS "sourceState", muted_at AS "mutedAt"
        FROM notifications ${where}
        LIMIT $${params.length}
      `, params);
      return result.rows as BulkSelectedRow[];
    },

    async validateMerchantExists(merchant) {
      const m = merchantMetadataConditionPg(1, merchant);
      const result = await pool.query(`
        SELECT 1 FROM notifications
        WHERE connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
          AND ${m.sql} LIMIT 1
      `, m.params);
      return (result.rowCount ?? 0) > 0;
    },

    async validateMerchantForSelected(merchant) {
      const m = merchantMetadataConditionPg(1, merchant);
      const result = await pool.query(`
        SELECT MIN(presentation->>'financeMerchantLabel') AS label, COUNT(*) AS count
        FROM notifications
        WHERE connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
          AND ${m.sql}
      `, m.params);
      if (!result.rows[0] || Number(result.rows[0].count) === 0) return null;
      return { label: result.rows[0].label, count: Number(result.rows[0].count) };
    },

    async bulkMarkUnread(ids, _now) {
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const result = await pool.query(`
        UPDATE notifications SET read_state = 'unread', read_at = NULL,
          state = CASE
            WHEN disposition = 'dismissed' THEN 'dismissed'
            WHEN source_state IN ('resolved', 'deleted') THEN 'resolved'
            WHEN disposition = 'handled' THEN 'archived'
            ELSE 'unread'
          END WHERE id IN (${ph})
      `, ids);
      return result.rowCount ?? 0;
    },

    async bulkDismissDemo(ids, now) {
      const ph = ids.map((_, i) => `$${i + 3}`).join(',');
      const result = await pool.query(`
        UPDATE notifications SET state = 'dismissed', read_state = 'read', disposition = 'dismissed',
          read_at = $1, dismissed_at = $2 WHERE id IN (${ph})
      `, [now, now, ...ids]);
      return result.rowCount ?? 0;
    },

    async bulkHandleDemo(ids, now) {
      const ph = ids.map((_, i) => `$${i + 3}`).join(',');
      const result = await pool.query(`
        UPDATE notifications SET
          state = CASE WHEN source_state IN ('resolved', 'deleted') THEN 'resolved' ELSE 'archived' END,
          disposition = 'handled', handled_at = $1, archived_at = $2,
          handled_source_activity_at = last_source_activity_at,
          handled_source_activity_key = last_source_activity_key
        WHERE id IN (${ph})
      `, [now, now, ...ids]);
      return result.rowCount ?? 0;
    },

    async bulkMarkReadDemo(ids, now) {
      const ph = ids.map((_, i) => `$${i + 2}`).join(',');
      const result = await pool.query(`
        UPDATE notifications SET read_state = 'read', read_at = $1,
          state = CASE
            WHEN disposition = 'dismissed' THEN 'dismissed'
            WHEN source_state IN ('resolved', 'deleted') THEN 'resolved'
            WHEN disposition = 'handled' THEN 'archived'
            ELSE 'read'
          END WHERE id IN (${ph})
      `, [now, ...ids]);
      return result.rowCount ?? 0;
    },

    async mutateNotificationsAndEnqueueWritebacks(notificationIds, action, changedAt) {
      if (notificationIds.length === 0) return { updatedCount: 0, queuedCount: 0, results: [] };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ph = notificationIds.map((_, i) => `$${i + 1}`).join(',');
        const rowsResult = await client.query(`
          SELECT id, source_id AS "sourceId", connector_type AS "connectorType",
                 connector_instance_id AS "connectorInstanceId"
          FROM notifications WHERE id IN (${ph})
        `, notificationIds);
        const rows = rowsResult.rows as WritebackSourceRow[];
        const rowById = new Map(rows.map(r => [r.id, r]));
        const queuedIds = new Set<string>();
        let queuedCount = 0;
        if (action !== 'dismiss') {
          for (const row of rows) {
            if (row.connectorType !== 'github-issues') continue;
            const writeback = await insertTypedWritebackRowPg(client, row, action, changedAt);
            queuedCount += writeback.queued;
            if (writeback.pending) queuedIds.add(row.id);
          }
        }
        const update = mutationUpdateSqlPg(action, notificationIds.length);
        const updateResult = await client.query(update.sql, [
          ...update.parameters(changedAt), ...notificationIds,
        ]);
        for (const row of rows) await refreshSyncStateOn(client, row.id);
        await client.query('COMMIT');
        return {
          updatedCount: updateResult.rowCount ?? 0,
          queuedCount,
          results: notificationIds.map(id => {
            const row = rowById.get(id);
            return {
              id,
              localStatus: row ? 'updated' as const : 'not_found' as const,
              writebackStatus: row && queuedIds.has(id) ? 'pending' as const : 'not_required' as const,
            };
          }),
        };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    async dismissNotificationsAndEnqueueWritebacks(notificationIds, dismissedAt) {
      if (notificationIds.length === 0) return { updatedCount: 0, queuedCount: 0 };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ph = notificationIds.map((_, i) => `$${i + 1}`).join(',');
        const rowsResult = await client.query(`
          SELECT id, source_id AS "sourceId", connector_type AS "connectorType",
                 connector_instance_id AS "connectorInstanceId"
          FROM notifications WHERE id IN (${ph})
        `, notificationIds);
        const queuedCount = await insertDismissalWritebackRowsPg(
          client, rowsResult.rows as WritebackSourceRow[], dismissedAt,
        );
        const idPh = notificationIds.map((_, i) => `$${i + 3}`).join(',');
        const updateResult = await client.query(`
          UPDATE notifications
          SET state = 'dismissed', read_state = 'read', disposition = 'dismissed',
              sync_state = ${NOTIFICATION_SYNC_STATE_CASE_SQL},
              read_at = COALESCE(read_at, $1),
              dismissed_at = $2
          WHERE id IN (${idPh})
        `, [dismissedAt, dismissedAt, ...notificationIds]);
        await client.query('COMMIT');
        return { updatedCount: updateResult.rowCount ?? 0, queuedCount };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    async listSavedViews() {
      const result = await pool.query(`
        SELECT id, name, query, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM notification_saved_views ORDER BY name ASC
      `);
      return result.rows as SavedViewRow[];
    },

    async createSavedView(input) {
      const queryStr = JSON.stringify(input.query);
      try {
        await pool.query(`
          INSERT INTO notification_saved_views (id, name, query, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5)
        `, [input.id, input.name, queryStr, input.now, input.now]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new Error('UNIQUE constraint failed: notification_saved_views.name');
        }
        throw error;
      }
      return { id: input.id, name: input.name, query: queryStr, createdAt: input.now, updatedAt: input.now };
    },

    async deleteSavedView(id) {
      const result = await pool.query(`DELETE FROM notification_saved_views WHERE id = $1`, [id]);
      return (result.rowCount ?? 0) === 1;
    },

    async listWritebackStatus(notificationId) {
      const counts = await pool.query(`SELECT status, COUNT(*)::int AS count FROM notification_writeback_jobs GROUP BY status`);
      const where = notificationId ? `AND notification_id = $1` : '';
      const params = notificationId ? [notificationId] : [];
      const jobs = await pool.query(`
        SELECT id, notification_id AS "notificationId", connector_instance_id AS "connectorInstanceId",
               action_type AS action, status, retryable, attempt_count AS "attemptCount",
               max_attempts AS "maxAttempts", next_attempt_at AS "nextAttemptAt",
               last_error AS "lastError", updated_at AS "updatedAt"
        FROM notification_writeback_jobs
        WHERE status IN ('pending', 'sending', 'failed') ${where}
        ORDER BY updated_at DESC LIMIT 50
      `, params);
      const syncState = jobs.rows.some((j: Record<string, unknown>) => j.status === 'failed')
        ? 'failed' as const
        : jobs.rows.length > 0 ? 'pending' as const : 'synced' as const;
      return {
        counts: Object.fromEntries(counts.rows.map((r: Record<string, unknown>) => [r.status, Number(r.count)])),
        jobs: jobs.rows as WritebackJob[],
        failed: jobs.rows.filter((j: Record<string, unknown>) => j.status === 'failed') as WritebackJob[],
        syncState,
        retryable: jobs.rows.some((j: Record<string, unknown>) => j.status === 'failed' && j.retryable === true),
      };
    },

    async retryWritebacks(selector, ids, now) {
      if (ids.length === 0) return { retried: [] };
      const selectorColumn = selector === 'notification_id' ? 'notification_id' : 'id';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ph = ids.map((_, i) => `$${i + 1}`).join(',');
        const retryableResult = await client.query(`
          SELECT jobs.id, jobs.notification_id AS "notificationId"
          FROM notification_writeback_jobs jobs
          WHERE jobs.${selectorColumn} IN (${ph})
            AND jobs.status = 'failed'
            AND jobs.retryable = true
            AND NOT EXISTS (
              SELECT 1 FROM notification_writeback_jobs newer
              WHERE newer.notification_id = jobs.notification_id
                AND (newer.created_at, newer.id) > (jobs.created_at, jobs.id)
                AND newer.status <> 'superseded'
            )
        `, ids);
        const retried = retryableResult.rows as Array<{ id: string; notificationId: string }>;
        for (const job of retried) {
          await client.query(`
            UPDATE notification_writeback_jobs
            SET status = 'pending', attempt_count = 0, next_attempt_at = $1,
                lease_expires_at = NULL, last_error = NULL, completed_at = NULL, updated_at = $2
            WHERE id = $3
          `, [now, now, job.id]);
          await client.query(`UPDATE notifications SET sync_state = 'pending' WHERE id = $1`, [job.notificationId]);
        }
        await client.query('COMMIT');
        return { retried };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    async findSubscriptionByEndpoint(endpoint) {
      const result = await pool.query(`SELECT id FROM push_subscriptions WHERE endpoint = $1 AND platform = 'web' LIMIT 1`, [endpoint]);
      return result.rows[0] ?? null;
    },

    async registerSubscription(input) {
      const id = crypto.randomUUID();
      await pool.query(`
        INSERT INTO push_subscriptions (id, platform, endpoint, keys, user_agent, created_at)
        VALUES ($1, 'web', $2, $3, $4, $5)
      `, [id, input.endpoint, JSON.stringify(input.keys), input.userAgent, new Date().toISOString()]);
      return id;
    },

    async removeSubscription(endpoint) {
      await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
    },

    async claimNextConnectorBatch(input) {
      const { batchSize, leaseMs, singleJobConnectorIds } = input;
      const now = new Date();
      const nowIso = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          UPDATE notification_writeback_jobs
          SET status = 'pending', lease_expires_at = NULL, updated_at = $1
          WHERE status = 'sending' AND lease_expires_at <= $2
        `, [nowIso, nowIso]);

        const candidateResult = await client.query(`
          SELECT jobs.connector_instance_id AS "connectorInstanceId"
          FROM notification_writeback_jobs jobs
          INNER JOIN notifications notification
            ON notification.id = jobs.notification_id
            AND notification.connector_instance_id = jobs.connector_instance_id
            AND notification.connector_type = jobs.connector_type
          WHERE jobs.status = 'pending' AND jobs.next_attempt_at <= $1
            AND NOT EXISTS (
              SELECT 1 FROM notification_writeback_jobs earlier
              WHERE earlier.notification_id = jobs.notification_id
                AND (earlier.created_at, earlier.id) < (jobs.created_at, jobs.id)
                AND earlier.status IN ('pending', 'sending')
            )
          ORDER BY jobs.next_attempt_at, jobs.created_at, jobs.id
          LIMIT 1
        `, [nowIso]);
        const candidate = candidateResult.rows[0] as { connectorInstanceId: string } | undefined;
        if (!candidate) { await client.query('COMMIT'); return []; }

        const claimLimit = singleJobConnectorIds.has(candidate.connectorInstanceId) ? 1 : batchSize;
        const rowsResult = await client.query(`
          SELECT jobs.id, jobs.notification_id AS "notificationId",
                 jobs.connector_instance_id AS "connectorInstanceId",
                 jobs.connector_type AS "connectorType", jobs.source_id AS "sourceId",
                 jobs.action_type AS "actionType", jobs.attempt_count AS "attemptCount",
                 jobs.max_attempts AS "maxAttempts", jobs.lease_expires_at AS "leaseExpiresAt"
          FROM notification_writeback_jobs jobs
          INNER JOIN notifications notification
            ON notification.id = jobs.notification_id
            AND notification.connector_instance_id = jobs.connector_instance_id
            AND notification.connector_type = jobs.connector_type
          WHERE jobs.connector_instance_id = $1
            AND jobs.status = 'pending' AND jobs.next_attempt_at <= $2
            AND NOT EXISTS (
              SELECT 1 FROM notification_writeback_jobs earlier
              WHERE earlier.notification_id = jobs.notification_id
                AND (earlier.created_at, earlier.id) < (jobs.created_at, jobs.id)
                AND earlier.status IN ('pending', 'sending')
            )
          ORDER BY jobs.created_at, jobs.id
          LIMIT $3
          FOR UPDATE OF jobs SKIP LOCKED
        `, [candidate.connectorInstanceId, nowIso, claimLimit]);
        const rows = rowsResult.rows as WritebackClaimRow[];
        if (rows.length === 0) { await client.query('COMMIT'); return []; }

        const idPh = rows.map((_, i) => `$${i + 3}`).join(',');
        await client.query(`
          UPDATE notification_writeback_jobs
          SET status = 'sending', attempt_count = attempt_count + 1,
              lease_expires_at = $1, last_error = NULL, updated_at = $2
          WHERE id IN (${idPh}) AND status = 'pending'
        `, [leaseExpiresAt, nowIso, ...rows.map(r => r.id)]);
        await client.query('COMMIT');
        return rows.map(r => ({ ...r, attemptCount: r.attemptCount + 1, leaseExpiresAt }));
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    async completeWritebackJobs(jobs) {
      if (jobs.length === 0) return;
      const now = new Date().toISOString();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const job of jobs) {
          const completed = await client.query(`
            UPDATE notification_writeback_jobs
            SET status = 'succeeded', completed_at = $1, lease_expires_at = NULL, updated_at = $2
            WHERE id = $3 AND status = 'sending' AND lease_expires_at = $4
          `, [now, now, job.id, job.leaseExpiresAt]);
          if ((completed.rowCount ?? 0) === 1) await refreshSyncStateOn(client, job.notificationId);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    async failWritebackJobs(jobs, error, maxRetryMs, retryBaseMs) {
      if (jobs.length === 0) return;
      const now = new Date();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const job of jobs) {
          let hasNewerAction = false;
          if (job.actionType === 'mute' || job.actionType === 'unmute') {
            const newer = await client.query(`
              SELECT 1 FROM notification_writeback_jobs newer
              WHERE newer.notification_id = $1
                AND (newer.created_at, newer.id) > (
                  SELECT current.created_at, current.id
                  FROM notification_writeback_jobs current WHERE current.id = $2
                )
                AND newer.status <> 'superseded'
                AND newer.action_type IN ('mute', 'unmute') AND newer.action_type <> $3
              LIMIT 1
            `, [job.notificationId, job.id, job.actionType]);
            hasNewerAction = (newer.rowCount ?? 0) > 0;
          }
          if (hasNewerAction) {
            const superseded = await client.query(`
              UPDATE notification_writeback_jobs
              SET status = 'superseded', retryable = false, lease_expires_at = NULL,
                  last_error = 'Superseded by a newer notification action',
                  completed_at = $1, updated_at = $2
              WHERE id = $3 AND status = 'sending' AND lease_expires_at = $4
            `, [now.toISOString(), now.toISOString(), job.id, job.leaseExpiresAt]);
            if ((superseded.rowCount ?? 0) === 1) await refreshSyncStateOn(client, job.notificationId);
            continue;
          }
          const terminal = !error.retryable || job.attemptCount >= job.maxAttempts;
          const delay = Math.min(maxRetryMs, retryBaseMs * 2 ** Math.max(0, job.attemptCount - 1));
          const nextAttemptAt = error.retryAt && error.retryAt > now
            ? error.retryAt : new Date(now.getTime() + delay);
          const failed = await client.query(`
            UPDATE notification_writeback_jobs
            SET status = $1, retryable = $2, next_attempt_at = $3,
                lease_expires_at = NULL, last_error = $4,
                completed_at = $5, updated_at = $6
            WHERE id = $7 AND status = 'sending' AND lease_expires_at = $8
          `, [
            terminal ? 'failed' : 'pending',
            error.retryable,
            terminal ? now.toISOString() : nextAttemptAt.toISOString(),
            error.message.slice(0, 1_000),
            terminal ? now.toISOString() : null,
            now.toISOString(),
            job.id, job.leaseExpiresAt,
          ]);
          if ((failed.rowCount ?? 0) === 1) await refreshSyncStateOn(client, job.notificationId);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    async renewWritebackLeases(jobs, leaseMs) {
      if (jobs.length === 0) return [];
      const now = new Date();
      const nowIso = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const renewed: WritebackClaimRow[] = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const job of jobs) {
          const result = await client.query(`
            UPDATE notification_writeback_jobs
            SET lease_expires_at = $1, updated_at = $2
            WHERE id = $3 AND status = 'sending' AND lease_expires_at = $4
          `, [leaseExpiresAt, nowIso, job.id, job.leaseExpiresAt]);
          if ((result.rowCount ?? 0) === 1) renewed.push({ ...job, leaseExpiresAt });
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return renewed;
    },

    async releaseUnattemptedWritebackJobs(jobs) {
      if (jobs.length === 0) return;
      const now = new Date().toISOString();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const job of jobs) {
          await client.query(`
            UPDATE notification_writeback_jobs
            SET status = 'pending', attempt_count = GREATEST(0, attempt_count - 1),
                lease_expires_at = NULL, updated_at = $1
            WHERE id = $2 AND status = 'sending' AND lease_expires_at = $3
          `, [now, job.id, job.leaseExpiresAt]);
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    async getNextScheduledWriteback() {
      const nextPending = await pool.query(`
        SELECT jobs.next_attempt_at AS "nextAttemptAt"
        FROM notification_writeback_jobs jobs
        WHERE jobs.status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM notification_writeback_jobs earlier
            WHERE earlier.notification_id = jobs.notification_id
              AND (earlier.created_at, earlier.id) < (jobs.created_at, jobs.id)
              AND earlier.status IN ('pending', 'sending')
          )
        ORDER BY jobs.next_attempt_at LIMIT 1
      `);
      const nextLease = await pool.query(`
        SELECT lease_expires_at AS "nextAttemptAt"
        FROM notification_writeback_jobs
        WHERE status = 'sending' AND lease_expires_at IS NOT NULL
        ORDER BY lease_expires_at LIMIT 1
      `);
      const candidates = [nextPending.rows[0], nextLease.rows[0]]
        .filter((v): v is { nextAttemptAt: string } => !!v)
        .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt));
      return candidates[0] ?? null;
    },

    refreshNotificationSyncState: refreshSyncState,

    wakeWritebackDispatcher() {
      wakeNotificationWritebackDispatcher();
    },
  };
}
