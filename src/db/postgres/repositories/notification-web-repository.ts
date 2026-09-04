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

const PARTICIPATING_REASONS = ['author', 'comment', 'manual', 'state_change', 'subscribed'];

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

  async function refreshSyncState(notificationId: string): Promise<void> {
    await pool.query(`
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
      WHERE id = $1
    `, [notificationId]);
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
        `SELECT * FROM notifications ${paginatedWhere} ORDER BY sort_at ${orderDir}, id ${orderDir} LIMIT $${paramIdx}`,
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
          `SELECT * FROM notification_actions WHERE notification_id IN (${ph}) AND execution_state = 'pending' ORDER BY sort_order ASC`,
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
      ids.push(String(limit));
      const result = await pool.query(`
        SELECT id, read_state AS "readState", disposition, source_state AS "sourceState", muted_at AS "mutedAt"
        FROM notifications WHERE id IN (${ph})
          AND connector_instance_id NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)
        LIMIT $${ids.length}
      `, ids);
      return result.rows as BulkSelectedRow[];
    },

    async selectForBulkByQuery(_query, _limit) {
      throw new Error('selectForBulkByQuery: PostgreSQL implementation deferred to runtime composition');
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

    mutateNotificationsAndEnqueueWritebacks() {
      throw new Error('Writeback mutations use the SQLite runtime composition');
    },

    dismissNotificationsAndEnqueueWritebacks() {
      throw new Error('Writeback mutations use the SQLite runtime composition');
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
      await pool.query(`
        INSERT INTO notification_saved_views (id, name, query, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [input.id, input.name, queryStr, input.now, input.now]);
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

    retryWritebacks() {
      throw new Error('Writeback retry uses the SQLite runtime composition');
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

    claimNextConnectorBatch() {
      throw new Error('Writeback claim uses the SQLite runtime composition');
    },

    completeWritebackJobs() {
      throw new Error('Writeback completion uses the SQLite runtime composition');
    },

    failWritebackJobs() {
      throw new Error('Writeback failure uses the SQLite runtime composition');
    },

    renewWritebackLeases() {
      throw new Error('Writeback lease renewal uses the SQLite runtime composition');
    },

    releaseUnattemptedWritebackJobs() {
      throw new Error('Writeback release uses the SQLite runtime composition');
    },

    getNextScheduledWriteback() {
      throw new Error('Writeback scheduling uses the SQLite runtime composition');
    },

    refreshNotificationSyncState: refreshSyncState as unknown as (notificationId: string) => void,

    wakeWritebackDispatcher() {
      import('@/lib/notifications/notification-writeback').then(
        m => m.wakeNotificationWritebackDispatcher(),
      ).catch(() => { /* noop */ });
    },
  };
}
