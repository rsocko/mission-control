import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
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
  type FinanceAssistantExpectedVersion,
  type FinanceAssistantKid,
  type FinanceAssistantKidAssignmentResult,
  type FinanceAssistantObligation,
  type FinanceAssistantPersistence,
  type FinanceAssistantProjectedCategory,
  type FinanceAssistantProjectedKid,
  type FinanceAssistantProjectionState,
  type FinanceAssistantTransaction,
} from '@/db/persistence/finance-assistant';

type Client = Pool | PoolClient;

interface PostgresFinanceAssistantOptions {
  idFactory?: () => string;
}

const PROVIDER_ALIASES = [...FINANCE_PROVIDER_ALIASES];

const TRANSACTION_COLUMNS = `
  t.id, t.connector_instance_id AS "connectorId",
  t.date, t.amount, t.merchant_name AS merchant,
  COALESCE(categories.name, t.confirmed_category, t.original_category) AS category,
  t.confirmed_category AS "confirmedCategory",
  t.is_pending AS pending, t.is_recurring AS recurring,
  profiles.name AS "kidName", t.attribution_status AS "attributionStatus",
  t.attribution_confidence AS confidence, t.attribution_method AS method,
  t.assigned_kid_id AS "assignedKidId",
  t.source_fingerprint AS "sourceFingerprint", t.last_seen_at AS "lastSeenAt",
  t.manual_decided_at AS "manualDecidedAt"
`;

const TRANSACTION_SOURCE = `
  FROM finance_transactions t
  LEFT JOIN kid_profiles profiles ON profiles.id = t.assigned_kid_id
  LEFT JOIN finance_categories categories
    ON categories.connector_id = t.connector_instance_id
    AND categories.upstream_category_id = t.confirmed_category
`;

/**
 * Null-safe compare-and-swap predicate for the approved transaction version.
 * `assigned_kid_id`, `confirmed_category`, and `manual_decided_at` are all
 * nullable, so `=` would silently never match a NULL and the mutation would
 * fail closed for the most common unattributed/uncategorized case.
 */
const EXPECTED_VERSION_PREDICATE = `
  source_fingerprint IS NOT DISTINCT FROM $3
  AND last_seen_at IS NOT DISTINCT FROM $4
  AND assigned_kid_id IS NOT DISTINCT FROM $5
  AND confirmed_category IS NOT DISTINCT FROM $6
  AND manual_decided_at IS NOT DISTINCT FROM $7
`;

function expectedVersionParameters(
  connectorId: string,
  transactionId: string,
  expected: FinanceAssistantExpectedVersion,
): unknown[] {
  return [
    transactionId,
    connectorId,
    expected.sourceFingerprint,
    expected.lastSeenAt,
    expected.assignedKidId,
    expected.confirmedCategory,
    expected.manualDecidedAt,
  ];
}

