import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  FinanceCategoryClaimCommand,
  FinanceWebOperationsData,
  FinanceWebPersistence,
  FinanceWebTransaction,
} from './finance-web';
import { FinanceWebPersistenceError } from './finance-web';
import type { NotificationRow } from './notification-web';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';

const financeTypePlaceholders = FINANCE_PROVIDER_ALIASES.map(() => '?').join(', ');
const notificationCountsTowardAttentionSql = [
  "disposition = 'inbox'",
  "source_state IN ('active', 'unknown')",
  '(snoozed_until IS NULL OR snoozed_until <= ?)',
  "level <> 'digest'",
  "(level IN ('urgent', 'action_needed') OR read_state = 'unread')",
].join(' AND ');

const transactionColumns = `
  id, connector_instance_id AS connectorInstanceId,
  upstream_transaction_id AS upstreamTransactionId, date, amount,
  merchant_name AS merchantName, merchant_logo_url AS merchantLogoUrl,
  category_id AS categoryId, original_category AS originalCategory,
  confirmed_category AS confirmedCategory, account_id AS accountId,
  account_name AS accountName, card_last4 AS cardLast4,
  assigned_kid_id AS assignedKidId, kid_assignment_method AS kidAssignmentMethod,
  manual_decision_action AS manualDecisionAction, manual_decided_at AS manualDecidedAt,
  attribution_source_ref AS attributionSourceRef,
  attribution_contract_version AS attributionContractVersion,
  attribution_status AS attributionStatus,
  attribution_confidence AS attributionConfidence,
  attribution_method AS attributionMethod,
  attribution_explanation AS attributionExplanation,
  attribution_reasons AS attributionReasons,
  attribution_decision_source AS attributionDecisionSource,
  attribution_policy_version AS attributionPolicyVersion,
  attribution_engine_version AS attributionEngineVersion,
  attribution_evaluated_at AS attributionEvaluatedAt,
  attribution_review_state AS attributionReviewState,
  attribution_provenance AS attributionProvenance,
  attribution_last_error_code AS attributionLastErrorCode,
  attribution_retryable AS attributionRetryable,
  attribution_updated_at AS attributionUpdatedAt, triage_status AS triageStatus,
  flag_reason AS flagReason, is_pending AS isPending, is_recurring AS isRecurring,
  notes, tags, tag_references AS tagReferences, lifecycle_status AS lifecycleStatus,
  deleted_at AS deletedAt, provenance_provider AS provenanceProvider,
  provenance_fetched_at AS provenanceFetchedAt, source_fingerprint AS sourceFingerprint,
  source_url AS sourceUrl, last_seen_generation_id AS lastSeenGenerationId,
  first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, synced_at AS syncedAt
`;

const notificationColumns = `
  id, source_id AS sourceId, connector_type AS connectorType,
  connector_instance_id AS connectorInstanceId, title, body, level,
  level_rank AS levelRank, category, template_key AS templateKey, state,
  read_state AS readState, disposition, source_state AS sourceState,
  sync_state AS syncState, read_at AS readAt, handled_at AS handledAt,
  dismissed_at AS dismissedAt, resolved_at AS resolvedAt, archived_at AS archivedAt,
  muted_at AS mutedAt, snoozed_until AS snoozedUntil,
  source_resolved_at AS sourceResolvedAt,
  last_source_activity_at AS lastSourceActivityAt,
  last_source_activity_key AS lastSourceActivityKey,
  handled_source_activity_at AS handledSourceActivityAt,
  handled_source_activity_key AS handledSourceActivityKey,
  last_source_synced_at AS lastSourceSyncedAt, is_actionable AS isActionable,
  primary_action_id AS primaryActionId, ai_suggested_action_id AS aiSuggestedActionId,
  received_at AS receivedAt, sort_at AS sortAt, expires_at AS expiresAt,
  group_key AS groupKey, dedupe_key AS dedupeKey, related_task_id AS relatedTaskId,
  related_project_id AS relatedProjectId, related_entity_type AS relatedEntityType,
  related_entity_id AS relatedEntityId, navigation_target AS navigationTarget,
  reconcile_attempts AS reconcileAttempts, last_reconciled_at AS lastReconciledAt,
  stale_since AS staleSince, auto_resolve_reason AS autoResolveReason,
  metadata, presentation, enrichment_revision AS enrichmentRevision,
  enrichment_generation AS enrichmentGeneration
`;

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}

function normalizeTransaction(row: FinanceWebTransaction): FinanceWebTransaction {
  return {
    ...row,
    attributionReasons: parseJson(row.attributionReasons) as string[],
    attributionRetryable: Boolean(row.attributionRetryable),
    isPending: Boolean(row.isPending),
    isRecurring: Boolean(row.isRecurring),
    tags: parseJson(row.tags),
    tagReferences: parseJson(row.tagReferences) as string[],
  };
}

