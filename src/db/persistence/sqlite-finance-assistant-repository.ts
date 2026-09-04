import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConnectorConfig } from '@/types';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';
import {
  boundedAssistantLimit,
  FINANCE_ASSISTANT_AMBIGUITY_LIMIT,
  FINANCE_ASSISTANT_CONNECTOR_LIMIT,
  FINANCE_ASSISTANT_EXCEPTION_LIMIT_MAX,
  FINANCE_ASSISTANT_MUTATION_CLAIM_STALE_MS,
  FINANCE_ASSISTANT_MUTATION_TARGET_LIMIT,
  FINANCE_ASSISTANT_OBLIGATION_LIMIT_MAX,
  FINANCE_ASSISTANT_REPLAY_LIMIT,
  FINANCE_ASSISTANT_SUMMARY_GROUP_LIMIT,
  FINANCE_ASSISTANT_TRANSACTION_LIMIT_MAX,
  type FinanceAssistantCategoryClaimResult,
  type FinanceAssistantException,
  type FinanceAssistantKid,
  type FinanceAssistantKidAssignmentResult,
  type FinanceAssistantObligation,
  type FinanceAssistantPersistence,
  type FinanceAssistantProjectedCategory,
  type FinanceAssistantProjectedKid,
  type FinanceAssistantProjectionState,
  type FinanceAssistantTransaction,
} from './finance-assistant';

type SqliteDatabase = Database.Database;

interface SqliteFinanceAssistantOptions {
  idFactory?: () => string;
}

const PROVIDER_PLACEHOLDERS = FINANCE_PROVIDER_ALIASES.map(() => '?').join(', ');

const TRANSACTION_COLUMNS = `
  t.id, t.connector_instance_id AS connectorId,
  t.date, t.amount, t.merchant_name AS merchant,
  COALESCE(categories.name, t.confirmed_category, t.original_category) AS category,
  t.confirmed_category AS confirmedCategory,
  t.is_pending AS pending, t.is_recurring AS recurring,
  profiles.name AS kidName, t.attribution_status AS attributionStatus,
  t.attribution_confidence AS confidence, t.attribution_method AS method,
  t.assigned_kid_id AS assignedKidId,
  t.source_fingerprint AS sourceFingerprint, t.last_seen_at AS lastSeenAt,
  t.manual_decided_at AS manualDecidedAt
`;

const TRANSACTION_SOURCE = `
  FROM finance_transactions t
  LEFT JOIN kid_profiles profiles ON profiles.id = t.assigned_kid_id
  LEFT JOIN finance_categories categories
    ON categories.connector_id = t.connector_instance_id
    AND categories.upstream_category_id = t.confirmed_category
`;

type TransactionRow = Omit<FinanceAssistantTransaction, 'pending' | 'recurring'> & {
  pending: number;
  recurring: number;
};

function toTransaction(row: TransactionRow): FinanceAssistantTransaction {
  return { ...row, pending: row.pending === 1, recurring: row.recurring === 1 };
}

/** Escapes LIKE wildcards so a merchant substring stays a literal match. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function jsonRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function jsonStringArray(value: string | null): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * SQLite implementation of the Houston finance-assistant port. Integer flags
 * and JSON text columns are normalized to the same domain booleans, objects,
 * and arrays the PostgreSQL adapter returns from native booleans and JSONB.
 */
