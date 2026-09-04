import type Database from 'better-sqlite3';
import type {
  NotificationWebPersistence,
  NotificationRow,
  NotificationActionRow,
  NotificationStats,
  NotificationFacets,
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
} from './notification-web';
import type { NotificationQuery } from '@/lib/notifications/query';
import type { NotificationState } from '@/types';
import { legacyStateFromLifecycle, legacyStateMutationPatch } from '@/lib/notifications/lifecycle';
import {
  NOTIFICATION_MERCHANT_KEY_LENGTH,
  MAX_NOTIFICATION_MERCHANT_LABEL_LENGTH,
  MAX_NOTIFICATION_MERCHANT_FACETS,
} from '@/lib/notifications/query';
import { normalizeFinanceProviderFacets, financeProviderFilterValues } from '@/lib/finance-insights/provider';
import {
  NOTIFICATION_IS_INBOX_SQL,
  NOTIFICATION_COUNTS_TOWARD_ATTENTION_SQL,
} from '@/lib/notifications/lifecycle-sql';

const PARTICIPATING_REASONS = ['author', 'comment', 'manual', 'state_change', 'subscribed'];

// ─── Query building (raw SQL) ───────────────────────────────────────────────

function merchantMetadataCondition(merchant?: string | null): string {
  const base = [
    `json_type(presentation, '$.financeMerchantKey') = 'text'`,
    `json_type(presentation, '$.financeMerchantLabel') = 'text'`,
    `length(json_extract(presentation, '$.financeMerchantKey')) = ${NOTIFICATION_MERCHANT_KEY_LENGTH}`,
    `substr(json_extract(presentation, '$.financeMerchantKey'), 1, 12) = 'merchant-v1_'`,
    `substr(json_extract(presentation, '$.financeMerchantKey'), 13) NOT GLOB '*[^A-Za-z0-9_-]*'`,
    `length(trim(json_extract(presentation, '$.financeMerchantLabel'))) BETWEEN 1 AND ${MAX_NOTIFICATION_MERCHANT_LABEL_LENGTH}`,
  ];
  if (merchant) base.push(`json_extract(presentation, '$.financeMerchantKey') = ?`);
  return base.join(' AND ');
}

function inboxConditionSql(): string {
  return NOTIFICATION_IS_INBOX_SQL;
}

function buildWhereClauses(
  query: NotificationQuery,
  cursor: string | null,
  params: unknown[],
): string[] {
  const now = new Date().toISOString();
  const conditions: string[] = [];

  if (!query.state) {
    conditions.push(`(${inboxConditionSql()})`);
    params.push(now);
  }
  conditions.push(`connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)`);

  if (query.q) {
    conditions.push(`(instr(lower(title), lower(?)) > 0 OR instr(lower(COALESCE(body, '')), lower(?)) > 0)`);
    params.push(query.q, query.q);
  }
  if (query.source) {
    const sourceTypes = financeProviderFilterValues(query.source);
    if (sourceTypes.length === 1) {
      conditions.push(`connector_type = ?`);
      params.push(sourceTypes[0]);
    } else {
      conditions.push(`connector_type IN (${sourceTypes.map(() => '?').join(',')})`);
      params.push(...sourceTypes);
    }
  }
  if (query.sourceAccount) {
    conditions.push(`connector_instance_id = ?`);
    params.push(query.sourceAccount);
  }
  if (query.level) {
    conditions.push(`level = ?`);
    params.push(query.level);
  }
  if (query.category) {
    conditions.push(`category = ?`);
    params.push(query.category);
  }
  if (query.merchant) {
    conditions.push(`(${merchantMetadataCondition(query.merchant)})`);
    params.push(query.merchant);
  }
  switch (query.state) {
    case 'unread':
    case 'read':
      conditions.push(`read_state = ?`);
      params.push(query.state);
      conditions.push(`(${inboxConditionSql()})`);
      params.push(now);
      break;
    case 'dismissed':
      conditions.push(`disposition = 'dismissed'`);
      break;
    case 'archived':
      conditions.push(`disposition = 'handled'`);
      conditions.push(`source_state IN ('active', 'unknown')`);
      break;
    case 'resolved':
      conditions.push(`source_state IN ('resolved', 'deleted')`);
      conditions.push(`disposition <> 'dismissed'`);
      break;
  }
  if (query.actionableOnly) conditions.push(`is_actionable = 1`);
  if (query.repository) {
    conditions.push(`json_extract(presentation, '$.repository') = ?`);
    params.push(query.repository);
  }
  if (query.owner) {
    conditions.push(`substr(json_extract(presentation, '$.repository'), 1, instr(json_extract(presentation, '$.repository'), '/') - 1) = ?`);
    params.push(query.owner);
  }
  if (query.reason) {
    conditions.push(`json_extract(presentation, '$.reason') = ?`);
    params.push(query.reason);
  }
  if (query.subjectType) {
    conditions.push(`json_extract(presentation, '$.subjectType') = ?`);
    params.push(query.subjectType);
  }
  if (query.participating) {
    conditions.push(`json_extract(presentation, '$.reason') IN (${PARTICIPATING_REASONS.map(() => '?').join(',')})`);
    params.push(...PARTICIPATING_REASONS);
  }
  if (query.dateRange) {
    const dateNow = new Date();
    const since = query.dateRange === 'today'
      ? new Date(dateNow.getFullYear(), dateNow.getMonth(), dateNow.getDate())
      : new Date(dateNow.getTime() - (query.dateRange === 'week' ? 7 : 30) * 86_400_000);
    conditions.push(`received_at >= ?`);
    params.push(since.toISOString());
  }
  if (cursor) {
    const separator = cursor.lastIndexOf('|');
    const cursorSortAt = separator > 0 ? cursor.slice(0, separator) : '';
    const cursorId = separator > 0 ? cursor.slice(separator + 1) : '';
    if (cursorSortAt && cursorId) {
      if (query.sort === 'oldest') {
        conditions.push(`(sort_at > ? OR (sort_at = ? AND id > ?))`);
      } else {
        conditions.push(`(sort_at < ? OR (sort_at = ? AND id < ?))`);
      }
      params.push(cursorSortAt, cursorSortAt, cursorId);
    }
  }
  return conditions;
}