function normalizeNotification(row: NotificationRow): NotificationRow {
  return {
    ...row,
    isActionable: Boolean(row.isActionable),
    metadata: parseJson(row.metadata),
    presentation: parseJson(row.presentation),
  };
}

function count(
  sqlite: Database.Database,
  statement: string,
  ...params: Array<string | number | null>
): number {
  return Number((sqlite.prepare(statement).get(...params) as { count?: number } | undefined)?.count ?? 0);
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

export function createSqliteFinanceWebPersistence(
  sqlite: Database.Database,
): FinanceWebPersistence {
  return {
    async listKidsWithSpending(connectorId, monthStart) {
      return sqlite.prepare(`
        SELECT kids.id, kids.name, kids.color, kids.avatar,
               kids.daily_limit AS dailyLimit, kids.weekly_limit AS weeklyLimit,
               kids.monthly_limit AS monthlyLimit,
               COALESCE(SUM(ABS(transactions.amount)), 0) AS currentMonthSpending
        FROM kid_profiles kids
        LEFT JOIN finance_transactions transactions
          ON transactions.assigned_kid_id = kids.id
         AND transactions.connector_instance_id = ?
         AND transactions.lifecycle_status = 'active'
         AND transactions.date >= ?
        GROUP BY kids.id, kids.name, kids.color, kids.avatar,
                 kids.daily_limit, kids.weekly_limit, kids.monthly_limit
        ORDER BY kids.id
      `).all(connectorId, monthStart) as Awaited<
        ReturnType<FinanceWebPersistence['listKidsWithSpending']>
      >;
    },

    async listTransactions(input) {
      const conditions = [
        'connector_instance_id = ?',
        "lifecycle_status = 'active'",
      ];
      const params: Array<string | number> = [input.connectorId];
      if (input.startDate) {
        conditions.push('date >= ?');
        params.push(input.startDate);
      }
      if (input.endDate) {
        conditions.push('date <= ?');
        params.push(input.endDate);
      }
      if (input.kidId) {
        conditions.push('assigned_kid_id = ?');
        params.push(input.kidId);
      }
      if (input.category) {
        conditions.push('confirmed_category = ?');
        params.push(input.category);
      }
      if (input.triageStatus) {
        conditions.push('triage_status = ?');
        params.push(input.triageStatus);
      }
      const rows = sqlite.prepare(`
        SELECT ${transactionColumns}
        FROM finance_transactions
        WHERE ${conditions.join(' AND ')}
        ORDER BY date DESC, id DESC
        LIMIT ?
      `).all(...params, input.limit) as FinanceWebTransaction[];
      return rows.map(normalizeTransaction);
    },

    async readSummary(input) {
      const params = [input.connectorId, input.startDate, input.endDate];
      const total = sqlite.prepare(`
        SELECT COALESCE(SUM(ABS(amount)), 0) AS total, COUNT(*) AS count
        FROM finance_transactions
        WHERE connector_instance_id = ? AND lifecycle_status = 'active'
          AND date >= ? AND date <= ?
      `).get(...params) as { total: number; count: number };
      const byCategory = sqlite.prepare(`
        SELECT confirmed_category AS category, COALESCE(SUM(ABS(amount)), 0) AS total,
               COUNT(*) AS count
        FROM finance_transactions
        WHERE connector_instance_id = ? AND lifecycle_status = 'active'
          AND date >= ? AND date <= ?
        GROUP BY confirmed_category
        ORDER BY SUM(ABS(amount)) DESC,
                 confirmed_category IS NOT NULL,
                 confirmed_category
      `).all(...params) as Array<{ category: string | null; total: number; count: number }>;
      const byKid = sqlite.prepare(`
        SELECT kids.id AS kidId, kids.name AS kidName,
               COALESCE(SUM(ABS(transactions.amount)), 0) AS total,
               COUNT(transactions.id) AS transactionCount
        FROM kid_profiles kids
        LEFT JOIN finance_transactions transactions
          ON transactions.assigned_kid_id = kids.id
         AND transactions.connector_instance_id = ?
         AND transactions.lifecycle_status = 'active'
         AND transactions.date >= ? AND transactions.date <= ?
        GROUP BY kids.id, kids.name
        ORDER BY kids.id
      `).all(...params) as Array<{
        kidId: string;
        kidName: string;
        total: number;
        transactionCount: number;
      }>;
      return {
        total: Number(total.total),
        transactionCount: Number(total.count),
        byCategory: byCategory.map((row) => ({
          ...row,
          total: Number(row.total),
          count: Number(row.count),
        })),
        byKid: byKid.map((row) => ({
          ...row,
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
      if (input.type) {
        conditions.push('template_key = ?');
        params.push(input.type);
      }
      if (input.level) {
        conditions.push('level = ?');
        params.push(input.level);
      }
      if (input.inboxOnly) {
        conditions.push("disposition = 'inbox'");
        conditions.push("source_state IN ('active', 'unknown')");
        conditions.push('(snoozed_until IS NULL OR snoozed_until <= ?)');
        params.push(input.now);
      }
      const rows = sqlite.prepare(`
        SELECT ${notificationColumns}
        FROM notifications
        WHERE ${conditions.join(' AND ')}
        ORDER BY received_at DESC, id DESC
        LIMIT ?
      `).all(...params, input.limit) as NotificationRow[];
      return rows.map(normalizeNotification);
    },

    async dismissNotification(id, dismissedAt) {
      sqlite.prepare(`
        UPDATE notifications
        SET state = 'dismissed', read_state = 'read', disposition = 'dismissed',
            read_at = ?, dismissed_at = ?
        WHERE id = ? AND category = 'finance'
      `).run(dismissedAt, dismissedAt, id);
    },

    async updateDemoCategory(input) {
      const result = sqlite.prepare(`
        UPDATE finance_transactions
        SET confirmed_category = ?, triage_status = 'confirmed'
        WHERE id = ? AND connector_instance_id = ? AND lifecycle_status = 'active'
      `).run(input.categoryId, input.transactionId, input.connectorId);
      return result.changes > 0;
    },

    async readOperationsOverview(requestedConnectorId, now = new Date().toISOString()) {
      const connectors = sqlite.prepare(`
        SELECT id, name FROM connector_configs
        WHERE type IN (${financeTypePlaceholders})
          AND enabled = 1 AND deleted_at IS NULL
        ORDER BY created_at, id
      `).all(...FINANCE_PROVIDER_ALIASES) as Array<{ id: string; name: string }>;
      if (connectors.length === 0) return null;
      const connector = requestedConnectorId
        ? connectors.find((item) => item.id === requestedConnectorId)
        : connectors[0];
      if (!connector) throw new Error('Finance connector was not found');
      const pendingExceptions = count(sqlite, `
        SELECT count(*) AS count FROM finance_attribution_exceptions
        WHERE connector_id = ? AND status = 'open'
      `, connector.id);
      const retryRequested = count(sqlite, `
        SELECT count(*) AS count FROM finance_attribution_exceptions
        WHERE connector_id = ? AND status = 'retry_requested'
      `, connector.id);
      const failedWritebacks = count(sqlite, `
        SELECT count(*) AS count FROM finance_mutation_audit
        WHERE connector_id = ? AND status = 'failed'
      `, connector.id);
      const openAlerts = count(sqlite, `
        SELECT count(*) AS count FROM notifications
        WHERE connector_instance_id = ? AND category = 'finance'
          AND ${notificationCountsTowardAttentionSql}
          AND level IN ('urgent', 'action_needed', 'heads_up')
      `, connector.id, now);
      const alerts = sqlite.prepare(`
        SELECT title, body AS summary, level, received_at AS receivedAt
        FROM notifications
        WHERE connector_instance_id = ? AND category = 'finance'
          AND ${notificationCountsTowardAttentionSql}
          AND level IN ('urgent', 'action_needed', 'heads_up')
        ORDER BY level_rank, sort_at DESC, id DESC
        LIMIT 5
      `).all(connector.id, now) as FinanceWebOperationsData['alerts'];
      const subjects = sqlite.prepare(`
        SELECT subjects.kid_id AS kidId, profiles.name
        FROM finance_attribution_subjects subjects
        INNER JOIN finance_sync_state state
          ON state.connector_id = subjects.connector_id
         AND state.attribution_policy_version = subjects.policy_version
        LEFT JOIN kid_profiles profiles ON profiles.id = subjects.kid_id
        WHERE subjects.connector_id = ?
        ORDER BY COALESCE(profiles.name, subjects.kid_id), subjects.kid_id
      `).all(connector.id) as Array<{ kidId: string; name: string | null }>;
      const attention = pendingExceptions + retryRequested + failedWritebacks + openAlerts;
      return {
        connectors,
        connector,
        attention: {
          total: attention,
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
      return sqlite.transaction(() => {
        const transaction = sqlite.prepare(`
          SELECT upstream_transaction_id AS upstreamTransactionId
          FROM finance_transactions
          WHERE id = ? AND connector_instance_id = ? AND lifecycle_status = 'active'
        `).get(command.transactionId, command.connectorId) as
          | { upstreamTransactionId: string }
          | undefined;
        if (!transaction) throwClaimError('transaction_not_found');
        const existing = sqlite.prepare(`
          SELECT transaction_id AS transactionId, requested_value AS requestedValue,
                 status, updated_at AS updatedAt
          FROM finance_mutation_audit
          WHERE connector_id = ? AND idempotency_key = ?
        `).get(command.connectorId, command.idempotencyKey) as
          | {
              transactionId: string;
              requestedValue: string;
              status: string;
              updatedAt: string;
            }
          | undefined;
        if (existing && (
          existing.transactionId !== command.transactionId
          || existing.requestedValue !== command.categoryId
        )) throwClaimError('idempotency_conflict');
        if (existing?.status === 'succeeded') return { outcome: 'replayed' as const };
        if (command.expectedTransactionVersion) {
          const expected = command.expectedTransactionVersion;
          const current = sqlite.prepare(`
            SELECT source_fingerprint AS sourceFingerprint, last_seen_at AS lastSeenAt,
                   assigned_kid_id AS assignedKidId, confirmed_category AS confirmedCategory,
                   manual_decided_at AS manualDecidedAt
            FROM finance_transactions
            WHERE id = ? AND connector_instance_id = ? AND lifecycle_status = 'active'
          `).get(command.transactionId, command.connectorId) as {
            sourceFingerprint: string;
            lastSeenAt: string;
            assignedKidId: string | null;
            confirmedCategory: string | null;
            manualDecidedAt: string | null;
          } | undefined;
          if (
            !current
            || current.sourceFingerprint !== expected.sourceFingerprint
            || current.lastSeenAt !== expected.lastSeenAt
            || current.assignedKidId !== expected.assignedKidId
            || current.confirmedCategory !== expected.confirmedCategory
            || current.manualDecidedAt !== expected.manualDecidedAt
          ) throwClaimError('transaction_conflict');
          const category = sqlite.prepare(`
            SELECT name FROM finance_categories
            WHERE connector_id = ? AND upstream_category_id = ?
              AND is_active = 1 AND source_is_active = 1
          `).get(command.connectorId, command.categoryId) as { name: string } | undefined;
          if (!category || category.name !== expected.categoryName) {
            throwClaimError('category_conflict');
          }
        }
        const competing = sqlite.prepare(`
          SELECT 1 FROM finance_mutation_audit
          WHERE connector_id = ? AND transaction_id = ?
            AND status = 'processing' AND idempotency_key <> ?
          LIMIT 1
        `).get(command.connectorId, command.transactionId, command.idempotencyKey);
        if (competing || (
          existing?.status === 'processing'
          && existing.updatedAt > command.staleBefore
        )) throwClaimError('mutation_in_progress');
        if (existing) {
          sqlite.prepare(`
            UPDATE finance_mutation_audit
            SET status = 'processing', attempt_count = attempt_count + 1,
                last_error_code = NULL, last_error_message = NULL, updated_at = ?
            WHERE connector_id = ? AND idempotency_key = ?
          `).run(command.now, command.connectorId, command.idempotencyKey);
        } else {
          sqlite.prepare(`
            INSERT INTO finance_mutation_audit (
              id, idempotency_key, connector_id, transaction_id,
              upstream_transaction_id, operation, requested_value, status,
              attempt_count, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'category_update', ?, 'processing', 1, ?, ?)
          `).run(
            randomUUID(),
            command.idempotencyKey,
            command.connectorId,
            command.transactionId,
            transaction.upstreamTransactionId,
            command.categoryId,
            command.now,
            command.now,
          );
        }
        return {
          outcome: 'claimed' as const,
          upstreamTransactionId: transaction.upstreamTransactionId,
          claimToken: command.now,
        };
      }).immediate();
    },

    async completeCategoryUpdate(input) {
      return sqlite.transaction(() => {
        const completed = sqlite.prepare(`
          UPDATE finance_mutation_audit
          SET status = 'succeeded', completed_at = ?, updated_at = ?,
              last_error_code = NULL, last_error_message = NULL
          WHERE connector_id = ? AND idempotency_key = ?
            AND transaction_id = ? AND requested_value = ?
            AND status = 'processing' AND updated_at = ?
        `).run(
          input.completedAt,
          input.completedAt,
          input.connectorId,
          input.idempotencyKey,
          input.transactionId,
          input.categoryId,
          input.claimToken,
        );
        if (completed.changes !== 1) return false;
        sqlite.prepare(`
          UPDATE finance_transactions
          SET confirmed_category = ?, triage_status = 'confirmed'
          WHERE id = ? AND connector_instance_id = ?
        `).run(input.categoryId, input.transactionId, input.connectorId);
        return true;
      }).immediate();
    },

    async failCategoryUpdate(input) {
      const result = sqlite.prepare(`
        UPDATE finance_mutation_audit
        SET status = 'failed', last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE connector_id = ? AND idempotency_key = ?
          AND status = 'processing' AND updated_at = ?
      `).run(
        input.errorCode,
        input.errorMessage,
        input.failedAt,
        input.connectorId,
        input.idempotencyKey,
        input.claimToken,
      );
      return result.changes === 1;
    },
  };
}
