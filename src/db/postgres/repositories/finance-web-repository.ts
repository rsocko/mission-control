import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  FinanceWebOperationsData,
  FinanceWebPersistence,
  FinanceWebTransaction,
} from '@/db/persistence/finance-web';
import { FinanceWebPersistenceError } from '@/db/persistence/finance-web';
import type { NotificationRow } from '@/db/persistence/notification-web';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';

type Client = Pool | PoolClient;

const transactionColumns = `
  id, connector_instance_id AS "connectorInstanceId",
  upstream_transaction_id AS "upstreamTransactionId", date, amount,
  merchant_name AS "merchantName", merchant_logo_url AS "merchantLogoUrl",
  category_id AS "categoryId", original_category AS "originalCategory",
  confirmed_category AS "confirmedCategory", account_id AS "accountId",
  account_name AS "accountName", card_last4 AS "cardLast4",
  assigned_kid_id AS "assignedKidId", kid_assignment_method AS "kidAssignmentMethod",
  manual_decision_action AS "manualDecisionAction", manual_decided_at AS "manualDecidedAt",
  attribution_source_ref AS "attributionSourceRef",
  attribution_contract_version AS "attributionContractVersion",
  attribution_status AS "attributionStatus",
  attribution_confidence AS "attributionConfidence",
  attribution_method AS "attributionMethod",
  attribution_explanation AS "attributionExplanation",
  attribution_reasons AS "attributionReasons",
  attribution_decision_source AS "attributionDecisionSource",
  attribution_policy_version AS "attributionPolicyVersion",
  attribution_engine_version AS "attributionEngineVersion",
  attribution_evaluated_at AS "attributionEvaluatedAt",
  attribution_review_state AS "attributionReviewState",
  attribution_provenance AS "attributionProvenance",
  attribution_last_error_code AS "attributionLastErrorCode",
  attribution_retryable AS "attributionRetryable",
  attribution_updated_at AS "attributionUpdatedAt", triage_status AS "triageStatus",
  flag_reason AS "flagReason", is_pending AS "isPending", is_recurring AS "isRecurring",
  notes, tags, tag_references AS "tagReferences", lifecycle_status AS "lifecycleStatus",
  deleted_at AS "deletedAt", provenance_provider AS "provenanceProvider",
  provenance_fetched_at AS "provenanceFetchedAt", source_fingerprint AS "sourceFingerprint",
  source_url AS "sourceUrl", last_seen_generation_id AS "lastSeenGenerationId",
  first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt", synced_at AS "syncedAt"
`;

const notificationColumns = `
  id, source_id AS "sourceId", connector_type AS "connectorType",
  connector_instance_id AS "connectorInstanceId", title, body, level,
  level_rank AS "levelRank", category, template_key AS "templateKey", state,
  read_state AS "readState", disposition, source_state AS "sourceState",
  sync_state AS "syncState", read_at AS "readAt", handled_at AS "handledAt",
  dismissed_at AS "dismissedAt", resolved_at AS "resolvedAt", archived_at AS "archivedAt",
  muted_at AS "mutedAt", snoozed_until AS "snoozedUntil",
  source_resolved_at AS "sourceResolvedAt",
  last_source_activity_at AS "lastSourceActivityAt",
  last_source_activity_key AS "lastSourceActivityKey",
  handled_source_activity_at AS "handledSourceActivityAt",
  handled_source_activity_key AS "handledSourceActivityKey",
  last_source_synced_at AS "lastSourceSyncedAt", is_actionable AS "isActionable",
  primary_action_id AS "primaryActionId", ai_suggested_action_id AS "aiSuggestedActionId",
  received_at AS "receivedAt", sort_at AS "sortAt", expires_at AS "expiresAt",
  group_key AS "groupKey", dedupe_key AS "dedupeKey", related_task_id AS "relatedTaskId",
  related_project_id AS "relatedProjectId", related_entity_type AS "relatedEntityType",
  related_entity_id AS "relatedEntityId", navigation_target AS "navigationTarget",
  reconcile_attempts AS "reconcileAttempts", last_reconciled_at AS "lastReconciledAt",
  stale_since AS "staleSince", auto_resolve_reason AS "autoResolveReason",
  metadata, presentation, enrichment_revision AS "enrichmentRevision",
  enrichment_generation AS "enrichmentGeneration"
`;