async function query<T>(
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

/** Escapes LIKE wildcards so a merchant substring stays a literal match. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * PostgreSQL implementation of the Houston finance-assistant port. Native
 * booleans, JSONB documents, and `bigint` counts are normalized to the same
 * domain shapes the SQLite adapter returns from integer flags and JSON text,
 * so the shared contract observes identical values on both backends.
 */
export function createPostgresFinanceAssistantPersistence(
  pool: Pool,
  options: PostgresFinanceAssistantOptions = {},
): FinanceAssistantPersistence {
  const idFactory = options.idFactory ?? randomUUID;

  return {
    async listEnabledConnectors() {
      return query<{ id: string; pollIntervalMinutes: number | null }>(
        pool,
        `SELECT id, poll_interval_minutes AS "pollIntervalMinutes"
         FROM connector_configs
         WHERE type = ANY($1::text[]) AND enabled = true AND deleted_at IS NULL
         ORDER BY created_at, id
         LIMIT $2`,
        [PROVIDER_ALIASES, FINANCE_ASSISTANT_CONNECTOR_LIMIT],
      );
    },

    async readConnectorConfig(connectorId) {
      const rows = await query<{
        id: string;
        type: string;
        name: string;
        enabled: boolean;
        syncMode: string;
        pollIntervalMinutes: number | null;
        capabilities: unknown;
        credentials: unknown;
        settings: unknown;
        syncedLists: unknown;
      }>(
        pool,
        `SELECT id, type, name, enabled, sync_mode AS "syncMode",
                poll_interval_minutes AS "pollIntervalMinutes", capabilities,
                credentials, settings, synced_lists AS "syncedLists"
         FROM connector_configs
         WHERE id = $1 AND enabled = true AND deleted_at IS NULL`,
        [connectorId],
      );
      const row = rows[0];
      if (!row) return null;
      const capabilities = jsonRecord(row.capabilities);
      const capability = (name: string) => capabilities[name] === true;
      return {
        id: row.id,
        type: row.type,
        name: row.name,
        enabled: row.enabled,
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
      const rows = await query<FinanceAssistantProjectionState>(
        pool,
        `SELECT last_successful_source_as_of AS "sourceAsOf",
                last_successful_projection_coverage_start AS "coverageStart",
                last_successful_projection_coverage_end AS "coverageEnd",
                last_successful_sync_at AS "lastSuccessfulSyncAt",
                status, last_error_code AS "lastErrorCode",
                attribution_status AS "attributionStatus",
                attribution_last_successful_at AS "attributionLastSuccessfulAt"
         FROM finance_sync_state
         WHERE connector_id = $1`,
        [connectorId],
      );
      return rows[0] ?? null;
    },

    async searchTransactions(input) {
      const limit = boundedAssistantLimit(input.limit, FINANCE_ASSISTANT_TRANSACTION_LIMIT_MAX);
      const conditions = [
        't.connector_instance_id = $1',
        `t.lifecycle_status = 'active'`,
        't.date >= $2',
        't.date <= $3',
      ];
      const parameters: unknown[] = [input.connectorId, input.startDate, input.endDate];
      const next = () => `$${parameters.length + 1}`;
      if (input.merchantQuery) {
        conditions.push(`lower(COALESCE(t.merchant_name, '')) LIKE ${next()} ESCAPE '\\'`);
        parameters.push(`%${escapeLikePattern(input.merchantQuery.toLowerCase())}%`);
      }
      if (input.categoryName) {
        const fallback = next();
        parameters.push('');
        const value = next();
        parameters.push(input.categoryName);
        conditions.push(
          `lower(COALESCE(categories.name, t.confirmed_category, t.original_category, ${fallback})) = lower(${value})`,
        );
      }
      if (input.kidId) {
        conditions.push(`t.assigned_kid_id = ${next()}`);
        parameters.push(input.kidId);
      }
      if (input.triageStatus) {
        conditions.push(`t.triage_status = ${next()}`);
        parameters.push(input.triageStatus);
      }
      const limitPlaceholder = next();
      parameters.push(limit + 1);
      const rows = await query<FinanceAssistantTransaction>(
        pool,
        `SELECT ${TRANSACTION_COLUMNS}
         ${TRANSACTION_SOURCE}
         WHERE ${conditions.join(' AND ')}
         ORDER BY t.date DESC, t.id DESC
         LIMIT ${limitPlaceholder}`,
        parameters,
      );
      return { transactions: rows.slice(0, limit), truncated: rows.length > limit };
    },

    async readSpendingSummary({ connectorId, startDate, endDate }) {
      const [total] = await query<{ amount: number; transactionCount: number }>(
        pool,
        `SELECT COALESCE(SUM(ABS(amount)), 0)::float8 AS amount,
                COUNT(*)::int AS "transactionCount"
         FROM finance_transactions
         WHERE connector_instance_id = $1 AND lifecycle_status = 'active'
           AND date >= $2 AND date <= $3`,
        [connectorId, startDate, endDate],
      );
      const byCategory = await query<{
        category: string;
        amount: number;
        transactionCount: number;
      }>(
        pool,
        `SELECT COALESCE(categories.name, transactions.confirmed_category,
                         transactions.original_category, 'Uncategorized') AS category,
                COALESCE(SUM(ABS(transactions.amount)), 0)::float8 AS amount,
                COUNT(*)::int AS "transactionCount"
         FROM finance_transactions transactions
         LEFT JOIN finance_categories categories
           ON categories.connector_id = transactions.connector_instance_id
           AND categories.upstream_category_id = transactions.confirmed_category
         WHERE transactions.connector_instance_id = $1
           AND transactions.lifecycle_status = 'active'
           AND transactions.date >= $2 AND transactions.date <= $3
         GROUP BY COALESCE(categories.name, transactions.confirmed_category,
                           transactions.original_category, 'Uncategorized')
         ORDER BY amount DESC, category
         LIMIT $4`,
        [connectorId, startDate, endDate, FINANCE_ASSISTANT_SUMMARY_GROUP_LIMIT],
      );
      const byKid = await query<{
        kidName: string;
        amount: number;
        transactionCount: number;
      }>(
        pool,
        `SELECT profiles.name AS "kidName",
                COALESCE(SUM(ABS(t.amount)), 0)::float8 AS amount,
                COUNT(*)::int AS "transactionCount"
         FROM finance_transactions t
         INNER JOIN kid_profiles profiles ON profiles.id = t.assigned_kid_id
         WHERE t.connector_instance_id = $1 AND t.lifecycle_status = 'active'
           AND t.date >= $2 AND t.date <= $3
         GROUP BY profiles.id, profiles.name
         ORDER BY amount DESC, profiles.name
         LIMIT $4`,
        [connectorId, startDate, endDate, FINANCE_ASSISTANT_SUMMARY_GROUP_LIMIT],
      );
      return {
        totalAmount: total.amount,
        transactionCount: total.transactionCount,
        byCategory,
        byKid,
      };
    },

    async readKidSpendingTotal({ connectorId, kidId, startDate, endDate }) {
      const [row] = await query<{ amount: number; transactionCount: number }>(
        pool,
        `SELECT COALESCE(SUM(ABS(amount)), 0)::float8 AS amount,
                COUNT(*)::int AS "transactionCount"
         FROM finance_transactions
         WHERE connector_instance_id = $1 AND lifecycle_status = 'active'
           AND assigned_kid_id = $2 AND date >= $3 AND date <= $4`,
        [connectorId, kidId, startDate, endDate],
      );
      return { totalAmount: row.amount, transactionCount: row.transactionCount };
    },

    async listAttributionExceptions({ connectorId, limit }) {
      const bounded = boundedAssistantLimit(limit, FINANCE_ASSISTANT_EXCEPTION_LIMIT_MAX);
      const rows = await query<FinanceAssistantException>(
        pool,
        `SELECT t.date, t.merchant_name AS "merchantName",
                e.reason_code AS "reasonCode", e.retryable,
                t.assigned_kid_id AS "assignedKidId",
                t.attribution_confidence AS confidence,
                e.last_observed_at AS "lastObservedAt"
         FROM finance_attribution_exceptions e
         INNER JOIN finance_transactions t
           ON t.id = e.transaction_id
           AND t.connector_instance_id = e.connector_id
         WHERE e.connector_id = $1 AND e.status IN ('open', 'retry_requested')
         ORDER BY e.updated_at DESC, e.id DESC
         LIMIT $2`,
        [connectorId, bounded + 1],
      );
      const subjects = await query<{ kidId: string; name: string }>(
        pool,
        `SELECT subjects.kid_id AS "kidId",
                COALESCE(NULLIF(profiles.name, ''), 'Household member') AS name
         FROM finance_attribution_subjects subjects
         INNER JOIN finance_sync_state state
           ON state.connector_id = subjects.connector_id
           AND state.attribution_policy_version = subjects.policy_version
         LEFT JOIN kid_profiles profiles ON profiles.id = subjects.kid_id
         WHERE subjects.connector_id = $1
         ORDER BY name, subjects.kid_id`,
        [connectorId],
      );
      return {
        exceptions: rows.slice(0, bounded),
        truncated: rows.length > bounded,
        subjects,
      };
    },

    async listRecurringObligations({ connectorId, horizonStart, horizonEnd, limit }) {
      const bounded = boundedAssistantLimit(limit, FINANCE_ASSISTANT_OBLIGATION_LIMIT_MAX);
      const rows = await query<FinanceAssistantObligation>(
        pool,
        `SELECT merchant, amount::float8 AS amount, frequency,
                next_expected_date AS "nextExpectedDate",
                category_name AS category
         FROM finance_recurring_obligations
         WHERE connector_id = $1 AND is_current = true
           AND next_expected_date >= $2 AND next_expected_date <= $3
         ORDER BY next_expected_date, merchant
         LIMIT $4`,
        [connectorId, horizonStart, horizonEnd, bounded + 1],
      );
      const [aggregate] = await query<{ estimatedMonthlyAmount: number }>(
        pool,
        `SELECT COALESCE(SUM(ABS(amount) * CASE lower(frequency)
           WHEN 'weekly' THEN 52.0 / 12.0
           WHEN 'biweekly' THEN 26.0 / 12.0
           WHEN 'every two weeks' THEN 26.0 / 12.0
           WHEN 'quarterly' THEN 1.0 / 3.0
           WHEN 'annual' THEN 1.0 / 12.0
           WHEN 'annually' THEN 1.0 / 12.0
           WHEN 'yearly' THEN 1.0 / 12.0
           ELSE 1.0
         END), 0)::float8 AS "estimatedMonthlyAmount"
         FROM finance_recurring_obligations
         WHERE connector_id = $1 AND is_current = true
           AND next_expected_date >= $2 AND next_expected_date <= $3`,
        [connectorId, horizonStart, horizonEnd],
      );
      return {
        obligations: rows.slice(0, bounded),
        truncated: rows.length > bounded,
        estimatedMonthlyAmount: aggregate.estimatedMonthlyAmount,
      };
    },

    async matchKidsByName(name) {
      return query<FinanceAssistantKid>(
        pool,
        `SELECT id, name, daily_limit AS "dailyLimit", weekly_limit AS "weeklyLimit",
                monthly_limit AS "monthlyLimit"
         FROM kid_profiles
         WHERE lower(name) = lower($1)
         ORDER BY id
         LIMIT $2`,
        [name, FINANCE_ASSISTANT_AMBIGUITY_LIMIT],
      );
    },

    async matchProjectedKidsByName({ connectorId, name }) {
      return query<FinanceAssistantProjectedKid>(
        pool,
        `SELECT profiles.id, profiles.name
         FROM kid_profiles profiles
         INNER JOIN finance_attribution_subjects subjects
           ON subjects.kid_id = profiles.id AND subjects.connector_id = $1
         INNER JOIN finance_sync_state state
           ON state.connector_id = subjects.connector_id
           AND state.attribution_policy_version = subjects.policy_version
         WHERE lower(profiles.name) = lower($2)
         ORDER BY profiles.id
         LIMIT $3`,
        [connectorId, name, FINANCE_ASSISTANT_AMBIGUITY_LIMIT],
      );
    },

    async matchProjectedCategoriesByName({ connectorId, name }) {
      return query<FinanceAssistantProjectedCategory>(
        pool,
        `SELECT upstream_category_id AS "upstreamCategoryId", name
         FROM finance_categories
         WHERE connector_id = $1 AND is_active = true AND source_is_active = true
           AND lower(name) = lower($2)
         ORDER BY upstream_category_id
         LIMIT $3`,
        [connectorId, name, FINANCE_ASSISTANT_AMBIGUITY_LIMIT],
      );
    },

    async findApprovedMutationTargets({ connectorId, date, amount }) {
      return query<FinanceAssistantTransaction>(
        pool,
        `SELECT ${TRANSACTION_COLUMNS}
         ${TRANSACTION_SOURCE}
         WHERE t.connector_instance_id = $1 AND t.lifecycle_status = 'active'
           AND t.date = $2 AND t.amount = $3::float8
         ORDER BY t.id
         LIMIT $4`,
        [connectorId, date, amount, FINANCE_ASSISTANT_MUTATION_TARGET_LIMIT],
      );
    },

    async findReplayedKidAssignments(idempotencyKey) {
      return query<{ kidName: string | null }>(
        pool,
        `SELECT profiles.name AS "kidName"
         FROM finance_attribution_audit audit
         LEFT JOIN kid_profiles profiles ON profiles.id = audit.requested_kid_id
         WHERE audit.idempotency_key = $1 AND audit.result_status = 'resolved'
         LIMIT $2`,
        [idempotencyKey, FINANCE_ASSISTANT_REPLAY_LIMIT],
      );
    },

    async findReplayedCategoryUpdates(idempotencyKey) {
      return query<{ categoryName: string | null }>(
        pool,
        `SELECT categories.name AS "categoryName"
         FROM finance_mutation_audit audit
         LEFT JOIN finance_categories categories
           ON categories.connector_id = audit.connector_id
           AND categories.upstream_category_id = audit.requested_value
         WHERE audit.idempotency_key = $1 AND audit.status = 'succeeded'
         LIMIT $2`,
        [idempotencyKey, FINANCE_ASSISTANT_REPLAY_LIMIT],
      );
    },

    async applyManualKidAssignment(command) {
      const matchesRequest = (audit: {
        transactionId: string;
        requestedKidId: string | null;
        requestedDecision: string | null;
        action: string;
      }) => audit.transactionId === command.transactionId
        && audit.requestedKidId === command.kidId
        && audit.requestedDecision === 'assign-kid'
        && audit.action === 'manual-resolve';
      const auditSelect = `
        SELECT transaction_id AS "transactionId", requested_kid_id AS "requestedKidId",
               requested_decision AS "requestedDecision", action
        FROM finance_attribution_audit
        WHERE connector_id = $1 AND idempotency_key = $2`;
      type AuditRow = {
        transactionId: string;
        requestedKidId: string | null;
        requestedDecision: string | null;
        action: string;
      };

      const [existing] = await query<AuditRow>(pool, auditSelect, [
        command.connectorId,
        command.idempotencyKey,
      ]);
      if (existing) {
        return matchesRequest(existing)
          ? { status: 'replayed' }
          : { status: 'idempotency-conflict' };
      }
      const connector = await query(
        pool,
        `SELECT 1 FROM connector_configs
         WHERE id = $1 AND type = ANY($2::text[])
           AND enabled = true AND deleted_at IS NULL`,
        [command.connectorId, PROVIDER_ALIASES],
      );
      if (connector.length === 0) return { status: 'connector-not-found' };

      return transaction(pool, async (client): Promise<FinanceAssistantKidAssignmentResult> => {
        const locked = await query(
          client,
          `SELECT 1 FROM finance_transactions
           WHERE id = $1 AND connector_instance_id = $2 AND lifecycle_status = 'active'
           FOR UPDATE`,
          [command.transactionId, command.connectorId],
        );
        if (locked.length === 0) return { status: 'transaction-not-found' };
        const [concurrent] = await query<AuditRow>(client, auditSelect, [
          command.connectorId,
          command.idempotencyKey,
        ]);
        if (concurrent) {
          return matchesRequest(concurrent)
            ? { status: 'replayed' }
            : { status: 'idempotency-conflict' };
        }
        const current = await query(
          client,
          `SELECT 1 FROM finance_transactions
           WHERE id = $1 AND connector_instance_id = $2 AND lifecycle_status = 'active'
             AND ${EXPECTED_VERSION_PREDICATE}`,
          expectedVersionParameters(
            command.connectorId,
            command.transactionId,
            command.expectedVersion,
          ),
        );
        if (current.length === 0) return { status: 'transaction-conflict' };
        const projected = await query(
          client,
          `SELECT 1
           FROM finance_attribution_subjects subjects
           INNER JOIN finance_sync_state state
             ON state.connector_id = subjects.connector_id
             AND state.attribution_policy_version = subjects.policy_version
           WHERE subjects.connector_id = $1 AND subjects.kid_id = $2`,
          [command.connectorId, command.kidId],
        );
        if (projected.length === 0) return { status: 'unknown-attribution-subject' };

        const inserted = await query<{ id: string }>(
          client,
          `INSERT INTO finance_attribution_audit (
             id, connector_id, transaction_id, exception_id, idempotency_key,
             action, actor_type, requested_kid_id, requested_decision,
             result_status, created_at
           ) VALUES ($1, $2, $3, NULL, $4, 'manual-resolve', $5, $6, 'assign-kid', 'resolved', $7)
           ON CONFLICT (connector_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [
            idFactory(),
            command.connectorId,
            command.transactionId,
            command.idempotencyKey,
            command.actorType,
            command.kidId,
            command.decidedAt,
          ],
        );
        if (inserted.length === 0) {
          const [raced] = await query<AuditRow>(client, auditSelect, [
            command.connectorId,
            command.idempotencyKey,
          ]);
          return raced && matchesRequest(raced)
            ? { status: 'replayed' }
            : { status: 'idempotency-conflict' };
        }

        await client.query(
          `UPDATE finance_transactions
           SET assigned_kid_id = $1, kid_assignment_method = 'manual',
               manual_decision_action = 'assign-kid', manual_decided_at = $2,
               attribution_status = 'attributed', attribution_confidence = 'definite',
               attribution_method = 'manual',
               attribution_explanation = 'Confirmed by parent administrator',
               attribution_reasons = '[]'::jsonb, attribution_decision_source = 'manual',
               attribution_evaluated_at = $2, attribution_review_state = 'resolved',
               attribution_provenance = 'mission-control-manual-v1',
               attribution_last_error_code = NULL, attribution_retryable = false,
               attribution_updated_at = $2, triage_status = 'confirmed'
           WHERE id = $3 AND connector_instance_id = $4`,
          [command.kidId, command.decidedAt, command.transactionId, command.connectorId],
        );
        await client.query(
          `UPDATE finance_attribution_exceptions
           SET status = 'resolved', review_state = 'resolved',
               resolution = 'manual', resolved_at = $1, updated_at = $1
           WHERE connector_id = $2 AND transaction_id = $3`,
          [command.decidedAt, command.connectorId, command.transactionId],
        );
        return { status: 'applied' };
      });
    },

    async claimCategoryMutation(command) {
      return transaction(pool, async (client): Promise<FinanceAssistantCategoryClaimResult> => {
        const [locked] = await query<{ upstreamTransactionId: string }>(
          client,
          `SELECT upstream_transaction_id AS "upstreamTransactionId"
           FROM finance_transactions
           WHERE id = $1 AND connector_instance_id = $2 AND lifecycle_status = 'active'
           FOR UPDATE`,
          [command.transactionId, command.connectorId],
        );
        if (!locked) return { status: 'transaction-not-found' };

        const [existing] = await query<{
          transactionId: string;
          requestedValue: string;
          status: 'pending' | 'processing' | 'succeeded' | 'failed';
          updatedAt: string;
        }>(
          client,
          `SELECT transaction_id AS "transactionId", requested_value AS "requestedValue",
                  status, updated_at AS "updatedAt"
           FROM finance_mutation_audit
           WHERE connector_id = $1 AND idempotency_key = $2
           FOR UPDATE`,
          [command.connectorId, command.idempotencyKey],
        );
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

        const current = await query(
          client,
          `SELECT 1 FROM finance_transactions
           WHERE id = $1 AND connector_instance_id = $2 AND lifecycle_status = 'active'
             AND ${EXPECTED_VERSION_PREDICATE}`,
          expectedVersionParameters(
            command.connectorId,
            command.transactionId,
            command.expectedVersion,
          ),
        );
        if (current.length === 0) return { status: 'transaction-conflict' };
        const category = await query<{ name: string }>(
          client,
          `SELECT name FROM finance_categories
           WHERE connector_id = $1 AND upstream_category_id = $2
             AND is_active = true AND source_is_active = true`,
          [command.connectorId, command.categoryId],
        );
        if (!category[0] || category[0].name !== command.expectedCategoryName) {
          return { status: 'category-conflict' };
        }

        const otherProcessing = await query(
          client,
          `SELECT 1
           FROM finance_mutation_audit
           WHERE connector_id = $1 AND transaction_id = $2
             AND status = 'processing' AND idempotency_key <> $3
           LIMIT 1`,
          [command.connectorId, command.transactionId, command.idempotencyKey],
        );
        if (otherProcessing.length > 0) return { status: 'mutation-in-progress' };
        if (
          existing?.status === 'processing'
          && Date.parse(existing.updatedAt)
            > Date.parse(command.claimedAt) - FINANCE_ASSISTANT_MUTATION_CLAIM_STALE_MS
        ) {
          return { status: 'mutation-in-progress' };
        }

        if (existing) {
          await client.query(
            `UPDATE finance_mutation_audit
             SET status = 'processing', attempt_count = attempt_count + 1,
                 last_error_code = NULL, last_error_message = NULL, updated_at = $1
             WHERE connector_id = $2 AND idempotency_key = $3`,
            [command.claimedAt, command.connectorId, command.idempotencyKey],
          );
        } else {
          const inserted = await query<{ id: string }>(
            client,
            `INSERT INTO finance_mutation_audit (
               id, idempotency_key, connector_id, transaction_id,
               upstream_transaction_id, operation, requested_value, status,
               attempt_count, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, 'category_update', $6, 'processing', 1, $7, $7)
             ON CONFLICT (connector_id, idempotency_key) DO NOTHING
             RETURNING id`,
            [
              idFactory(),
              command.idempotencyKey,
              command.connectorId,
              command.transactionId,
              locked.upstreamTransactionId,
              command.categoryId,
              command.claimedAt,
            ],
          );
          if (inserted.length === 0) return { status: 'idempotency-conflict' };
        }
        return {
          status: 'claimed',
          upstreamTransactionId: locked.upstreamTransactionId,
         claimToken: command.claimedAt,
        };
      });
    },

    async completeCategoryMutation(command) {
      return transaction(pool, async (client) => {
        const completed = await query<{ id: string }>(
         client,
         `UPDATE finance_mutation_audit
          SET status = 'succeeded', completed_at = $1, updated_at = $1,
              last_error_code = NULL, last_error_message = NULL
          WHERE connector_id = $2 AND idempotency_key = $3
            AND transaction_id = $4 AND requested_value = $5
            AND status = 'processing' AND updated_at = $6
          RETURNING id`,
         [
           command.completedAt,
           command.connectorId,
           command.idempotencyKey,
           command.transactionId,
           command.categoryId,
           command.claimToken,
         ],
        );
        if (completed.length !== 1) return false;
        await client.query(
         `UPDATE finance_transactions
          SET confirmed_category = $1, triage_status = 'confirmed'
          WHERE id = $2 AND connector_instance_id = $3`,
         [command.categoryId, command.transactionId, command.connectorId],
        );
        return true;
      });
    },

    async failCategoryMutation(command) {
      const result = await pool.query(
        `UPDATE finance_mutation_audit
        SET status = 'failed', last_error_code = $1, last_error_message = $2, updated_at = $3
        WHERE connector_id = $4 AND idempotency_key = $5
          AND status = 'processing' AND updated_at = $6`,
        [
         command.errorCode,
         command.errorMessage,
         command.failedAt,
         command.connectorId,
         command.idempotencyKey,
         command.claimToken,
        ],
      );
      return result.rowCount === 1;
    },

    async persistPendingApproval(command) {
      return transaction(pool, async (client) => {
        await client.query(
          `DELETE FROM houston_finance_pending_approvals WHERE expires_at <= $1`,
          [command.createdAt],
        );
        const inserted = await query<{ approvalId: string }>(
          client,
          `INSERT INTO houston_finance_pending_approvals (
             approval_id, tool_call_id, tool, tool_input, correlation_id,
             expires_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (approval_id) DO NOTHING
           RETURNING approval_id AS "approvalId"`,
          [
            command.approvalId,
            command.toolCallId,
            command.tool,
            command.toolInput,
            command.correlationId,
            command.expiresAt,
            command.createdAt,
          ],
        );
        if (inserted.length === 1) return { status: 'stored' as const };
        const [existing] = await query<{
          toolCallId: string;
          tool: string;
          toolInput: string;
        }>(
          client,
          `SELECT tool_call_id AS "toolCallId", tool, tool_input AS "toolInput"
           FROM houston_finance_pending_approvals
           WHERE approval_id = $1`,
          [command.approvalId],
        );
        return existing
          && existing.toolCallId === command.toolCallId
          && existing.tool === command.tool
          && existing.toolInput === command.toolInput
          ? { status: 'replayed' as const }
          : { status: 'conflict' as const };
      });
    },

    async consumePendingApproval(command) {
      return transaction(pool, async (client) => {
        const [stored] = await query<{
          toolCallId: string;
          tool: string;
          toolInput: string;
          expiresAt: string;
        }>(
          client,
          `SELECT tool_call_id AS "toolCallId", tool, tool_input AS "toolInput",
                  expires_at AS "expiresAt"
           FROM houston_finance_pending_approvals
           WHERE approval_id = $1
           FOR UPDATE`,
          [command.approvalId],
        );

        if (stored && stored.expiresAt <= command.now) {
          await client.query(
            `DELETE FROM houston_finance_pending_approvals WHERE approval_id = $1`,
            [command.approvalId],
          );
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
        const deleted = await query<{ approvalId: string }>(
          client,
          `DELETE FROM houston_finance_pending_approvals
           WHERE approval_id = $1
           RETURNING approval_id AS "approvalId"`,
          [command.approvalId],
        );
        return deleted.length === 1
          ? { status: 'consumed' as const, toolInput: stored.toolInput }
          : { status: 'invalid' as const };
      });
    },

    async recordApprovalAudit(command) {
      await pool.query(
        `INSERT INTO houston_finance_action_audit (
           id, correlation_id, call_hash, tool, decision, outcome, duration_ms, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          idFactory(),
          command.correlationId,
          command.callHash,
          command.tool,
          command.decision,
          command.outcome,
          command.durationMs,
          command.createdAt,
        ],
      );
    },
  };
}