function normalizeWritebackSourceId(sourceId: string): string {
  const separator = sourceId.indexOf(':');
  const connectorSourceId = separator === -1 ? sourceId : sourceId.slice(separator + 1);
  return connectorSourceId.replace(/^docintel-/, '');
}

// ─── Writeback mutation SQL builders ────────────────────────────────────────

function mutationUpdateSql(
  action: NotificationMutationAction | 'dismiss',
  placeholders: string,
): { sql: string; parameters: (changedAt: string) => string[] } {
  switch (action) {
    case 'mark_read':
      return {
        sql: `UPDATE notifications
          SET read_state = 'read',
              read_at = COALESCE(read_at, ?),
              state = CASE
                WHEN disposition = 'dismissed' THEN 'dismissed'
                WHEN source_state IN ('resolved', 'deleted') THEN 'resolved'
                WHEN disposition = 'handled' THEN 'archived'
                ELSE 'read'
              END
          WHERE id IN (${placeholders})`,
        parameters: (changedAt) => [changedAt],
      };
    case 'mark_done':
      return {
        sql: `UPDATE notifications
          SET disposition = 'handled',
              handled_at = ?,
              archived_at = ?,
              handled_source_activity_at = last_source_activity_at,
              handled_source_activity_key = last_source_activity_key,
              state = CASE
                WHEN source_state IN ('resolved', 'deleted') THEN 'resolved'
                ELSE 'archived'
              END
          WHERE id IN (${placeholders})`,
        parameters: (changedAt) => [changedAt, changedAt],
      };
    case 'mute':
      return {
        sql: `UPDATE notifications
          SET read_state = 'read',
              read_at = COALESCE(read_at, ?),
              disposition = 'dismissed',
              dismissed_at = ?,
              muted_at = ?,
              state = 'dismissed'
          WHERE id IN (${placeholders})`,
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
          WHERE id IN (${placeholders})`,
        parameters: () => [],
      };
    case 'dismiss':
      return {
        sql: `UPDATE notifications
          SET read_state = 'read',
              read_at = COALESCE(read_at, ?),
              disposition = 'dismissed',
              dismissed_at = ?,
              state = 'dismissed'
          WHERE id IN (${placeholders})`,
        parameters: (changedAt) => [changedAt, changedAt],
      };
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createSqliteNotificationWebRepository(
  sqlite: Database.Database,
): NotificationWebPersistence {
  function refreshSyncState(notificationId: string): void {
    sqlite.prepare(`
      UPDATE notifications
      SET sync_state = CASE
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
      END
      WHERE id = ?
    `).run(notificationId);
  }

  type WritebackSourceRow = {
    id: string;
    sourceId: string;
    connectorType: string;
    connectorInstanceId: string;
  };

  function insertDismissalWritebackRows(rows: WritebackSourceRow[], now: string): number {
    const insert = sqlite.prepare(`
      INSERT INTO notification_writeback_jobs (
        id, notification_id, connector_instance_id, connector_type, source_id,
        action_type, dedupe_key, status, attempt_count, max_attempts, next_attempt_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'mark_done', ?, 'pending', 0, 3, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        status = 'pending',
        attempt_count = 0,
        next_attempt_at = excluded.next_attempt_at,
        lease_expires_at = NULL,
        last_error = NULL,
        completed_at = NULL,
        updated_at = excluded.updated_at
      WHERE notification_writeback_jobs.status = 'failed'
    `);
    let queued = 0;
    for (const row of rows) {
      const result = insert.run(
        crypto.randomUUID(),
        row.id,
        row.connectorInstanceId,
        row.connectorType,
        normalizeWritebackSourceId(row.sourceId),
        `dismiss:${row.id}`,
        now, now, now,
      );
      queued += result.changes;
    }
    return queued;
  }

  function insertTypedWritebackRow(
    row: WritebackSourceRow,
    action: string,
    now: string,
  ): { queued: number; pending: boolean } {
    const baseDedupeKey = `${action}:${row.id}:${now}`;
    const existing = sqlite.prepare(`
      SELECT jobs.status
      FROM notification_writeback_jobs jobs
      WHERE jobs.dedupe_key = ?
        AND NOT EXISTS (
          SELECT 1
          FROM notification_writeback_jobs newer
          WHERE newer.notification_id = jobs.notification_id
            AND newer.rowid > jobs.rowid
            AND newer.status <> 'superseded'
        )
    `).get(baseDedupeKey) as { status: string } | undefined;
    if (existing && ['pending', 'sending', 'succeeded'].includes(existing.status)) {
      return {
        queued: 0,
        pending: existing.status === 'pending' || existing.status === 'sending',
      };
    }
    const dedupeKey = sqlite.prepare(
      `SELECT 1 FROM notification_writeback_jobs WHERE dedupe_key = ?`,
    ).get(baseDedupeKey)
      ? `${baseDedupeKey}:${crypto.randomUUID()}`
      : baseDedupeKey;
    if (action === 'mute' || action === 'unmute') {
      sqlite.prepare(`
        UPDATE notification_writeback_jobs
        SET status = 'superseded',
            retryable = 0,
            completed_at = ?,
            updated_at = ?,
            last_error = 'Superseded by a newer notification action'
        WHERE notification_id = ?
          AND status IN ('pending', 'failed')
          AND action_type IN ('mute', 'unmute')
          AND action_type <> ?
      `).run(now, now, row.id, action);
    }
    const queued = sqlite.prepare(`
      INSERT INTO notification_writeback_jobs (
        id, notification_id, connector_instance_id, connector_type, source_id,
        action_type, dedupe_key, status, retryable, attempt_count, max_attempts,
        next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, 0, 5, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO NOTHING
    `).run(
      crypto.randomUUID(),
      row.id,
      row.connectorInstanceId,
      row.connectorType,
      normalizeWritebackSourceId(row.sourceId),
      action, dedupeKey, now, now, now,
    ).changes;
    return { queued, pending: queued === 1 };
  }

  return {
    async queryNotifications(input) {
      const { query, limit, cursor } = input;
      const now = new Date().toISOString();

      // Selected merchant facet (for the merchant query filter)
      let selectedMerchantFacet: { key: string; label: string; count: number } | null = null;
      if (query.merchant) {
        const row = sqlite.prepare(`
          SELECT MIN(json_extract(presentation, '$.financeMerchantLabel')) AS label,
                 COUNT(*) AS count
          FROM notifications
          WHERE connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
            AND ${merchantMetadataCondition(query.merchant)}
        `).get(query.merchant) as { label: string; count: number } | undefined;
        if (!row || Number(row.count) === 0) {
          return {
            items: [], actions: [], hasMore: false, cursor: null,
            stats: { total: 0, unread: 0, attention: 0, urgent: 0, actionNeeded: 0, headsUp: 0, fyi: 0, digest: 0, actionable: 0 },
            facets: { level: {}, category: {}, source: {}, state: {}, merchant: [] },
            matchingCount: 0,
          };
        }
        selectedMerchantFacet = { key: query.merchant, label: row.label, count: Number(row.count) };
      }

      // Paginated query
      const paginatedParams: unknown[] = [];
      const paginatedConditions = buildWhereClauses(query, cursor, paginatedParams);
      const orderDir = query.sort === 'oldest' ? 'ASC' : 'DESC';
      const paginatedWhere = paginatedConditions.length ? `WHERE ${paginatedConditions.join(' AND ')}` : '';
      const rows = sqlite.prepare(`
        SELECT * FROM notifications ${paginatedWhere}
        ORDER BY sort_at ${orderDir}, id ${orderDir}
        LIMIT ?
      `).all(...paginatedParams, limit + 1) as NotificationRow[];

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;

      // Hydrate actions
      const notificationIds = items.map(n => n.id);
      let actions: NotificationActionRow[] = [];
      if (notificationIds.length > 0) {
        const ph = notificationIds.map(() => '?').join(',');
        actions = sqlite.prepare(`
          SELECT * FROM notification_actions
          WHERE notification_id IN (${ph})
            AND execution_state = 'pending'
          ORDER BY sort_order ASC
        `).all(...notificationIds) as NotificationActionRow[];
      }

      // Stats (always unfiltered)
      const statsRow = sqlite.prepare(`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN read_state = 'unread' THEN 1 ELSE 0 END), 0) AS unread,
          COALESCE(SUM(CASE WHEN ${NOTIFICATION_COUNTS_TOWARD_ATTENTION_SQL} THEN 1 ELSE 0 END), 0) AS attention,
          COALESCE(SUM(CASE WHEN level = 'urgent' THEN 1 ELSE 0 END), 0) AS urgent,
          COALESCE(SUM(CASE WHEN level = 'action_needed' THEN 1 ELSE 0 END), 0) AS actionNeeded,
          COALESCE(SUM(CASE WHEN level = 'heads_up' AND read_state = 'unread' THEN 1 ELSE 0 END), 0) AS headsUp,
          COALESCE(SUM(CASE WHEN level = 'fyi' AND read_state = 'unread' THEN 1 ELSE 0 END), 0) AS fyi,
          COALESCE(SUM(CASE WHEN level = 'digest' AND read_state = 'unread' THEN 1 ELSE 0 END), 0) AS digest,
          COALESCE(SUM(CASE WHEN is_actionable = 1 THEN 1 ELSE 0 END), 0) AS actionable
        FROM notifications
        WHERE ${inboxConditionSql()}
          AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
      `).get(now) as NotificationStats;

      // Facets
      const levelFacets = sqlite.prepare(`
        SELECT level AS value, COUNT(*) AS count
        FROM notifications WHERE ${inboxConditionSql()}
          AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
        GROUP BY level
      `).all(now) as Array<{ value: string | null; count: number }>;
      const categoryFacets = sqlite.prepare(`
        SELECT category AS value, COUNT(*) AS count
        FROM notifications WHERE ${inboxConditionSql()}
          AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
        GROUP BY category
      `).all(now) as Array<{ value: string | null; count: number }>;
      const sourceFacets = sqlite.prepare(`
        SELECT connector_type AS value, COUNT(*) AS count
        FROM notifications WHERE ${inboxConditionSql()}
          AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
        GROUP BY connector_type
      `).all(now) as Array<{ value: string | null; count: number }>;
      const stateFacets = sqlite.prepare(`
        SELECT state AS value, COUNT(*) AS count
        FROM notifications WHERE connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
        GROUP BY state
      `).all() as Array<{ value: string | null; count: number }>;
      const rawMerchantFacets = sqlite.prepare(`
        SELECT json_extract(presentation, '$.financeMerchantKey') AS key,
               MIN(json_extract(presentation, '$.financeMerchantLabel')) AS label,
               COUNT(*) AS count
        FROM notifications
        WHERE ${inboxConditionSql()}
          AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
          AND ${merchantMetadataCondition()}
        GROUP BY json_extract(presentation, '$.financeMerchantKey')
        ORDER BY COUNT(*) DESC, json_extract(presentation, '$.financeMerchantKey') ASC
        LIMIT ${MAX_NOTIFICATION_MERCHANT_FACETS}
      `).all(now) as Array<{ key: string; label: string; count: number }>;

      // Matching count
      const unpaginatedParams: unknown[] = [];
      const unpaginatedConditions = buildWhereClauses(query, null, unpaginatedParams);
      const unpaginatedWhere = unpaginatedConditions.length ? `WHERE ${unpaginatedConditions.join(' AND ')}` : '';
      const matchingRow = sqlite.prepare(`
        SELECT COUNT(*) AS count FROM notifications ${unpaginatedWhere}
      `).get(...unpaginatedParams) as { count: number };

      const toRecord = (rows: { value: string | null; count: number }[]) =>
        Object.fromEntries(rows.filter(r => r.value).map(r => [r.value!, Number(r.count)]));
      const normalizedMerchantFacets = rawMerchantFacets.map(f => ({
        key: f.key, label: f.label, count: Number(f.count),
      }));
      if (selectedMerchantFacet && !normalizedMerchantFacets.some(f => f.key === selectedMerchantFacet?.key)) {
        if (normalizedMerchantFacets.length === MAX_NOTIFICATION_MERCHANT_FACETS) normalizedMerchantFacets.pop();
        normalizedMerchantFacets.push(selectedMerchantFacet);
      }

      return {
        items,
        actions,
        hasMore,
        cursor: items.length > 0 ? `${items[items.length - 1].sortAt}|${items[items.length - 1].id}` : null,
        stats: {
          total: Number(statsRow.total),
          unread: Number(statsRow.unread),
          attention: Number(statsRow.attention),
          urgent: Number(statsRow.urgent),
          actionNeeded: Number(statsRow.actionNeeded),
          headsUp: Number(statsRow.headsUp),
          fyi: Number(statsRow.fyi),
          digest: Number(statsRow.digest),
          actionable: Number(statsRow.actionable),
        },
        facets: {
          level: toRecord(levelFacets),
          category: toRecord(categoryFacets),
          source: normalizeFinanceProviderFacets(sourceFacets),
          state: toRecord(stateFacets),
          merchant: normalizedMerchantFacets,
        },
        matchingCount: Number(matchingRow.count),
      };
    },

    recoverStaleActions(recoveryCutoff) {
      sqlite.transaction((tx) => {
        const staleActions = tx.prepare(`
          SELECT id, notification_id AS notificationId, is_primary AS isPrimary
          FROM notification_actions
          WHERE action_type = 'run_workflow'
            AND execution_state = 'running'
            AND claimed_at < ?
        `).all(recoveryCutoff) as Array<{ id: string; notificationId: string; isPrimary: number }>;
        if (staleActions.length === 0) return;
        const ph = staleActions.map(() => '?').join(',');
        tx.prepare(`
          UPDATE notification_actions
          SET execution_state = 'pending', claimed_at = NULL
          WHERE id IN (${ph})
        `).run(...staleActions.map(a => a.id));
        for (const action of staleActions) {
          if (!action.isPrimary) continue;
          tx.prepare(`
            UPDATE notifications SET is_actionable = 1, primary_action_id = ?
            WHERE id = ?
          `).run(action.id, action.notificationId);
        }
      }).immediate();
    },

    async restoreSnapshots(snapshots) {
      const ids = [...new Set(snapshots.map(s => s.id))];
      const ph = ids.map(() => '?').join(',');
      const current = sqlite.prepare(`
        SELECT id, source_state AS sourceState FROM notifications WHERE id IN (${ph})
      `).all(...ids) as Array<{ id: string; sourceState: string }>;
      const sourceStateById = new Map(current.map(r => [r.id, r.sourceState]));
      let updatedCount = 0;
      for (const snapshot of snapshots) {
        const sourceState = sourceStateById.get(snapshot.id);
        if (!sourceState) continue;
        const state = legacyStateFromLifecycle({
          readState: snapshot.readState,
          disposition: snapshot.disposition,
          sourceState,
        });
        const result = sqlite.prepare(`
          UPDATE notifications SET
            state = ?, read_state = ?, disposition = ?,
            read_at = ?, handled_at = ?, dismissed_at = ?,
            archived_at = ?, handled_source_activity_at = ?,
            handled_source_activity_key = ?
          WHERE id = ?
        `).run(
          state, snapshot.readState, snapshot.disposition,
          snapshot.readAt ?? null, snapshot.handledAt ?? null,
          snapshot.dismissedAt ?? null, snapshot.archivedAt ?? null,
          snapshot.handledSourceActivityAt ?? null,
          snapshot.handledSourceActivityKey ?? null,
          snapshot.id,
        );
        updatedCount += result.changes;
      }
      return { updatedCount };
    },

    async mutateStates(ids, state, now) {
      const ph = ids.map(() => '?').join(',');
      const current = sqlite.prepare(`
        SELECT id, read_state AS readState, disposition, source_state AS sourceState,
               last_source_activity_at AS lastSourceActivityAt,
               last_source_activity_key AS lastSourceActivityKey
        FROM notifications WHERE id IN (${ph})
      `).all(...ids) as Array<{
        id: string; readState: string; disposition: string; sourceState: string;
        lastSourceActivityAt: string | null; lastSourceActivityKey: string | null;
      }>;
      for (const notification of current) {
        const patch = legacyStateMutationPatch(notification, state as NotificationState, now);
        const sets: string[] = [];
        const values: unknown[] = [];
        for (const [key, value] of Object.entries(patch)) {
          const column = key.replace(/([A-Z])/g, '_$1').toLowerCase();
          sets.push(`${column} = ?`);
          values.push(value ?? null);
        }
        sqlite.prepare(`UPDATE notifications SET ${sets.join(', ')} WHERE id = ?`).run(...values, notification.id);
      }
      return { updatedCount: current.length };
    },

    async snoozeNotification(id, snoozeUntil) {
      const row = sqlite.prepare(`SELECT id, metadata FROM notifications WHERE id = ?`).get(id) as {
        id: string; metadata: unknown;
      } | undefined;
      if (!row) return false;
      let existingMeta: Record<string, unknown> = {};
      if (typeof row.metadata === 'string') {
        try { existingMeta = JSON.parse(row.metadata); } catch { /* ignore malformed */ }
      } else if (row.metadata && typeof row.metadata === 'object') {
        existingMeta = row.metadata as Record<string, unknown>;
      }
      sqlite.prepare(`
        UPDATE notifications SET snoozed_until = ?, metadata = ? WHERE id = ?
      `).run(snoozeUntil, JSON.stringify({
        ...existingMeta,
        snoozedUntil: snoozeUntil,
        snoozedAt: new Date().toISOString(),
      }), id);
      return true;
    },

    async selectForBulkByIds(ids, limit) {
      const ph = ids.map(() => '?').join(',');
      return sqlite.prepare(`
        SELECT id, read_state AS readState, disposition, source_state AS sourceState,
               muted_at AS mutedAt
        FROM notifications
        WHERE id IN (${ph})
          AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
        LIMIT ?
      `).all(...ids, limit) as BulkSelectedRow[];
    },

    async selectForBulkByQuery(query, limit) {
      const params: unknown[] = [];
      const conditions = buildWhereClauses(query, null, params);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      return sqlite.prepare(`
        SELECT id, read_state AS readState, disposition, source_state AS sourceState,
               muted_at AS mutedAt
        FROM notifications ${where}
        LIMIT ?
      `).all(...params, limit) as BulkSelectedRow[];
    },

    async validateMerchantExists(merchant) {
      const row = sqlite.prepare(`
        SELECT 1 FROM notifications
        WHERE connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
          AND ${merchantMetadataCondition(merchant)}
        LIMIT 1
      `).get(merchant);
      return !!row;
    },

    async validateMerchantForSelected(merchant) {
      const row = sqlite.prepare(`
        SELECT MIN(json_extract(presentation, '$.financeMerchantLabel')) AS label,
               COUNT(*) AS count
        FROM notifications
        WHERE connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
          AND ${merchantMetadataCondition(merchant)}
      `).get(merchant) as { label: string; count: number } | undefined;
      if (!row || Number(row.count) === 0) return null;
      return { label: row.label, count: Number(row.count) };
    },

    bulkMarkUnread: async (ids, now) => {
      const ph = ids.map(() => '?').join(',');
      return sqlite.prepare(`
        UPDATE notifications SET
          read_state = 'unread', read_at = NULL,
          state = CASE
            WHEN disposition = 'dismissed' THEN 'dismissed'
            WHEN source_state IN ('resolved', 'deleted') THEN 'resolved'
            WHEN disposition = 'handled' THEN 'archived'
            ELSE 'unread'
          END
        WHERE id IN (${ph})
      `).run(...ids).changes;
    },

    bulkDismissDemo: async (ids, now) => {
      const ph = ids.map(() => '?').join(',');
      return sqlite.prepare(`
        UPDATE notifications SET
          state = 'dismissed', read_state = 'read', disposition = 'dismissed',
          read_at = ?, dismissed_at = ?
        WHERE id IN (${ph})
      `).run(now, now, ...ids).changes;
    },

    bulkHandleDemo: async (ids, now) => {
      const ph = ids.map(() => '?').join(',');
      return sqlite.prepare(`
        UPDATE notifications SET
          state = CASE WHEN source_state IN ('resolved', 'deleted') THEN 'resolved' ELSE 'archived' END,
          disposition = 'handled', handled_at = ?, archived_at = ?,
          handled_source_activity_at = last_source_activity_at,
          handled_source_activity_key = last_source_activity_key
        WHERE id IN (${ph})
      `).run(now, now, ...ids).changes;
    },

    bulkMarkReadDemo: async (ids, now) => {
      const ph = ids.map(() => '?').join(',');
      return sqlite.prepare(`
        UPDATE notifications SET
          read_state = 'read', read_at = ?,
          state = CASE
            WHEN disposition = 'dismissed' THEN 'dismissed'
            WHEN source_state IN ('resolved', 'deleted') THEN 'resolved'
            WHEN disposition = 'handled' THEN 'archived'
            ELSE 'read'
          END
        WHERE id IN (${ph})
      `).run(now, ...ids).changes;
    },

    mutateNotificationsAndEnqueueWritebacks(notificationIds, action, changedAt) {
      if (notificationIds.length === 0) return { updatedCount: 0, queuedCount: 0, results: [] };
      const ph = notificationIds.map(() => '?').join(',');
      const transaction = sqlite.transaction(() => {
        const rows = sqlite.prepare(`
          SELECT id, source_id AS sourceId, connector_type AS connectorType,
                 connector_instance_id AS connectorInstanceId
          FROM notifications WHERE id IN (${ph})
        `).all(...notificationIds) as WritebackSourceRow[];
        const rowById = new Map(rows.map(r => [r.id, r]));
        const queuedIds = new Set<string>();
        let queuedCount = 0;
        if (action !== 'dismiss') {
          for (const row of rows) {
            if (row.connectorType !== 'github-issues') continue;
            const writeback = insertTypedWritebackRow(row, action, changedAt);
            queuedCount += writeback.queued;
            if (writeback.pending) queuedIds.add(row.id);
          }
        }
        const update = mutationUpdateSql(action, ph);
        const updateResult = sqlite.prepare(update.sql).run(
          ...update.parameters(changedAt), ...notificationIds,
        );
        for (const row of rows) refreshSyncState(row.id);
        return {
          updatedCount: updateResult.changes,
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
      });
      return transaction.immediate();
    },

    dismissNotificationsAndEnqueueWritebacks(notificationIds, dismissedAt) {
      if (notificationIds.length === 0) return { updatedCount: 0, queuedCount: 0 };
      const ph = notificationIds.map(() => '?').join(',');
      const transaction = sqlite.transaction(() => {
        const rows = sqlite.prepare(`
          SELECT id, source_id AS sourceId, connector_type AS connectorType,
                 connector_instance_id AS connectorInstanceId
          FROM notifications WHERE id IN (${ph})
        `).all(...notificationIds) as WritebackSourceRow[];
        const queuedCount = insertDismissalWritebackRows(rows, dismissedAt);
        const updateResult = sqlite.prepare(`
          UPDATE notifications
          SET state = 'dismissed', read_state = 'read', disposition = 'dismissed',
              sync_state = CASE
                WHEN EXISTS (
                  SELECT 1 FROM notification_writeback_jobs jobs
                  WHERE jobs.notification_id = notifications.id AND jobs.status = 'failed'
                ) THEN 'failed'
                WHEN EXISTS (
                  SELECT 1 FROM notification_writeback_jobs jobs
                  WHERE jobs.notification_id = notifications.id AND jobs.status IN ('pending', 'sending')
                ) THEN 'pending'
                ELSE 'synced'
              END,
              read_at = COALESCE(read_at, ?),
              dismissed_at = ?
          WHERE id IN (${ph})
        `).run(dismissedAt, dismissedAt, ...notificationIds);
        return { updatedCount: updateResult.changes, queuedCount };
      });
      return transaction.immediate();
    },

    async listSavedViews() {
      return sqlite.prepare(`
        SELECT id, name, query, created_at AS createdAt, updated_at AS updatedAt
        FROM notification_saved_views
        ORDER BY name ASC
      `).all() as SavedViewRow[];
    },

    async createSavedView(input) {
      const row = {
        id: input.id,
        name: input.name,
        query: JSON.stringify(input.query),
        createdAt: input.now,
        updatedAt: input.now,
      };
      sqlite.prepare(`
        INSERT INTO notification_saved_views (id, name, query, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(row.id, row.name, row.query, row.createdAt, row.updatedAt);
      return { ...row, query: row.query };
    },

    async deleteSavedView(id) {
      return sqlite.prepare(`DELETE FROM notification_saved_views WHERE id = ?`).run(id).changes === 1;
    },

    async listWritebackStatus(notificationId) {
      const where = notificationId ? 'AND notification_id = ?' : '';
      const params = notificationId ? [notificationId] : [];
      const counts = sqlite.prepare(`
        SELECT status, COUNT(*) AS count FROM notification_writeback_jobs GROUP BY status
      `).all() as Array<{ status: string; count: number }>;
      const jobs = sqlite.prepare(`
        SELECT id, notification_id AS notificationId, connector_instance_id AS connectorInstanceId,
               action_type AS action, status, retryable, attempt_count AS attemptCount,
               max_attempts AS maxAttempts, next_attempt_at AS nextAttemptAt,
               last_error AS lastError, updated_at AS updatedAt
        FROM notification_writeback_jobs
        WHERE status IN ('pending', 'sending', 'failed') ${where}
        ORDER BY updated_at DESC LIMIT 50
      `).all(...params) as WritebackJob[];
      const syncState = jobs.some(j => j.status === 'failed')
        ? 'failed' as const
        : jobs.length > 0 ? 'pending' as const : 'synced' as const;
      return {
        counts: Object.fromEntries(counts.map(r => [r.status, r.count])),
        jobs,
        failed: jobs.filter(j => j.status === 'failed'),
        syncState,
        retryable: jobs.some(j => j.status === 'failed' && (j.retryable === 1 || j.retryable === true)),
      };
    },

    retryWritebacks(selector, ids, now) {
      const ph = ids.map(() => '?').join(',');
      const transaction = sqlite.transaction(() => {
        const retryable = sqlite.prepare(`
          SELECT jobs.id, jobs.notification_id AS notificationId
          FROM notification_writeback_jobs jobs
          WHERE jobs.${selector} IN (${ph})
            AND jobs.status = 'failed'
            AND jobs.retryable = 1
            AND NOT EXISTS (
              SELECT 1 FROM notification_writeback_jobs newer
              WHERE newer.notification_id = jobs.notification_id
                AND newer.rowid > jobs.rowid
                AND newer.status <> 'superseded'
            )
        `).all(...ids) as Array<{ id: string; notificationId: string }>;
        for (const job of retryable) {
          sqlite.prepare(`
            UPDATE notification_writeback_jobs
            SET status = 'pending', attempt_count = 0, next_attempt_at = ?,
                lease_expires_at = NULL, last_error = NULL, completed_at = NULL, updated_at = ?
            WHERE id = ?
          `).run(now, now, job.id);
          sqlite.prepare(`UPDATE notifications SET sync_state = 'pending' WHERE id = ?`).run(job.notificationId);
        }
        return retryable;
      });
      return { retried: transaction.immediate() };
    },

    async findSubscriptionByEndpoint(endpoint) {
      const row = sqlite.prepare(`
        SELECT id FROM push_subscriptions WHERE endpoint = ? AND platform = 'web' LIMIT 1
      `).get(endpoint) as { id: string } | undefined;
      return row ?? null;
    },

    async registerSubscription(input) {
      const id = crypto.randomUUID();
      sqlite.prepare(`
        INSERT INTO push_subscriptions (id, platform, endpoint, keys, user_agent, created_at)
        VALUES (?, 'web', ?, ?, ?, ?)
      `).run(
        id, input.endpoint,
        JSON.stringify({ p256dh: input.keys.p256dh, auth: input.keys.auth }),
        input.userAgent, new Date().toISOString(),
      );
      return id;
    },

    async removeSubscription(endpoint) {
      sqlite.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
    },

    claimNextConnectorBatch(input) {
      const { batchSize, leaseMs, singleJobConnectorIds } = input;
      const now = new Date();
      const nowIso = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const transaction = sqlite.transaction(() => {
        sqlite.prepare(`
          UPDATE notification_writeback_jobs
          SET status = 'pending', lease_expires_at = NULL, updated_at = ?
          WHERE status = 'sending' AND lease_expires_at <= ?
        `).run(nowIso, nowIso);

        const candidate = sqlite.prepare(`
          SELECT jobs.connector_instance_id AS connectorInstanceId
          FROM notification_writeback_jobs jobs
          INNER JOIN notifications notification
            ON notification.id = jobs.notification_id
            AND notification.connector_instance_id = jobs.connector_instance_id
            AND notification.connector_type = jobs.connector_type
          WHERE jobs.status = 'pending' AND jobs.next_attempt_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM notification_writeback_jobs earlier
              WHERE earlier.notification_id = jobs.notification_id
                AND earlier.rowid < jobs.rowid
                AND earlier.status IN ('pending', 'sending')
            )
          ORDER BY jobs.next_attempt_at, jobs.created_at LIMIT 1
        `).get(nowIso) as { connectorInstanceId: string } | undefined;
        if (!candidate) return [];

        const claimLimit = singleJobConnectorIds.has(candidate.connectorInstanceId) ? 1 : batchSize;
        const rows = sqlite.prepare(`
          SELECT jobs.id, jobs.notification_id AS notificationId,
                 jobs.connector_instance_id AS connectorInstanceId,
                 jobs.connector_type AS connectorType, jobs.source_id AS sourceId,
                 jobs.action_type AS actionType, jobs.attempt_count AS attemptCount,
                 jobs.max_attempts AS maxAttempts, jobs.lease_expires_at AS leaseExpiresAt
          FROM notification_writeback_jobs jobs
          INNER JOIN notifications notification
            ON notification.id = jobs.notification_id
            AND notification.connector_instance_id = jobs.connector_instance_id
            AND notification.connector_type = jobs.connector_type
          WHERE jobs.connector_instance_id = ?
            AND jobs.status = 'pending' AND jobs.next_attempt_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM notification_writeback_jobs earlier
              WHERE earlier.notification_id = jobs.notification_id
                AND earlier.rowid < jobs.rowid
                AND earlier.status IN ('pending', 'sending')
            )
          ORDER BY jobs.created_at LIMIT ?
        `).all(candidate.connectorInstanceId, nowIso, claimLimit) as WritebackClaimRow[];
        if (rows.length === 0) return [];

        const ph = rows.map(() => '?').join(',');
        sqlite.prepare(`
          UPDATE notification_writeback_jobs
          SET status = 'sending', attempt_count = attempt_count + 1,
              lease_expires_at = ?, last_error = NULL, updated_at = ?
          WHERE id IN (${ph}) AND status = 'pending'
        `).run(leaseExpiresAt, nowIso, ...rows.map(r => r.id));
        return rows.map(r => ({
          ...r,
          attemptCount: r.attemptCount + 1,
          leaseExpiresAt,
        }));
      });
      return transaction.immediate();
    },

    completeWritebackJobs(jobs) {
      const now = new Date().toISOString();
      const transaction = sqlite.transaction(() => {
        for (const job of jobs) {
          const completed = sqlite.prepare(`
            UPDATE notification_writeback_jobs
            SET status = 'succeeded', completed_at = ?, lease_expires_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
          `).run(now, now, job.id, job.leaseExpiresAt);
          if (completed.changes === 1) refreshSyncState(job.notificationId);
        }
      });
      transaction.immediate();
    },

    failWritebackJobs(jobs, error, maxRetryMs, retryBaseMs) {
      const now = new Date();
      const transaction = sqlite.transaction(() => {
        for (const job of jobs) {
          const hasNewerAction = (job.actionType === 'mute' || job.actionType === 'unmute')
            && sqlite.prepare(`
              SELECT 1 FROM notification_writeback_jobs newer
              WHERE newer.notification_id = ?
                AND newer.rowid > (SELECT current.rowid FROM notification_writeback_jobs current WHERE current.id = ?)
                AND newer.status <> 'superseded'
                AND newer.action_type IN ('mute', 'unmute') AND newer.action_type <> ?
              LIMIT 1
            `).get(job.notificationId, job.id, job.actionType);
          if (hasNewerAction) {
            const superseded = sqlite.prepare(`
              UPDATE notification_writeback_jobs
              SET status = 'superseded', retryable = 0, lease_expires_at = NULL,
                  last_error = 'Superseded by a newer notification action',
                  completed_at = ?, updated_at = ?
              WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
            `).run(now.toISOString(), now.toISOString(), job.id, job.leaseExpiresAt);
            if (superseded.changes === 1) refreshSyncState(job.notificationId);
            continue;
          }
          const terminal = !error.retryable || job.attemptCount >= job.maxAttempts;
          const delay = Math.min(maxRetryMs, retryBaseMs * 2 ** Math.max(0, job.attemptCount - 1));
          const nextAttemptAt = error.retryAt && error.retryAt > now
            ? error.retryAt : new Date(now.getTime() + delay);
          const failed = sqlite.prepare(`
            UPDATE notification_writeback_jobs
            SET status = ?, retryable = ?, next_attempt_at = ?,
                lease_expires_at = NULL, last_error = ?,
                completed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
          `).run(
            terminal ? 'failed' : 'pending',
            error.retryable ? 1 : 0,
            terminal ? now.toISOString() : nextAttemptAt.toISOString(),
            error.message.slice(0, 1_000),
            terminal ? now.toISOString() : null,
            now.toISOString(),
            job.id, job.leaseExpiresAt,
          );
          if (failed.changes === 1) refreshSyncState(job.notificationId);
        }
      });
      transaction.immediate();
    },

    renewWritebackLeases(jobs, leaseMs) {
      const now = new Date();
      const nowIso = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const renewed: WritebackClaimRow[] = [];
      const transaction = sqlite.transaction(() => {
        for (const job of jobs) {
          const result = sqlite.prepare(`
            UPDATE notification_writeback_jobs
            SET lease_expires_at = ?, updated_at = ?
            WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
          `).run(leaseExpiresAt, nowIso, job.id, job.leaseExpiresAt);
          if (result.changes === 1) {
            renewed.push({ ...job, leaseExpiresAt });
          }
        }
      });
      transaction.immediate();
      return renewed;
    },

    releaseUnattemptedWritebackJobs(jobs) {
      if (jobs.length === 0) return;
      const now = new Date().toISOString();
      const transaction = sqlite.transaction(() => {
        for (const job of jobs) {
          sqlite.prepare(`
            UPDATE notification_writeback_jobs
            SET status = 'pending', attempt_count = MAX(0, attempt_count - 1),
                lease_expires_at = NULL, updated_at = ?
            WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
          `).run(now, job.id, job.leaseExpiresAt);
        }
      });
      transaction.immediate();
    },

    getNextScheduledWriteback() {
      const nextPending = sqlite.prepare(`
        SELECT jobs.next_attempt_at AS nextAttemptAt
        FROM notification_writeback_jobs jobs
        WHERE jobs.status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM notification_writeback_jobs earlier
            WHERE earlier.notification_id = jobs.notification_id
              AND earlier.rowid < jobs.rowid
              AND earlier.status IN ('pending', 'sending')
          )
        ORDER BY jobs.next_attempt_at LIMIT 1
      `).get() as { nextAttemptAt: string } | undefined;
      const nextLease = sqlite.prepare(`
        SELECT lease_expires_at AS nextAttemptAt
        FROM notification_writeback_jobs
        WHERE status = 'sending' AND lease_expires_at IS NOT NULL
        ORDER BY lease_expires_at LIMIT 1
      `).get() as { nextAttemptAt: string } | undefined;
      const candidates = [nextPending, nextLease]
        .filter((v): v is { nextAttemptAt: string } => !!v)
        .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt));
      return candidates[0] ?? null;
    },

    refreshNotificationSyncState: refreshSyncState,

    wakeWritebackDispatcher() {
      import('@/lib/notifications/notification-writeback').then(
        m => m.wakeNotificationWritebackDispatcher(),
      ).catch(() => { /* noop if module unavailable */ });
    },
  };
}