async function query<T extends QueryResultRow>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, [...params])).rows as T[];
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

function throwClaimError(code: string): never {
  const errors: Record<string, [string, number, boolean?]> = {
    transaction_not_found: ['Finance transaction was not found', 404],
    idempotency_conflict: ['Idempotency key was already used', 409],
    transaction_conflict: ['Finance transaction changed after approval', 409],
    category_conflict: ['Finance category changed after approval', 409],
    mutation_in_progress: ['Category update is already in progress', 409, true],
  };
  const [message, status, retryable = false] = errors[code] ?? [code, 409, false];
  throw new FinanceWebPersistenceError(code, message, status, retryable);
}

async function lockCategoryMutations(client: PoolClient, connectorId: string): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`finance-category:${connectorId}`],
  );
}

export function createPostgresFinanceWebPersistence(pool: Pool): FinanceWebPersistence {
  return {
    async listKidsWithSpending(connectorId, monthStart) {
      const rows = await query<{
        id: string;
        name: string;
        color: string;
        avatar: string | null;
        dailyLimit: number | null;
        weeklyLimit: number | null;
        monthlyLimit: number | null;
        currentMonthSpending: number | string;
      }>(pool, `
        SELECT kids.id, kids.name, kids.color, kids.avatar,
               kids.daily_limit AS "dailyLimit", kids.weekly_limit AS "weeklyLimit",
               kids.monthly_limit AS "monthlyLimit",
               COALESCE(SUM(ABS(transactions.amount)), 0) AS "currentMonthSpending"
        FROM kid_profiles kids
        LEFT JOIN finance_transactions transactions
          ON transactions.assigned_kid_id = kids.id
         AND transactions.connector_instance_id = $1
         AND transactions.lifecycle_status = 'active'
         AND transactions.date >= $2
        GROUP BY kids.id, kids.name, kids.color, kids.avatar,
                 kids.daily_limit, kids.weekly_limit, kids.monthly_limit
        ORDER BY kids.id
      `, [connectorId, monthStart]);
      return rows.map((row) => ({
        ...row,
        currentMonthSpending: Number(row.currentMonthSpending),
      }));
    },

    async listTransactions(input) {
      const conditions = [
        'connector_instance_id = $1',
        "lifecycle_status = 'active'",
      ];
      const params: Array<string | number> = [input.connectorId];
      const add = (condition: (index: number) => string, value: string | null) => {
       if (!value) return;
        params.push(value);
        conditions.push(condition(params.length));
      };
      add((index) => `date >= $${index}`, input.startDate);
      add((index) => `date <= $${index}`, input.endDate);
      add((index) => `assigned_kid_id = $${index}`, input.kidId);
      add((index) => `confirmed_category = $${index}`, input.category);
      add((index) => `triage_status = $${index}`, input.triageStatus);
      params.push(input.limit);
      return query<FinanceWebTransaction>(pool, `
        SELECT ${transactionColumns}
        FROM finance_transactions
        WHERE ${conditions.join(' AND ')}
        ORDER BY date DESC, id DESC
        LIMIT $${params.length}
      `, params);
    },

    async readSummary(input) {
      const params = [input.connectorId, input.startDate, input.endDate];
      const [totalRows, byCategoryRows, byKidRows] = await Promise.all([
        query<{ total: number | string; count: number | string }>(pool, `
          SELECT COALESCE(SUM(ABS(amount)), 0) AS total, COUNT(*) AS count
          FROM finance_transactions
          WHERE connector_instance_id = $1 AND lifecycle_status = 'active'
            AND date >= $2 AND date <= $3
        `, params),
        query<{ category: string | null; total: number | string; count: number | string }>(pool, `
          SELECT confirmed_category AS category, COALESCE(SUM(ABS(amount)), 0) AS total,
                 COUNT(*) AS count
          FROM finance_transactions
          WHERE connector_instance_id = $1 AND lifecycle_status = 'active'
            AND date >= $2 AND date <= $3
          GROUP BY confirmed_category
          ORDER BY SUM(ABS(amount)) DESC,
                   confirmed_category IS NOT NULL,
                   confirmed_category
        `, params),
        query<{
          kidId: string;
          kidName: string;
          total: number | string;
          transactionCount: number | string;
        }>(pool, `
          SELECT kids.id AS "kidId", kids.name AS "kidName",
                 COALESCE(SUM(ABS(transactions.amount)), 0) AS total,
                 COUNT(transactions.id) AS "transactionCount"
          FROM kid_profiles kids
          LEFT JOIN finance_transactions transactions
            ON transactions.assigned_kid_id = kids.id
           AND transactions.connector_instance_id = $1
           AND transactions.lifecycle_status = 'active'
           AND transactions.date >= $2 AND transactions.date <= $3
          GROUP BY kids.id, kids.name
          ORDER BY kids.id
        `, params),
      ]);
      const total = totalRows[0] ?? { total: 0, count: 0 };
      return {
        total: Number(total.total),
        transactionCount: Number(total.count),
        byCategory: byCategoryRows.map((row) => ({
          category: row.category,
          total: Number(row.total),
          count: Number(row.count),
        })),
        byKid: byKidRows.map((row) => ({
          kidId: row.kidId,
          kidName: row.kidName,
          total: Number(row.total),
          transactionCount: Number(row.transactionCount),
        })),
      };
    },

    async listNotifications(input) {
      if (!Number.isFinite(input.limit)) {
        throw new Error('Invalid finance notification limit');
      }
      const conditions = ["category = 'finance'"];
      const params: Array<string | number> = [];
      const add = (column: string, value: string | null) => {
       if (!value) return;
        params.push(value);
        conditions.push(`${column} = $${params.length}`);
      };
      add('template_key', input.type);
      add('level', input.level);
      if (input.inboxOnly) {
        conditions.push("disposition = 'inbox'");
        conditions.push("source_state IN ('active', 'unknown')");
        params.push(input.now);
        conditions.push(`(snoozed_until IS NULL OR snoozed_until <= $${params.length})`);
      }
      let limitClause = '';
      if (input.limit >= 0) {
        params.push(input.limit);
        limitClause = `LIMIT $${params.length}`;
      }
      return query<NotificationRow>(pool, `
        SELECT ${notificationColumns}
        FROM notifications
        WHERE ${conditions.join(' AND ')}
        ORDER BY received_at DESC, id DESC
        ${limitClause}
      `, params);
    },

    async dismissNotification(id, dismissedAt) {
      await pool.query(`
        UPDATE notifications
        SET state = 'dismissed', read_state = 'read', disposition = 'dismissed',
            read_at = $1, dismissed_at = $1
        WHERE id = $2 AND category = 'finance'
      `, [dismissedAt, id]);
    },

    async updateDemoCategory(input) {
      const result = await pool.query(`
        UPDATE finance_transactions
        SET confirmed_category = $1, triage_status = 'confirmed'
        WHERE id = $2 AND connector_instance_id = $3 AND lifecycle_status = 'active'
      `, [input.categoryId, input.transactionId, input.connectorId]);
      return (result.rowCount ?? 0) > 0;
    },

    async readOperationsOverview(requestedConnectorId, now = new Date().toISOString()) {
      const connectors = await query<{ id: string; name: string }>(pool, `
        SELECT id, name FROM connector_configs
        WHERE type = ANY($1::text[]) AND enabled = true AND deleted_at IS NULL
        ORDER BY created_at, id
      `, [[...FINANCE_PROVIDER_ALIASES]]);
      if (connectors.length === 0) return null;
      const connector = requestedConnectorId
        ? connectors.find((item) => item.id === requestedConnectorId)
        : connectors[0];
      if (!connector) throw new Error('Finance connector was not found');
      const [
        pendingRows,
        retryRows,
        failedRows,
        alertCountRows,
        alerts,
        subjects,
      ] = await Promise.all([
        query<{ count: number | string }>(pool, `
          SELECT count(*) AS count FROM finance_attribution_exceptions
          WHERE connector_id = $1 AND status = 'open'
        `, [connector.id]),
        query<{ count: number | string }>(pool, `
          SELECT count(*) AS count FROM finance_attribution_exceptions
          WHERE connector_id = $1 AND status = 'retry_requested'
        `, [connector.id]),
        query<{ count: number | string }>(pool, `
          SELECT count(*) AS count FROM finance_mutation_audit
          WHERE connector_id = $1 AND status = 'failed'
        `, [connector.id]),
        query<{ count: number | string }>(pool, `
          SELECT count(*) AS count FROM notifications
          WHERE connector_instance_id = $1 AND category = 'finance'
            AND disposition = 'inbox'
            AND source_state IN ('active', 'unknown')
            AND (snoozed_until IS NULL OR snoozed_until <= $2)
            AND level <> 'digest'
            AND (level IN ('urgent', 'action_needed') OR read_state = 'unread')
            AND level IN ('urgent', 'action_needed', 'heads_up')
        `, [connector.id, now]),
        query<FinanceWebOperationsData['alerts'][number]>(pool, `
          SELECT title, body AS summary, level, received_at AS "receivedAt"
          FROM notifications
          WHERE connector_instance_id = $1 AND category = 'finance'
            AND disposition = 'inbox'
            AND source_state IN ('active', 'unknown')
            AND (snoozed_until IS NULL OR snoozed_until <= $2)
            AND level <> 'digest'
            AND (level IN ('urgent', 'action_needed') OR read_state = 'unread')
            AND level IN ('urgent', 'action_needed', 'heads_up')
          ORDER BY level_rank, sort_at DESC, id DESC
          LIMIT 5
        `, [connector.id, now]),
        query<{ kidId: string; name: string | null }>(pool, `
          SELECT subjects.kid_id AS "kidId", profiles.name
          FROM finance_attribution_subjects subjects
          INNER JOIN finance_sync_state state
            ON state.connector_id = subjects.connector_id
           AND state.attribution_policy_version = subjects.policy_version
          LEFT JOIN kid_profiles profiles ON profiles.id = subjects.kid_id
          WHERE subjects.connector_id = $1
          ORDER BY COALESCE(profiles.name, subjects.kid_id), subjects.kid_id
        `, [connector.id]),
      ]);
      const pendingExceptions = Number(pendingRows[0]?.count ?? 0);
      const retryRequested = Number(retryRows[0]?.count ?? 0);
      const failedWritebacks = Number(failedRows[0]?.count ?? 0);
      const openAlerts = Number(alertCountRows[0]?.count ?? 0);
      return {
        connectors,
        connector,
        attention: {
          total: pendingExceptions + retryRequested + failedWritebacks + openAlerts,
          pendingExceptions,
          retryRequested,
          failedWritebacks,
          openAlerts,
        },
        alerts,
        subjects: subjects.map((subject) => ({
          kidId: subject.kidId,
          name: subject.name || 'Household member',
          policyStatus: 'current' as const,
          limitStatus: 'unavailable' as const,
        })),
        digest: [
          pendingExceptions > 0
            ? `${pendingExceptions} attribution ${pendingExceptions === 1 ? 'exception needs' : 'exceptions need'} review`
            : 'No attribution exceptions need review',
          failedWritebacks > 0
            ? `${failedWritebacks} Monarch ${failedWritebacks === 1 ? 'write-back has' : 'write-backs have'} failed`
            : 'No failed Monarch write-backs',
          openAlerts > 0
            ? `${openAlerts} finance ${openAlerts === 1 ? 'alert is' : 'alerts are'} open`
            : 'No open finance alerts',
        ],
      };
    },

    async claimCategoryUpdate(command) {
      return transaction(pool, async (client) => {
        await lockCategoryMutations(client, command.connectorId);
        const [transactionRow] = await query<{ upstreamTransactionId: string }>(client, `
          SELECT upstream_transaction_id AS "upstreamTransactionId"
          FROM finance_transactions
          WHERE id = $1 AND connector_instance_id = $2 AND lifecycle_status = 'active'
          FOR UPDATE
        `, [command.transactionId, command.connectorId]);
        if (!transactionRow) throwClaimError('transaction_not_found');
        const [existing] = await query<{
          transactionId: string;
          requestedValue: string;
          status: string;
          updatedAt: string;
        }>(client, `
          SELECT transaction_id AS "transactionId", requested_value AS "requestedValue",
                 status, updated_at AS "updatedAt"
          FROM finance_mutation_audit
          WHERE connector_id = $1 AND idempotency_key = $2
          FOR UPDATE
        `, [command.connectorId, command.idempotencyKey]);
        if (existing && (
          existing.transactionId !== command.transactionId
          || existing.requestedValue !== command.categoryId
        )) throwClaimError('idempotency_conflict');
        if (existing?.status === 'succeeded') return { outcome: 'replayed' as const };
        if (command.expectedTransactionVersion) {
          const expected = command.expectedTransactionVersion;
          const [current] = await query<{
            sourceFingerprint: string;
            lastSeenAt: string;
            assignedKidId: string | null;
            confirmedCategory: string | null;
            manualDecidedAt: string | null;
          }>(client, `
            SELECT source_fingerprint AS "sourceFingerprint", last_seen_at AS "lastSeenAt",
                   assigned_kid_id AS "assignedKidId",
                   confirmed_category AS "confirmedCategory",
                   manual_decided_at AS "manualDecidedAt"
            FROM finance_transactions
            WHERE id = $1 AND connector_instance_id = $2 AND lifecycle_status = 'active'
          `, [command.transactionId, command.connectorId]);
          if (
            !current
            || current.sourceFingerprint !== expected.sourceFingerprint
            || current.lastSeenAt !== expected.lastSeenAt
            || current.assignedKidId !== expected.assignedKidId
            || current.confirmedCategory !== expected.confirmedCategory
            || current.manualDecidedAt !== expected.manualDecidedAt
          ) throwClaimError('transaction_conflict');
          const [category] = await query<{ name: string }>(client, `
            SELECT name FROM finance_categories
            WHERE connector_id = $1 AND upstream_category_id = $2
              AND is_active = true AND source_is_active = true
          `, [command.connectorId, command.categoryId]);
          if (!category || category.name !== expected.categoryName) {
            throwClaimError('category_conflict');
          }
        }
        const [competing] = await query<{ present: number }>(client, `
          SELECT 1 AS present FROM finance_mutation_audit
          WHERE connector_id = $1 AND transaction_id = $2
            AND status = 'processing' AND idempotency_key <> $3
          LIMIT 1
        `, [command.connectorId, command.transactionId, command.idempotencyKey]);
        if (competing || (
          existing?.status === 'processing'
          && existing.updatedAt > command.staleBefore
        )) throwClaimError('mutation_in_progress');
        if (existing) {
          await client.query(`
            UPDATE finance_mutation_audit
            SET status = 'processing', attempt_count = attempt_count + 1,
                last_error_code = NULL, last_error_message = NULL, updated_at = $1
            WHERE connector_id = $2 AND idempotency_key = $3
          `, [command.now, command.connectorId, command.idempotencyKey]);
        } else {
          await client.query(`
            INSERT INTO finance_mutation_audit (
              id, idempotency_key, connector_id, transaction_id,
              upstream_transaction_id, operation, requested_value, status,
              attempt_count, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, 'category_update', $6, 'processing', 1, $7, $7)
          `, [
            randomUUID(),
            command.idempotencyKey,
            command.connectorId,
            command.transactionId,
            transactionRow.upstreamTransactionId,
            command.categoryId,
            command.now,
          ]);
        }
        return {
          outcome: 'claimed' as const,
          upstreamTransactionId: transactionRow.upstreamTransactionId,
          claimToken: command.now,
        };
      });
    },

    async completeCategoryUpdate(input) {
      return transaction(pool, async (client) => {
        const completed = await client.query(`
          UPDATE finance_mutation_audit
          SET status = 'succeeded', completed_at = $1, updated_at = $1,
              last_error_code = NULL, last_error_message = NULL
          WHERE connector_id = $2 AND idempotency_key = $3
            AND transaction_id = $4 AND requested_value = $5
            AND status = 'processing' AND updated_at = $6
        `, [
          input.completedAt,
          input.connectorId,
          input.idempotencyKey,
          input.transactionId,
          input.categoryId,
          input.claimToken,
        ]);
        if (completed.rowCount !== 1) return false;
        await client.query(`
          UPDATE finance_transactions
          SET confirmed_category = $1, triage_status = 'confirmed'
          WHERE id = $2 AND connector_instance_id = $3
        `, [input.categoryId, input.transactionId, input.connectorId]);
        return true;
      });
    },

    async failCategoryUpdate(input) {
      const result = await pool.query(`
        UPDATE finance_mutation_audit
        SET status = 'failed', last_error_code = $1, last_error_message = $2, updated_at = $3
        WHERE connector_id = $4 AND idempotency_key = $5
          AND status = 'processing' AND updated_at = $6
      `, [
        input.errorCode,
        input.errorMessage,
        input.failedAt,
        input.connectorId,
        input.idempotencyKey,
        input.claimToken,
      ]);
      return result.rowCount === 1;
    },
  };
}