export function createSqliteFinanceAssistantPersistence(
  sqlite: SqliteDatabase,
  options: SqliteFinanceAssistantOptions = {},
): FinanceAssistantPersistence {
  const idFactory = options.idFactory ?? randomUUID;

  function readTransactionVersion(connectorId: string, transactionId: string) {
    return sqlite.prepare(`
      SELECT source_fingerprint AS sourceFingerprint,
             last_seen_at AS lastSeenAt, assigned_kid_id AS assignedKidId,
             confirmed_category AS confirmedCategory,
             manual_decided_at AS manualDecidedAt
      FROM finance_transactions
      WHERE id = ? AND connector_instance_id = ? AND lifecycle_status = 'active'
    `).get(transactionId, connectorId) as {
      sourceFingerprint: string;
      lastSeenAt: string;
      assignedKidId: string | null;
      confirmedCategory: string | null;
      manualDecidedAt: string | null;
    } | undefined;
  }

  return {
    async listEnabledConnectors() {
      return sqlite.prepare(`
        SELECT id, poll_interval_minutes AS pollIntervalMinutes
        FROM connector_configs
        WHERE type IN (${PROVIDER_PLACEHOLDERS})
          AND enabled = 1 AND deleted_at IS NULL
        ORDER BY created_at, id
        LIMIT ?
      `).all(...FINANCE_PROVIDER_ALIASES, FINANCE_ASSISTANT_CONNECTOR_LIMIT) as Array<{
        id: string;
        pollIntervalMinutes: number | null;
      }>;
    },

    async readConnectorConfig(connectorId) {
      const row = sqlite.prepare(`
        SELECT id, type, name, enabled, sync_mode AS syncMode,
               poll_interval_minutes AS pollIntervalMinutes, capabilities,
               credentials, settings, synced_lists AS syncedLists
        FROM connector_configs
        WHERE id = ? AND enabled = 1 AND deleted_at IS NULL
      `).get(connectorId) as {
        id: string;
        type: string;
        name: string;
        enabled: number;
        syncMode: string;
        pollIntervalMinutes: number | null;
        capabilities: string | null;
        credentials: string | null;
        settings: string | null;
        syncedLists: string | null;
      } | undefined;
      if (!row) return null;
      const capabilities = jsonRecord(row.capabilities);
      const capability = (name: string) => capabilities[name] === true;
      return {
        id: row.id,
        type: row.type,
        name: row.name,
        enabled: row.enabled === 1,
        syncMode: row.syncMode as ConnectorConfig['syncMode'],
        pollIntervalMinutes: row.pollIntervalMinutes ?? undefined,
        capabilities: {
          read: capability('read'),
          write: capability('write'),
          delete: capability('delete'),
          sync: capability('sync'),
          subtasks: capability('subtasks'),
          lists: capability('lists'),
          tags: capability('tags'),
          tagWriteBack: capability('tagWriteBack'),
        },
        credentials: jsonRecord(row.credentials) as ConnectorConfig['credentials'],
        settings: jsonRecord(row.settings),
        syncedLists: jsonStringArray(row.syncedLists),
      };
    },

    async readProjectionState(connectorId) {
      const row = sqlite.prepare(`
        SELECT last_successful_source_as_of AS sourceAsOf,
               last_successful_projection_coverage_start AS coverageStart,
               last_successful_projection_coverage_end AS coverageEnd,
               last_successful_sync_at AS lastSuccessfulSyncAt,
               status, last_error_code AS lastErrorCode,
               attribution_status AS attributionStatus,
               attribution_last_successful_at AS attributionLastSuccessfulAt
        FROM finance_sync_state
        WHERE connector_id = ?
      `).get(connectorId) as FinanceAssistantProjectionState | undefined;
      return row ?? null;
    },

    async searchTransactions(query) {
      const limit = boundedAssistantLimit(query.limit, FINANCE_ASSISTANT_TRANSACTION_LIMIT_MAX);
      const conditions = [
        't.connector_instance_id = ?',
        `t.lifecycle_status = 'active'`,
        't.date >= ?',
        't.date <= ?',
      ];
      const parameters: Array<string | number> = [
        query.connectorId,
        query.startDate,
        query.endDate,
      ];
      if (query.merchantQuery) {
        conditions.push(`lower(COALESCE(t.merchant_name, '')) LIKE ? ESCAPE '\\'`);
        parameters.push(`%${escapeLikePattern(query.merchantQuery.toLowerCase())}%`);
      }
      if (query.categoryName) {
        conditions.push(
          'lower(COALESCE(categories.name, t.confirmed_category, t.original_category, ?)) = lower(?)',
        );
        parameters.push('', query.categoryName);
      }
      if (query.kidId) {
        conditions.push('t.assigned_kid_id = ?');
        parameters.push(query.kidId);
      }
      if (query.triageStatus) {
        conditions.push('t.triage_status = ?');
        parameters.push(query.triageStatus);
      }
      parameters.push(limit + 1);
      const rows = sqlite.prepare(`
        SELECT ${TRANSACTION_COLUMNS}
        ${TRANSACTION_SOURCE}
        WHERE ${conditions.join(' AND ')}
        ORDER BY t.date DESC, t.id DESC
        LIMIT ?
      `).all(...parameters) as TransactionRow[];
      return {
        transactions: rows.slice(0, limit).map(toTransaction),
        truncated: rows.length > limit,
      };
    },

    async readSpendingSummary({ connectorId, startDate, endDate }) {
      const total = sqlite.prepare(`
        SELECT COALESCE(SUM(ABS(amount)), 0) AS amount, COUNT(*) AS transactionCount
        FROM finance_transactions
        WHERE connector_instance_id = ? AND lifecycle_status = 'active'
          AND date >= ? AND date <= ?
      `).get(connectorId, startDate, endDate) as {
        amount: number;
        transactionCount: number;
      };
      const byCategory = sqlite.prepare(`
        SELECT COALESCE(categories.name, transactions.confirmed_category,
                        transactions.original_category, 'Uncategorized') AS category,
               COALESCE(SUM(ABS(transactions.amount)), 0) AS amount,
               COUNT(*) AS transactionCount
        FROM finance_transactions transactions
        LEFT JOIN finance_categories categories
          ON categories.connector_id = transactions.connector_instance_id
          AND categories.upstream_category_id = transactions.confirmed_category
        WHERE transactions.connector_instance_id = ?
          AND transactions.lifecycle_status = 'active'
          AND transactions.date >= ? AND transactions.date <= ?
        GROUP BY COALESCE(categories.name, transactions.confirmed_category,
                          transactions.original_category, 'Uncategorized')
        ORDER BY amount DESC, category
        LIMIT ?
      `).all(connectorId, startDate, endDate, FINANCE_ASSISTANT_SUMMARY_GROUP_LIMIT) as Array<{
        category: string;
        amount: number;
        transactionCount: number;
      }>;
      const byKid = sqlite.prepare(`
        SELECT profiles.name AS kidName, COALESCE(SUM(ABS(t.amount)), 0) AS amount,
               COUNT(*) AS transactionCount
        FROM finance_transactions t
        INNER JOIN kid_profiles profiles ON profiles.id = t.assigned_kid_id
        WHERE t.connector_instance_id = ? AND t.lifecycle_status = 'active'
          AND t.date >= ? AND t.date <= ?
        GROUP BY profiles.id, profiles.name
        ORDER BY amount DESC, profiles.name
        LIMIT ?
      `).all(connectorId, startDate, endDate, FINANCE_ASSISTANT_SUMMARY_GROUP_LIMIT) as Array<{
        kidName: string;
        amount: number;
        transactionCount: number;
      }>;
      return {
        totalAmount: total.amount,
        transactionCount: total.transactionCount,
        byCategory,
        byKid,
      };
    },

    async readKidSpendingTotal({ connectorId, kidId, startDate, endDate }) {
      const row = sqlite.prepare(`
        SELECT COALESCE(SUM(ABS(amount)), 0) AS amount, COUNT(*) AS transactionCount
        FROM finance_transactions
        WHERE connector_instance_id = ? AND lifecycle_status = 'active'
          AND assigned_kid_id = ? AND date >= ? AND date <= ?
      `).get(connectorId, kidId, startDate, endDate) as {
        amount: number;
        transactionCount: number;
      };
      return { totalAmount: row.amount, transactionCount: row.transactionCount };
    },

    async listAttributionExceptions({ connectorId, limit }) {
      const bounded = boundedAssistantLimit(limit, FINANCE_ASSISTANT_EXCEPTION_LIMIT_MAX);
      const rows = sqlite.prepare(`
        SELECT t.date, t.merchant_name AS merchantName,
               e.reason_code AS reasonCode, e.retryable,
               t.assigned_kid_id AS assignedKidId,
               t.attribution_confidence AS confidence,
               e.last_observed_at AS lastObservedAt
        FROM finance_attribution_exceptions e
        INNER JOIN finance_transactions t
          ON t.id = e.transaction_id
          AND t.connector_instance_id = e.connector_id
        WHERE e.connector_id = ? AND e.status IN ('open', 'retry_requested')
        ORDER BY e.updated_at DESC, e.id DESC
        LIMIT ?
      `).all(connectorId, bounded + 1) as Array<
        Omit<FinanceAssistantException, 'retryable'> & { retryable: number }
      >;
      const subjects = sqlite.prepare(`
        SELECT subjects.kid_id AS kidId,
               COALESCE(NULLIF(profiles.name, ''), 'Household member') AS name
        FROM finance_attribution_subjects subjects
        INNER JOIN finance_sync_state state
          ON state.connector_id = subjects.connector_id
          AND state.attribution_policy_version = subjects.policy_version
        LEFT JOIN kid_profiles profiles ON profiles.id = subjects.kid_id
        WHERE subjects.connector_id = ?
        ORDER BY name, subjects.kid_id
      `).all(connectorId) as Array<{ kidId: string; name: string }>;
      return {
        exceptions: rows.slice(0, bounded).map((row) => ({
          ...row,
          retryable: row.retryable === 1,
        })),
        truncated: rows.length > bounded,
        subjects,
      };
    },

    async listRecurringObligations({ connectorId, horizonStart, horizonEnd, limit }) {
      const bounded = boundedAssistantLimit(limit, FINANCE_ASSISTANT_OBLIGATION_LIMIT_MAX);
      const rows = sqlite.prepare(`
        SELECT merchant, amount, frequency, next_expected_date AS nextExpectedDate,
               category_name AS category
        FROM finance_recurring_obligations
        WHERE connector_id = ? AND is_current = 1
          AND next_expected_date >= ? AND next_expected_date <= ?
        ORDER BY next_expected_date, merchant
        LIMIT ?
      `).all(connectorId, horizonStart, horizonEnd, bounded + 1) as FinanceAssistantObligation[];
      const aggregate = sqlite.prepare(`
        SELECT COALESCE(SUM(ABS(amount) * CASE lower(frequency)
          WHEN 'weekly' THEN 52.0 / 12.0
          WHEN 'biweekly' THEN 26.0 / 12.0
          WHEN 'every two weeks' THEN 26.0 / 12.0
          WHEN 'quarterly' THEN 1.0 / 3.0
          WHEN 'annual' THEN 1.0 / 12.0
          WHEN 'annually' THEN 1.0 / 12.0
          WHEN 'yearly' THEN 1.0 / 12.0
          ELSE 1.0
        END), 0) AS estimatedMonthlyAmount
        FROM finance_recurring_obligations
        WHERE connector_id = ? AND is_current = 1
          AND next_expected_date >= ? AND next_expected_date <= ?
      `).get(connectorId, horizonStart, horizonEnd) as { estimatedMonthlyAmount: number };
      return {
        obligations: rows.slice(0, bounded),
        truncated: rows.length > bounded,
        estimatedMonthlyAmount: aggregate.estimatedMonthlyAmount,
      };
    },

    async matchKidsByName(name) {
      return sqlite.prepare(`
        SELECT id, name, daily_limit AS dailyLimit, weekly_limit AS weeklyLimit,
               monthly_limit AS monthlyLimit
        FROM kid_profiles
        WHERE lower(name) = lower(?)
        ORDER BY id
        LIMIT ?
      `).all(name, FINANCE_ASSISTANT_AMBIGUITY_LIMIT) as FinanceAssistantKid[];
    },

    async matchProjectedKidsByName({ connectorId, name }) {
      return sqlite.prepare(`
        SELECT profiles.id, profiles.name
        FROM kid_profiles profiles
        INNER JOIN finance_attribution_subjects subjects
          ON subjects.kid_id = profiles.id AND subjects.connector_id = ?
        INNER JOIN finance_sync_state state
          ON state.connector_id = subjects.connector_id
          AND state.attribution_policy_version = subjects.policy_version
        WHERE lower(profiles.name) = lower(?)
        ORDER BY profiles.id
        LIMIT ?
      `).all(connectorId, name, FINANCE_ASSISTANT_AMBIGUITY_LIMIT) as FinanceAssistantProjectedKid[];
    },

    async matchProjectedCategoriesByName({ connectorId, name }) {
      return sqlite.prepare(`
        SELECT upstream_category_id AS upstreamCategoryId, name
        FROM finance_categories
        WHERE connector_id = ? AND is_active = 1 AND source_is_active = 1
          AND lower(name) = lower(?)
        ORDER BY upstream_category_id
        LIMIT ?
      `).all(
        connectorId,
        name,
        FINANCE_ASSISTANT_AMBIGUITY_LIMIT,
      ) as FinanceAssistantProjectedCategory[];
    },

    async findApprovedMutationTargets({ connectorId, date, amount }) {
      const rows = sqlite.prepare(`
        SELECT ${TRANSACTION_COLUMNS}
        ${TRANSACTION_SOURCE}
        WHERE t.connector_instance_id = ? AND t.lifecycle_status = 'active'
          AND t.date = ? AND t.amount = ?
        ORDER BY t.id
        LIMIT ?
      `).all(
        connectorId,
        date,
        amount,
        FINANCE_ASSISTANT_MUTATION_TARGET_LIMIT,
      ) as TransactionRow[];
      return rows.map(toTransaction);
    },

    async findReplayedKidAssignments(idempotencyKey) {
      return sqlite.prepare(`
        SELECT profiles.name AS kidName
        FROM finance_attribution_audit audit
        LEFT JOIN kid_profiles profiles ON profiles.id = audit.requested_kid_id
        WHERE audit.idempotency_key = ? AND audit.result_status = 'resolved'
        LIMIT ?
      `).all(idempotencyKey, FINANCE_ASSISTANT_REPLAY_LIMIT) as Array<{
        kidName: string | null;
      }>;
    },

    async findReplayedCategoryUpdates(idempotencyKey) {
      return sqlite.prepare(`
        SELECT categories.name AS categoryName
        FROM finance_mutation_audit audit
        LEFT JOIN finance_categories categories
          ON categories.connector_id = audit.connector_id
          AND categories.upstream_category_id = audit.requested_value
        WHERE audit.idempotency_key = ? AND audit.status = 'succeeded'
        LIMIT ?
      `).all(idempotencyKey, FINANCE_ASSISTANT_REPLAY_LIMIT) as Array<{
        categoryName: string | null;
      }>;
    },

    async applyManualKidAssignment(command) {
      const audit = sqlite.prepare(`
        SELECT transaction_id AS transactionId, requested_kid_id AS requestedKidId,
               requested_decision AS requestedDecision, action
        FROM finance_attribution_audit
        WHERE connector_id = ? AND idempotency_key = ?
      `).get(command.connectorId, command.idempotencyKey) as {
        transactionId: string;
        requestedKidId: string | null;
        requestedDecision: string | null;
        action: string;
      } | undefined;
      if (audit) {
        return audit.transactionId === command.transactionId
          && audit.requestedKidId === command.kidId
          && audit.requestedDecision === 'assign-kid'
          && audit.action === 'manual-resolve'
          ? { status: 'replayed' }
          : { status: 'idempotency-conflict' };
      }
      const connector = sqlite.prepare(`
        SELECT 1 FROM connector_configs
        WHERE id = ? AND type IN (${PROVIDER_PLACEHOLDERS})
          AND enabled = 1 AND deleted_at IS NULL
      `).get(command.connectorId, ...FINANCE_PROVIDER_ALIASES);
      if (!connector) return { status: 'connector-not-found' };

      return sqlite.transaction((): FinanceAssistantKidAssignmentResult => {
        const concurrent = sqlite.prepare(`
          SELECT transaction_id AS transactionId, requested_kid_id AS requestedKidId,
                 requested_decision AS requestedDecision, action
          FROM finance_attribution_audit
          WHERE connector_id = ? AND idempotency_key = ?
        `).get(command.connectorId, command.idempotencyKey) as {
          transactionId: string;
          requestedKidId: string | null;
          requestedDecision: string | null;
          action: string;
        } | undefined;
        if (concurrent) {
          return concurrent.transactionId === command.transactionId
            && concurrent.requestedKidId === command.kidId
            && concurrent.requestedDecision === 'assign-kid'
            && concurrent.action === 'manual-resolve'
            ? { status: 'replayed' }
            : { status: 'idempotency-conflict' };
        }
        const current = readTransactionVersion(command.connectorId, command.transactionId);
        if (!current) return { status: 'transaction-not-found' };
        const expected = command.expectedVersion;
        if (
          current.sourceFingerprint !== expected.sourceFingerprint
          || current.lastSeenAt !== expected.lastSeenAt
          || current.assignedKidId !== expected.assignedKidId
          || current.confirmedCategory !== expected.confirmedCategory
          || current.manualDecidedAt !== expected.manualDecidedAt
        ) {
          return { status: 'transaction-conflict' };
        }
        const projected = sqlite.prepare(`
          SELECT 1
          FROM finance_attribution_subjects subjects
          INNER JOIN finance_sync_state state
            ON state.connector_id = subjects.connector_id
            AND state.attribution_policy_version = subjects.policy_version
          WHERE subjects.connector_id = ? AND subjects.kid_id = ?
        `).get(command.connectorId, command.kidId);
        if (!projected) return { status: 'unknown-attribution-subject' };

        sqlite.prepare(`
          UPDATE finance_transactions
          SET assigned_kid_id = ?, kid_assignment_method = 'manual',
              manual_decision_action = 'assign-kid', manual_decided_at = ?,
              attribution_status = 'attributed', attribution_confidence = 'definite',
              attribution_method = 'manual',
              attribution_explanation = 'Confirmed by parent administrator',
              attribution_reasons = '[]', attribution_decision_source = 'manual',
              attribution_evaluated_at = ?, attribution_review_state = 'resolved',
              attribution_provenance = 'mission-control-manual-v1',
              attribution_last_error_code = NULL, attribution_retryable = 0,
              attribution_updated_at = ?, triage_status = 'confirmed'
          WHERE id = ? AND connector_instance_id = ?
        `).run(
          command.kidId,
          command.decidedAt,
          command.decidedAt,
          command.decidedAt,
          command.transactionId,
          command.connectorId,
        );
        sqlite.prepare(`
          UPDATE finance_attribution_exceptions
          SET status = 'resolved', review_state = 'resolved',
              resolution = 'manual', resolved_at = ?, updated_at = ?
          WHERE connector_id = ? AND transaction_id = ?
        `).run(
          command.decidedAt,
          command.decidedAt,
          command.connectorId,
          command.transactionId,
        );
        sqlite.prepare(`
          INSERT INTO finance_attribution_audit (
            id, connector_id, transaction_id, exception_id, idempotency_key,
            action, actor_type, requested_kid_id, requested_decision,
            result_status, created_at
          ) VALUES (?, ?, ?, NULL, ?, 'manual-resolve', ?, ?, 'assign-kid', 'resolved', ?)
        `).run(
          idFactory(),
          command.connectorId,
          command.transactionId,
          command.idempotencyKey,
          command.actorType,
          command.kidId,
          command.decidedAt,
        );
        return { status: 'applied' };
      }).immediate();
    },

    async claimCategoryMutation(command) {
      return sqlite.transaction((): FinanceAssistantCategoryClaimResult => {
        const transaction = sqlite.prepare(`
          SELECT upstream_transaction_id AS upstreamTransactionId
          FROM finance_transactions
          WHERE id = ? AND connector_instance_id = ? AND lifecycle_status = 'active'
        `).get(command.transactionId, command.connectorId) as
          | { upstreamTransactionId: string }
          | undefined;
        if (!transaction) return { status: 'transaction-not-found' };

        const existing = sqlite.prepare(`
          SELECT transaction_id AS transactionId, requested_value AS requestedValue,
                 status, updated_at AS updatedAt
          FROM finance_mutation_audit
          WHERE connector_id = ? AND idempotency_key = ?
        `).get(command.connectorId, command.idempotencyKey) as {
          transactionId: string;
          requestedValue: string;
          status: 'pending' | 'processing' | 'succeeded' | 'failed';
          updatedAt: string;
        } | undefined;
        if (
          existing
          && (
            existing.transactionId !== command.transactionId
            || existing.requestedValue !== command.categoryId
          )
        ) {
          return { status: 'idempotency-conflict' };
        }
        if (existing?.status === 'succeeded') return { status: 'already-succeeded' };

        const current = readTransactionVersion(command.connectorId, command.transactionId);
        const expected = command.expectedVersion;
        if (
          !current
          || current.sourceFingerprint !== expected.sourceFingerprint
          || current.lastSeenAt !== expected.lastSeenAt
          || current.assignedKidId !== expected.assignedKidId
          || current.confirmedCategory !== expected.confirmedCategory
          || current.manualDecidedAt !== expected.manualDecidedAt
        ) {
          return { status: 'transaction-conflict' };
        }
        const category = sqlite.prepare(`
          SELECT name FROM finance_categories
          WHERE connector_id = ? AND upstream_category_id = ?
            AND is_active = 1 AND source_is_active = 1
        `).get(command.connectorId, command.categoryId) as { name: string } | undefined;
        if (!category || category.name !== command.expectedCategoryName) {
          return { status: 'category-conflict' };
        }

        const otherProcessing = sqlite.prepare(`
          SELECT 1
          FROM finance_mutation_audit
          WHERE connector_id = ? AND transaction_id = ?
            AND status = 'processing' AND idempotency_key <> ?
          LIMIT 1
        `).get(command.connectorId, command.transactionId, command.idempotencyKey);
        if (otherProcessing) return { status: 'mutation-in-progress' };
        if (
          existing?.status === 'processing'
          && Date.parse(existing.updatedAt)
            > Date.parse(command.claimedAt) - FINANCE_ASSISTANT_MUTATION_CLAIM_STALE_MS
        ) {
          return { status: 'mutation-in-progress' };
        }

        if (existing) {
          sqlite.prepare(`
            UPDATE finance_mutation_audit
            SET status = 'processing', attempt_count = attempt_count + 1,
                last_error_code = NULL, last_error_message = NULL, updated_at = ?
            WHERE connector_id = ? AND idempotency_key = ?
          `).run(command.claimedAt, command.connectorId, command.idempotencyKey);
        } else {
          sqlite.prepare(`
            INSERT INTO finance_mutation_audit (
              id, idempotency_key, connector_id, transaction_id,
              upstream_transaction_id, operation, requested_value, status,
              attempt_count, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'category_update', ?, 'processing', 1, ?, ?)
          `).run(
            idFactory(),
            command.idempotencyKey,
            command.connectorId,
            command.transactionId,
            transaction.upstreamTransactionId,
            command.categoryId,
            command.claimedAt,
            command.claimedAt,
          );
        }
        return {
          status: 'claimed',
          upstreamTransactionId: transaction.upstreamTransactionId,
          claimToken: command.claimedAt,
        };
      }).immediate();
    },

    async completeCategoryMutation(command) {
      return sqlite.transaction(() => {
        const completed = sqlite.prepare(`
          UPDATE finance_mutation_audit
          SET status = 'succeeded', completed_at = ?, updated_at = ?,
              last_error_code = NULL, last_error_message = NULL
          WHERE connector_id = ? AND idempotency_key = ?
            AND transaction_id = ? AND requested_value = ?
            AND status = 'processing' AND updated_at = ?
        `).run(
          command.completedAt,
          command.completedAt,
          command.connectorId,
          command.idempotencyKey,
          command.transactionId,
          command.categoryId,
          command.claimToken,
        );
        if (completed.changes !== 1) return false;
        sqlite.prepare(`
          UPDATE finance_transactions
          SET confirmed_category = ?, triage_status = 'confirmed'
          WHERE id = ? AND connector_instance_id = ?
        `).run(command.categoryId, command.transactionId, command.connectorId);
        return true;
      }).immediate();
    },

    async failCategoryMutation(command) {
      const failed = sqlite.prepare(`
        UPDATE finance_mutation_audit
        SET status = 'failed', last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE connector_id = ? AND idempotency_key = ?
          AND status = 'processing' AND updated_at = ?
      `).run(
        command.errorCode,
        command.errorMessage,
        command.failedAt,
        command.connectorId,
        command.idempotencyKey,
        command.claimToken,
      );
      return failed.changes === 1;
    },

    async persistPendingApproval(command) {
      return sqlite.transaction(() => {
        sqlite.prepare(`
          DELETE FROM houston_finance_pending_approvals
          WHERE expires_at <= ?
        `).run(command.createdAt);

        const existing = sqlite.prepare(`
          SELECT tool_call_id AS toolCallId, tool, tool_input AS toolInput
          FROM houston_finance_pending_approvals
          WHERE approval_id = ?
        `).get(command.approvalId) as {
          toolCallId: string;
          tool: string;
          toolInput: string;
        } | undefined;
        if (existing) {
          return existing.toolCallId === command.toolCallId
            && existing.tool === command.tool
            && existing.toolInput === command.toolInput
            ? { status: 'replayed' as const }
            : { status: 'conflict' as const };
        }

        sqlite.prepare(`
          INSERT INTO houston_finance_pending_approvals (
            approval_id, tool_call_id, tool, tool_input, correlation_id,
            expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          command.approvalId,
          command.toolCallId,
          command.tool,
          command.toolInput,
          command.correlationId,
          command.expiresAt,
          command.createdAt,
        );
        return { status: 'stored' as const };
      }).immediate();
    },

    async consumePendingApproval(command) {
      return sqlite.transaction(() => {
        const stored = sqlite.prepare(`
          SELECT tool_call_id AS toolCallId, tool, tool_input AS toolInput,
                 expires_at AS expiresAt
          FROM houston_finance_pending_approvals
          WHERE approval_id = ?
        `).get(command.approvalId) as {
          toolCallId: string;
          tool: string;
          toolInput: string;
          expiresAt: string;
        } | undefined;

        if (stored && stored.expiresAt <= command.now) {
          sqlite.prepare(`
            DELETE FROM houston_finance_pending_approvals
            WHERE approval_id = ?
          `).run(command.approvalId);
          return { status: 'expired' as const };
        }
        if (
          !stored
          || stored.toolCallId !== command.toolCallId
          || stored.tool !== command.tool
          || stored.toolInput !== command.toolInput
        ) {
          return { status: 'invalid' as const };
        }

        const deleted = sqlite.prepare(`
          DELETE FROM houston_finance_pending_approvals
          WHERE approval_id = ?
        `).run(command.approvalId);
        return deleted.changes === 1
          ? { status: 'consumed' as const, toolInput: stored.toolInput }
          : { status: 'invalid' as const };
      }).immediate();
    },

    async recordApprovalAudit(command) {
      sqlite.prepare(`
        INSERT INTO houston_finance_action_audit (
          id, correlation_id, call_hash, tool, decision, outcome, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        idFactory(),
        command.correlationId,
        command.callHash,
        command.tool,
        command.decision,
        command.outcome,
        command.durationMs,
        command.createdAt,
      );
    },
  };
}
