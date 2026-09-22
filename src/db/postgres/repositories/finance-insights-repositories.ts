import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  FinanceInsightBackfillDeliveryEnabledError,
  FinanceInsightBackfillPlanUnavailableError,
  FinanceInsightBackfillProjectionConflictError,
  FinanceInsightBackfillTooLargeError,
  FinanceInsightBackfillWindowIncompleteError,
  FinanceInsightProjectionFenceError,
  type FinanceInsightBackfillPageCommand,
  type FinanceInsightBackfillPersistence,
  type FinanceInsightBackfillPlan,
  type FinanceInsightBackfillPromotionCommand,
  type FinanceInsightBackfillTransaction,
  type FinanceInsightBackfillWindowCaptureCommand,
  type FinanceInsightBackfillWindowProof,
  type FinanceInsightConnectorPersistence,
  type FinanceInsightDatasetInsightState,
  type FinanceInsightDeliveryPersistence,
  type FinanceInsightDeliveryState,
  type FinanceInsightOccurrenceCachePersistence,
  type FinanceInsightOccurrenceCacheState,
  type FinanceInsightOccurrenceMetadataRow,
  type FinanceInsightOccurrenceReplaceItem,
  type FinanceInsightOperationalAccountFact,
  type FinanceInsightOperationalFactKind,
  type FinanceInsightOperationalProjectionFacts,
  type FinanceInsightOperationalRecurringFact,
  type FinanceInsightPersistence,
  type FinanceInsightProjectionAttemptFactsCommand,
  type FinanceInsightProjectionAttemptStartCommand,
  type FinanceInsightProjectionAttemptWindowCommand,
  type FinanceInsightProjectionFailAttemptCommand,
  type FinanceInsightProjectionPersistence,
  type FinanceInsightProjectionPromoteAttemptCommand,
  type FinanceInsightProjectionState,
  type FinanceInsightPublicationCaptureCommand,
  type FinanceInsightPublicationCaptureResult,
  type FinanceInsightPublicationPersistence,
  type FinanceInsightPublicationRecord,
  type FinanceInsightPublicationState,
  type FinanceInsightWindowProof,
} from '@/db/persistence/finance-insights';
import { financeInsightDigestV1, type CanonicalJsonValue } from '@/lib/finance-insights/canonical';
import { transactionSourceFactSchema } from '@/lib/finance-insights/contract';
import { financeInsightOccurrenceRevisionDigest } from '@/lib/finance-insights/occurrence-shared';
import {
  financeConnectorScopedReference,
} from '@/lib/connectors/monarch-money/identity';

type Client = Pool | PoolClient;

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

async function lockFinanceScope(
  client: PoolClient,
  scope: string,
  connectorId: string,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`finance-insights:${scope}:${connectorId}`],
  );
}

function localTransactionId(connectorId: string, upstreamId: string): string {
  return `finance:${connectorId}:${upstreamId}`;
}

function stableValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function transactionFingerprint(value: FinanceInsightBackfillTransaction): string {
  return stableValue(value);
}

function assertBatch(size: number, maximum: number, label: string): void {
  if (size > maximum) {
    throw new RangeError(`${label} exceeds the maximum batch size of ${maximum}`);
  }
}

// ─── Connector selection ────────────────────────────────────────────────────

function createConnectorPersistence(pool: Pool): FinanceInsightConnectorPersistence {
  return {
    async listEnabledConnectorIds(connectorTypes, limit) {
      if (connectorTypes.length === 0 || limit < 1) return [];
      const rows = await query<{ id: string }>(
        pool,
        `SELECT id FROM connector_configs
         WHERE enabled = true AND deleted_at IS NULL
           AND type = ANY($1::text[])
         ORDER BY id
         LIMIT $2`,
        [connectorTypes, limit],
      );
      return rows.map((row) => row.id);
    },
    async resolveSingleEnabledConnectorId(connectorTypes) {
      const rows = await this.listEnabledConnectorIds(connectorTypes, 2);
      return rows.length === 1 ? rows[0]! : null;
    },
  };
}

// ─── History projection ─────────────────────────────────────────────────────

function createProjectionPersistence(pool: Pool): FinanceInsightProjectionPersistence {
  return {
    async startAttempt(command: FinanceInsightProjectionAttemptStartCommand) {
      await transaction(pool, async (client) => {
        await client.query(
          `INSERT INTO finance_insight_transaction_projection_state (
             connector_id, status, current_attempt_id, last_attempt_at,
             created_at, updated_at
           ) VALUES ($1, 'running', $2, $3, $3, $3)
           ON CONFLICT (connector_id) DO UPDATE SET
             status = 'running',
             current_attempt_id = EXCLUDED.current_attempt_id,
             last_attempt_at = EXCLUDED.last_attempt_at,
             last_error_code = NULL,
             updated_at = EXCLUDED.updated_at`,
          [command.connectorId, command.attemptId, command.attemptAt],
        );
        await client.query(
          `DELETE FROM finance_insight_transaction_projection_facts
           WHERE connector_id = $1
             AND generation_id <> COALESCE((
               SELECT successful_generation_id
               FROM finance_insight_transaction_projection_state
               WHERE connector_id = $1
             ), '')`,
          [command.connectorId],
        );
        await client.query(
          `DELETE FROM finance_insight_transaction_projection_windows
           WHERE connector_id = $1
             AND generation_id <> COALESCE((
               SELECT successful_generation_id
               FROM finance_insight_transaction_projection_state
               WHERE connector_id = $1
             ), '')`,
          [command.connectorId],
        );
      });
    },

    async insertAttemptFacts(command: FinanceInsightProjectionAttemptFactsCommand) {
      if (command.facts.length === 0) return;
      await transaction(pool, async (client) => {
        for (const fact of command.facts) {
          await client.query(
            `INSERT INTO finance_insight_transaction_projection_facts (
               connector_id, generation_id, source_ref, occurred_on, payload
             ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
              command.connectorId,
              command.attemptId,
              fact.sourceRef,
              fact.occurredOn,
              JSON.stringify(fact.payload),
            ],
          );
        }
      });
    },

    async insertAttemptWindowProof(command: FinanceInsightProjectionAttemptWindowCommand) {
      await query(
        pool,
        `INSERT INTO finance_insight_transaction_projection_windows (
           connector_id, generation_id, window_index, coverage_start,
           coverage_end, source_as_of, item_count, content_digest
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          command.connectorId,
          command.attemptId,
          command.proof.index,
          command.proof.start,
          command.proof.end,
          command.proof.sourceAsOf,
          command.proof.itemCount,
          command.proof.digest,
        ],
      );
    },

    async readAttemptFacts(connectorId: string, attemptId: string) {
      const rows = await query<{
        sourceRef: string;
        occurredOn: string;
        payload: unknown;
      }>(
        pool,
        `SELECT source_ref AS "sourceRef", occurred_on AS "occurredOn", payload
         FROM finance_insight_transaction_projection_facts
         WHERE connector_id = $1 AND generation_id = $2
         ORDER BY source_ref`,
        [connectorId, attemptId],
      );
      return rows;
    },

    async readAttemptWindowProofs(connectorId: string, attemptId: string) {
      return query<FinanceInsightWindowProof>(
        pool,
        `SELECT window_index AS "index", coverage_start AS "start", coverage_end AS "end",
                source_as_of AS "sourceAsOf", item_count AS "itemCount",
                content_digest AS "digest"
         FROM finance_insight_transaction_projection_windows
         WHERE connector_id = $1 AND generation_id = $2
         ORDER BY window_index`,
        [connectorId, attemptId],
      );
    },

    async promoteAttempt(command: FinanceInsightProjectionPromoteAttemptCommand) {
      await transaction(pool, async (client) => {
        const stagedFacts = await query<{ payload: unknown }>(
          client,
          `SELECT payload
           FROM finance_insight_transaction_projection_facts
           WHERE connector_id = $1 AND generation_id = $2
           ORDER BY source_ref`,
          [command.connectorId, command.attemptId],
        );
        const verifiedFacts = stagedFacts.map((row) => transactionSourceFactSchema.parse(row.payload));
        const stagedWindows = await query<FinanceInsightWindowProof>(
          client,
          `SELECT window_index AS "index", coverage_start AS start, coverage_end AS end,
                  source_as_of AS "sourceAsOf", item_count AS "itemCount",
                  content_digest AS digest
           FROM finance_insight_transaction_projection_windows
           WHERE connector_id = $1 AND generation_id = $2
           ORDER BY window_index`,
          [command.connectorId, command.attemptId],
        );
        if (
          verifiedFacts.length !== command.itemCount
          || financeInsightDigestV1(verifiedFacts as CanonicalJsonValue) !== command.contentDigest
          || stagedWindows.length !== command.windowCount
          || financeInsightDigestV1(stagedWindows as unknown as CanonicalJsonValue)
            !== command.windowsDigest
        ) {
          throw new Error('finance_insight_history_changed_before_commit');
        }
        await client.query(
          `DELETE FROM finance_insight_transaction_projection_facts
           WHERE connector_id = $1 AND generation_id = $2`,
          [command.connectorId, command.generationId],
        );
        await client.query(
          `DELETE FROM finance_insight_transaction_projection_windows
           WHERE connector_id = $1 AND generation_id = $2`,
          [command.connectorId, command.generationId],
        );
        await client.query(
          `UPDATE finance_insight_transaction_projection_facts
           SET generation_id = $1
           WHERE connector_id = $2 AND generation_id = $3`,
          [command.generationId, command.connectorId, command.attemptId],
        );
        await client.query(
          `UPDATE finance_insight_transaction_projection_windows
           SET generation_id = $1
           WHERE connector_id = $2 AND generation_id = $3`,
          [command.generationId, command.connectorId, command.attemptId],
        );
        const promoted = await client.query(
          `UPDATE finance_insight_transaction_projection_state
           SET status = 'succeeded', current_attempt_id = NULL,
               last_successful_at = $1, successful_generation_id = $2,
               source_as_of = $3, item_count = $4, content_digest = $5,
               coverage_start = $6, coverage_end = $7, window_count = $8,
               windows_digest = $9, bridge_contract_version = $10,
               last_error_code = NULL, updated_at = $1
           WHERE connector_id = $11 AND current_attempt_id = $12`,
          [
            command.completedAt,
            command.generationId,
            command.sourceAsOf,
            command.itemCount,
            command.contentDigest,
            command.coverageStart,
            command.coverageEnd,
            command.windowCount,
            command.windowsDigest,
            command.bridgeContractVersion,
            command.connectorId,
            command.attemptId,
          ],
        );
        if (promoted.rowCount !== 1) throw new FinanceInsightProjectionFenceError();
        await client.query(
          `DELETE FROM finance_insight_transaction_projection_facts
           WHERE connector_id = $1 AND generation_id <> $2`,
          [command.connectorId, command.generationId],
        );
        await client.query(
          `DELETE FROM finance_insight_transaction_projection_windows
           WHERE connector_id = $1 AND generation_id <> $2`,
          [command.connectorId, command.generationId],
        );
      });
    },

    async failAttempt(command: FinanceInsightProjectionFailAttemptCommand) {
      return transaction(pool, async (client) => {
        await client.query(
          `DELETE FROM finance_insight_transaction_projection_facts
           WHERE connector_id = $1 AND generation_id = $2`,
          [command.connectorId, command.attemptId],
        );
        await client.query(
          `DELETE FROM finance_insight_transaction_projection_windows
           WHERE connector_id = $1 AND generation_id = $2`,
          [command.connectorId, command.attemptId],
        );
        const result = await client.query(
          `UPDATE finance_insight_transaction_projection_state
           SET status = 'failed', current_attempt_id = NULL,
               last_error_code = $1, updated_at = $2
           WHERE connector_id = $3 AND current_attempt_id = $4`,
          [command.errorCode, command.failedAt, command.connectorId, command.attemptId],
        );
        return { recorded: result.rowCount === 1 };
      });
    },

    async readState(connectorId: string): Promise<FinanceInsightProjectionState | null> {
      const rows = await query<FinanceInsightProjectionState>(
        pool,
        `SELECT status, successful_generation_id AS "generationId",
                last_successful_at AS "lastSuccessfulAt", source_as_of AS "sourceAsOf",
                item_count AS "itemCount", content_digest AS "contentDigest",
                coverage_start AS "coverageStart", coverage_end AS "coverageEnd",
                window_count AS "windowCount", windows_digest AS "windowsDigest",
                bridge_contract_version AS "bridgeContractVersion"
         FROM finance_insight_transaction_projection_state
         WHERE connector_id = $1`,
        [connectorId],
      );
      return rows[0] ?? null;
    },

    async readWindowProofs(connectorId: string, generationId: string) {
      return query<FinanceInsightWindowProof>(
        pool,
        `SELECT window_index AS "index", coverage_start AS "start", coverage_end AS "end",
                source_as_of AS "sourceAsOf", item_count AS "itemCount",
                content_digest AS "digest"
         FROM finance_insight_transaction_projection_windows
         WHERE connector_id = $1 AND generation_id = $2
         ORDER BY window_index`,
        [connectorId, generationId],
      );
    },

    async readPromotedTransactionFacts(connectorId: string, generationId: string) {
      const rows = await query<{ payload: unknown }>(
        pool,
        `SELECT payload
         FROM finance_insight_transaction_projection_facts
         WHERE connector_id = $1 AND generation_id = $2
         ORDER BY source_ref`,
        [connectorId, generationId],
      );
      return rows.map((row) => row.payload);
    },

    async readDatasetInsightState(connectorId: string): Promise<FinanceInsightDatasetInsightState[]> {
      return query<FinanceInsightDatasetInsightState>(
        pool,
        `SELECT dataset, current_generation_id AS "generationId",
                source_as_of AS "sourceAsOf", fresh_until AS "freshUntil",
                last_attempt_outcome AS "outcome",
                insight_item_count AS "itemCount",
                insight_content_digest AS "contentDigest",
                insight_bridge_contract_version AS "bridgeContractVersion"
         FROM finance_dataset_sync_state
         WHERE connector_id = $1`,
        [connectorId],
      );
    },

    async readOperationalProjectionFacts(
      connectorId: string,
      transactionStart: string,
      onlyKind?: FinanceInsightOperationalFactKind,
      transactionEnd?: string,
    ) {
      return readPostgresFinanceInsightProjectionFacts(
        pool,
        connectorId,
        transactionStart,
        onlyKind,
        transactionEnd,
      );
    },
  };
}

// ─── Live (operational) projection fact reads ───────────────────────────────
// Used both by backfill window/promotion digest verification (transaction
// only) and by the async `readOperationalProjectionFacts` port, which also
// backs publication's recurring/category/account/tag facts. Normalization
// and identity scoping mirror the SQLite adapter's
// `sqlite-finance-insight-projection-facts.ts` exactly.

function normalizedName(value: unknown, maximum: number, fallback: string): string {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || fallback).slice(0, maximum);
}

function amountMinor(value: number): number {
  const rounded = Math.round(value * 100);
  if (!Number.isSafeInteger(rounded)) throw new Error('invalid_amount_range');
  return rounded;
}

function nullableAmountMinor(value: number | null): number | null {
  return value === null ? null : amountMinor(value);
}

function recurringCadence(value: string): FinanceInsightOperationalRecurringFact['cadence'] {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'weekly') return 'weekly';
  if (['biweekly', 'fortnightly', 'every2weeks'].includes(normalized)) return 'biweekly';
  if (normalized === 'monthly') return 'monthly';
  if (normalized === 'quarterly') return 'quarterly';
  if (['semiannual', 'semiannually', 'twiceyearly'].includes(normalized)) return 'semiannual';
  if (['annual', 'annually', 'yearly'].includes(normalized)) return 'annual';
  return 'unknown';
}

function accountType(value: string): FinanceInsightOperationalAccountFact['accountType'] {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('check')) return 'checking';
  if (normalized.includes('saving')) return 'savings';
  if (normalized.includes('credit')) return 'credit';
  if (normalized.includes('cash')) return 'cash';
  if (normalized.includes('loan') || normalized.includes('mortgage')) return 'loan';
  if (normalized.includes('invest') || normalized.includes('broker')) return 'investment';
  return 'other';
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

async function readIdentityNamespace(pool: Client, connectorId: string): Promise<string> {
  const rows = await query<{ credentials: unknown }>(
    pool,
    `SELECT credentials FROM connector_configs WHERE id = $1`,
    [connectorId],
  );
  const credentials = (rows[0]?.credentials as Record<string, unknown> | null) ?? {};
  const namespace = credentials.identityNamespace;
  if (typeof namespace !== 'string' || !/^[a-f0-9]{64}$/.test(namespace)) {
    throw new Error('Finance connector identity state is invalid');
  }
  return namespace;
}

function bySourceRef<T extends { sourceRef: string }>(left: T, right: T): number {
  return left.sourceRef < right.sourceRef ? -1 : left.sourceRef > right.sourceRef ? 1 : 0;
}

export async function readPostgresFinanceInsightProjectionFacts(
  pool: Client,
  connectorId: string,
  transactionStart: string,
  onlyKind: FinanceInsightOperationalFactKind | undefined,
  transactionEnd: string | undefined,
): Promise<FinanceInsightOperationalProjectionFacts> {
  const identityNamespace = await readIdentityNamespace(pool, connectorId);
  const scoped = (kind: string, value: string | null): string | null => (
    value === null ? null : financeConnectorScopedReference(identityNamespace, kind, value)
  );

  const transaction = !onlyKind || onlyKind === 'transaction'
    ? (await query<{
      sourceRef: string;
      occurredOn: string;
      amount: number;
      merchantName: string | null;
      categoryRef: string | null;
      accountRef: string | null;
      isPending: boolean;
      tagReferences: unknown;
    }>(
      pool,
      `SELECT upstream_transaction_id AS "sourceRef", date AS "occurredOn", amount,
               merchant_name AS "merchantName", category_id AS "categoryRef",
               account_id AS "accountRef", is_pending AS "isPending",
               tag_references AS "tagReferences"
       FROM finance_transactions
       WHERE connector_instance_id = $1 AND lifecycle_status = 'active'
         AND date >= $2 AND ($3::text IS NULL OR date <= $3)
       ORDER BY upstream_transaction_id`,
      [connectorId, transactionStart, transactionEnd ?? null],
    )).map((row) => ({
      sourceRef: scoped('transaction', row.sourceRef)!,
      occurredOn: row.occurredOn,
      amountMinor: amountMinor(row.amount),
      merchantName: normalizedName(row.merchantName, 160, 'Unknown merchant'),
      categoryRef: scoped('category', row.categoryRef),
      accountRef: scoped('account', row.accountRef),
      isPending: row.isPending,
      recurringRef: null,
      tagRefs: [...new Set(parseTags(row.tagReferences).map((value) => scoped('tag', value)!))].sort(),
    })).sort(bySourceRef)
    : [];

  const recurring = !onlyKind || onlyKind === 'recurring'
    ? (await query<{
      sourceRef: string;
      merchant: string;
      amount: number | null;
      frequency: string;
      nextDate: string | null;
      categoryRef: string | null;
      accountRef: string | null;
    }>(
      pool,
      `SELECT upstream_recurring_id AS "sourceRef", merchant, amount, frequency,
               next_expected_date AS "nextDate", upstream_category_id AS "categoryRef",
               upstream_account_id AS "accountRef"
       FROM finance_recurring_obligations
       WHERE connector_id = $1 AND is_current = true
       ORDER BY upstream_recurring_id`,
      [connectorId],
    )).map((row) => ({
      sourceRef: scoped('recurring', row.sourceRef)!,
      displayName: normalizedName(row.merchant, 120, 'Unknown recurring item'),
      amountMinor: nullableAmountMinor(row.amount),
      cadence: recurringCadence(row.frequency),
      nextDate: row.nextDate,
      categoryRef: scoped('category', row.categoryRef),
      accountRef: scoped('account', row.accountRef),
      active: true,
    })).sort(bySourceRef)
    : [];

  const category = !onlyKind || onlyKind === 'category'
    ? (await query<{
      sourceRef: string;
      name: string;
      groupRef: string | null;
      active: boolean;
    }>(
      pool,
      `SELECT upstream_category_id AS "sourceRef", name, upstream_group_id AS "groupRef",
               is_active AS "active"
       FROM finance_categories WHERE connector_id = $1
       ORDER BY upstream_category_id`,
      [connectorId],
    )).map((row) => ({
      sourceRef: scoped('category', row.sourceRef)!,
      displayName: normalizedName(row.name, 120, 'Unknown category'),
      groupRef: scoped('category-group', row.groupRef),
      active: row.active,
    })).sort(bySourceRef)
    : [];

  const account = !onlyKind || onlyKind === 'account'
    ? (await query<{ sourceRef: string; type: string; active: boolean }>(
      pool,
      `SELECT upstream_account_id AS "sourceRef", type, is_active AS "active"
       FROM finance_accounts WHERE connector_id = $1
       ORDER BY upstream_account_id`,
      [connectorId],
    )).map((row) => ({
      sourceRef: scoped('account', row.sourceRef)!,
      accountType: accountType(row.type),
      active: row.active,
    })).sort(bySourceRef)
    : [];

  const tag = !onlyKind || onlyKind === 'tag'
    ? (await query<{ sourceRef: string; name: string; active: boolean }>(
      pool,
      `SELECT upstream_tag_id AS "sourceRef", name, is_active AS "active"
       FROM finance_tags WHERE connector_id = $1
       ORDER BY upstream_tag_id`,
      [connectorId],
    )).map((row) => ({
      sourceRef: scoped('tag', row.sourceRef)!,
      displayName: normalizedName(row.name, 120, 'Unknown tag'),
      active: row.active,
    })).sort(bySourceRef)
    : [];

  return { transaction, recurring, category, account, tag };
}

type LiveTransactionFact = FinanceInsightOperationalProjectionFacts['transaction'][number];

async function readLiveTransactionFacts(
  pool: Client,
  connectorId: string,
  windowStart: string,
  windowEnd: string,
): Promise<LiveTransactionFact[]> {
  return (
    await readPostgresFinanceInsightProjectionFacts(
      pool,
      connectorId,
      windowStart,
      'transaction',
      windowEnd,
    )
  ).transaction;
}

// ─── Transaction backfill ───────────────────────────────────────────────────

async function assertDeliveryDisabledAsync(pool: Client, connectorId: string): Promise<void> {
  const rows = await query<{ deliveryEnabled: boolean }>(
    pool,
    `SELECT delivery_enabled AS "deliveryEnabled"
     FROM finance_insight_cutovers WHERE connector_id = $1`,
    [connectorId],
  );
  if (rows[0]?.deliveryEnabled === true) {
    throw new FinanceInsightBackfillDeliveryEnabledError();
  }
}

async function loadPlanAsync(
  client: Client,
  connectorId: string,
  idempotencyKey: string,
): Promise<FinanceInsightBackfillPlan | null> {
  const rows = await query<FinanceInsightBackfillPlan>(
    client,
    `SELECT id, connector_id AS "connectorId", idempotency_key AS "idempotencyKey",
             horizon_months AS "horizonMonths", coverage_start AS "coverageStart",
             coverage_end AS "coverageEnd", currency,
             bridge_contract_version AS "bridgeContractVersion",
             window_count AS "windowCount", next_window_ordinal AS "nextWindowOrdinal",
             status
     FROM finance_insight_transaction_backfill_plans
     WHERE connector_id = $1 AND idempotency_key = $2`,
    [connectorId, idempotencyKey],
  );
  return rows[0] ?? null;
}

function createBackfillPersistence(pool: Pool): FinanceInsightBackfillPersistence {
  return {
    async assertDeliveryDisabled(connectorId: string) {
      await assertDeliveryDisabledAsync(pool, connectorId);
    },

    async loadPlan(connectorId: string, idempotencyKey: string) {
      return loadPlanAsync(pool, connectorId, idempotencyKey);
    },

    async createPlan(input) {
      return transaction(pool, async (client) => {
         await lockFinanceScope(client, `backfill-plan:${input.idempotencyKey}`, input.connectorId);
         await assertDeliveryDisabledAsync(client, input.connectorId);
         const existing = await loadPlanAsync(client, input.connectorId, input.idempotencyKey);
         if (existing) return existing;
         const identity = {
           connectorId: input.connectorId,
           idempotencyKey: input.idempotencyKey,
           horizonMonths: input.horizonMonths,
           coverageStart: input.coverageStart,
           coverageEnd: input.coverageEnd,
           currency: input.currency,
           bridgeContractVersion: input.bridgeContractVersion,
         };
         const id = `finance-insight-backfill-v1:${stableValue(identity)}`;
         await client.query(
           `INSERT INTO finance_insight_transaction_backfill_plans (
              id, connector_id, idempotency_key, horizon_months, coverage_start,
              coverage_end, currency, bridge_contract_version, window_count,
              next_window_ordinal, status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 'running', $10, $10)`,
           [
             id,
             input.connectorId,
             input.idempotencyKey,
             input.horizonMonths,
             input.coverageStart,
             input.coverageEnd,
             input.currency,
             input.bridgeContractVersion,
             input.windowCount,
             input.now,
           ],
         );
         return (await loadPlanAsync(client, input.connectorId, input.idempotencyKey))!;
      });
    },

    async loadWindowProofs(planId: string): Promise<FinanceInsightBackfillWindowProof[]> {
      return query<FinanceInsightBackfillWindowProof>(
         pool,
         `SELECT window_ordinal AS "windowOrdinal", generation_ref AS "generationRef",
                 window_start AS "windowStart", window_end AS "windowEnd",
                 source_as_of AS "sourceAsOf", item_count AS "itemCount",
                 content_digest AS "contentDigest", currency,
                 bridge_contract_version AS "bridgeContractVersion"
          FROM finance_insight_transaction_window_proofs
          WHERE plan_id = $1
          ORDER BY window_ordinal`,
         [planId],
      );
    },

    async findPriorWindowTransactionDate(connectorId, planId, upstreamTransactionId) {
      const rows = await query<{ date: string }>(
         pool,
         `SELECT date
          FROM finance_transactions
          WHERE connector_instance_id = $1 AND upstream_transaction_id = $2
            AND last_seen_generation_id IN (
              SELECT generation_ref
              FROM finance_insight_transaction_window_proofs
              WHERE plan_id = $3
            )`,
         [connectorId, upstreamTransactionId, planId],
      );
      return rows[0]?.date ?? null;
    },

    async upsertTransactionPage(command: FinanceInsightBackfillPageCommand) {
      assertBatch(command.transactions.length, 500, 'Finance insight backfill transaction page');
      return transaction(pool, async (client) => {
         const upstreamIds = command.transactions.map((item) => item.id);
         const existingRows = upstreamIds.length === 0
           ? []
           : await query<{ upstreamTransactionId: string; sourceFingerprint: string }>(
             client,
             `SELECT upstream_transaction_id AS "upstreamTransactionId",
                     source_fingerprint AS "sourceFingerprint"
              FROM finance_transactions
              WHERE connector_instance_id = $1
                AND upstream_transaction_id = ANY($2::text[])`,
             [command.connectorId, upstreamIds],
           );
         const existing = new Map(
           existingRows.map((row) => [row.upstreamTransactionId, row.sourceFingerprint]),
         );
         let added = 0;
         let updated = 0;
         for (const item of command.transactions) {
           const fingerprint = transactionFingerprint(item);
           const values = [
             item.date,
             item.amount,
             item.merchant.name,
             item.merchant.logoUrl,
             item.category?.id ?? null,
             item.category?.name ?? null,
             item.account.id,
             item.account.displayName,
             item.account.mask,
             item.isPending,
             item.isRecurring,
             item.notes,
             JSON.stringify(item.tags),
             JSON.stringify(item.tagReferences.map((tag) => tag.id)),
           ] as const;
           if (!existing.has(item.id)) {
             await client.query(
               `INSERT INTO finance_transactions (
                  id, connector_instance_id, upstream_transaction_id, date, amount,
                  merchant_name, merchant_logo_url, category_id, original_category,
                  confirmed_category, account_id, account_name, card_last4,
                  assigned_kid_id, kid_assignment_method, triage_status, flag_reason,
                  is_pending, is_recurring, notes, tags, tag_references,
                  lifecycle_status, deleted_at, provenance_provider,
                  provenance_fetched_at, source_fingerprint, source_url,
                  last_seen_generation_id, first_seen_at, last_seen_at, synced_at
                ) VALUES (
                  $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12,
                  NULL, NULL, 'pending', NULL, $13, $14, $15, $16::jsonb, $17::jsonb,
                  'active', NULL, $18, $19, $20, NULL, $21, $22, $22, $22
                )`,
               [
                 localTransactionId(command.connectorId, item.id),
                 command.connectorId,
                 item.id,
                 ...values,
                 command.provenance.provider,
                 command.provenance.fetchedAt,
                 fingerprint,
                 command.generationRef,
                 command.now,
               ],
             );
             added++;
             existing.set(item.id, fingerprint);
           } else {
             await client.query(
               `UPDATE finance_transactions
                SET date = $1, amount = $2, merchant_name = $3, merchant_logo_url = $4,
                    category_id = $5, original_category = $6, account_id = $7,
                    account_name = $8, card_last4 = $9, is_pending = $10,
                    is_recurring = $11, notes = $12, tags = $13::jsonb,
                    tag_references = $14::jsonb, lifecycle_status = 'active',
                    deleted_at = NULL, provenance_provider = $15,
                    provenance_fetched_at = $16, source_fingerprint = $17,
                    last_seen_generation_id = $18, last_seen_at = $19, synced_at = $19
                WHERE connector_instance_id = $20 AND upstream_transaction_id = $21`,
               [
                 ...values,
                 command.provenance.provider,
                 command.provenance.fetchedAt,
                 fingerprint,
                 command.generationRef,
                 command.now,
                 command.connectorId,
                 item.id,
               ],
             );
             if (existing.get(item.id) !== fingerprint) updated++;
             existing.set(item.id, fingerprint);
           }
         }
         return { added, updated };
      });
    },

    async recordWindowCapture(command: FinanceInsightBackfillWindowCaptureCommand) {
      return transaction(pool, async (client) => {
         await assertDeliveryDisabledAsync(client, command.connectorId);
         await client.query(
           `UPDATE finance_transactions
            SET lifecycle_status = 'deleted', deleted_at = $1, synced_at = $1
            WHERE connector_instance_id = $2
              AND lifecycle_status = 'active'
              AND date >= $3 AND date <= $4
              AND (last_seen_generation_id IS NULL OR last_seen_generation_id <> $5)`,
           [
             command.completedAt,
             command.connectorId,
             command.windowStart,
             command.windowEnd,
             command.generationRef,
           ],
         );
         const facts = await readLiveTransactionFacts(
           client,
           command.connectorId,
           command.windowStart,
           command.windowEnd,
         );
         if (facts.length !== command.expectedItemCount) {
           throw new FinanceInsightBackfillWindowIncompleteError();
         }
         const previousCount = await query<{ itemCount: number }>(
           client,
           `SELECT COALESCE(SUM(item_count), 0) AS "itemCount"
            FROM finance_insight_transaction_window_proofs WHERE plan_id = $1`,
           [command.planId],
         );
         if ((previousCount[0]?.itemCount ?? 0) + facts.length > command.maxTotalItemCount) {
           throw new FinanceInsightBackfillTooLargeError();
         }
         await client.query(
           `INSERT INTO finance_insight_transaction_window_proofs (
              plan_id, connector_id, window_ordinal, generation_ref, window_start,
              window_end, source_as_of, item_count, content_digest, currency,
              bridge_contract_version, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
           [
             command.planId,
             command.connectorId,
             command.windowOrdinal,
             command.generationRef,
             command.windowStart,
             command.windowEnd,
             command.sourceAsOf,
             facts.length,
             financeInsightDigestV1(facts as unknown as CanonicalJsonValue),
             command.currency,
             command.bridgeContractVersion,
             command.completedAt,
           ],
         );
         const nextOrdinal = command.windowOrdinal + 1;
         const completed = nextOrdinal === command.planWindowCount;
         await client.query(
           `UPDATE finance_insight_transaction_backfill_plans
            SET next_window_ordinal = $1, status = $2, last_error_code = NULL,
                completed_at = $3, updated_at = $4
            WHERE id = $5`,
           [
             nextOrdinal,
             completed ? 'completed' : 'running',
             completed ? command.completedAt : null,
             command.completedAt,
             command.planId,
           ],
         );
         return { itemCount: facts.length };
      });
    },

    async recordPlanFailure(planId: string, errorCode: string, now: string) {
      await query(
         pool,
         `UPDATE finance_insight_transaction_backfill_plans
          SET last_error_code = $1, updated_at = $2 WHERE id = $3`,
         [errorCode, now, planId],
      );
    },

    async promoteCompletedPlan(command: FinanceInsightBackfillPromotionCommand) {
      return transaction(pool, async (client) => {
         await lockFinanceScope(client, `backfill-plan:${command.idempotencyKey}`, command.connectorId);
         await assertDeliveryDisabledAsync(client, command.connectorId);
         const current = await loadPlanAsync(client, command.connectorId, command.idempotencyKey);
         if (!current || current.id !== command.planId || current.status !== 'completed') {
           throw new FinanceInsightBackfillPlanUnavailableError();
         }
         const existingStateRows = await query<{
           generationId: string;
           sourceAsOf: string;
           itemCount: number;
           contentDigest: string;
           coverageStart: string;
           coverageEnd: string;
           windowCount: number;
           windowsDigest: string;
           bridgeContractVersion: string;
         }>(
           client,
           `SELECT successful_generation_id AS "generationId",
                   source_as_of AS "sourceAsOf", item_count AS "itemCount",
                   content_digest AS "contentDigest", coverage_start AS "coverageStart",
                   coverage_end AS "coverageEnd", window_count AS "windowCount",
                   windows_digest AS "windowsDigest",
                   bridge_contract_version AS "bridgeContractVersion"
            FROM finance_insight_transaction_projection_state
            WHERE connector_id = $1 AND status = 'succeeded'`,
           [command.connectorId],
         );
         const existingState = existingStateRows[0];
         if (existingState?.generationId === command.generationId) {
           const storedFacts = await query<{ payload: unknown }>(
             client,
             `SELECT payload FROM finance_insight_transaction_projection_facts
              WHERE connector_id = $1 AND generation_id = $2
              ORDER BY source_ref`,
             [command.connectorId, command.generationId],
           );
           const storedWindows = await query<FinanceInsightWindowProof>(
             client,
             `SELECT window_index AS "index", coverage_start AS "start",
                     coverage_end AS "end", source_as_of AS "sourceAsOf",
                     item_count AS "itemCount", content_digest AS "digest"
              FROM finance_insight_transaction_projection_windows
              WHERE connector_id = $1 AND generation_id = $2
              ORDER BY window_index`,
             [command.connectorId, command.generationId],
           );
           if (
             existingState.sourceAsOf !== command.sourceAsOf
             || existingState.itemCount !== command.itemCount
             || existingState.contentDigest !== command.contentDigest
             || existingState.coverageStart !== command.coverageStart
             || existingState.coverageEnd !== command.coverageEnd
             || existingState.windowCount !== command.windowCount
             || existingState.windowsDigest !== command.windowsDigest
             || existingState.bridgeContractVersion !== command.bridgeContractVersion
             || financeInsightDigestV1(storedFacts.map((row) => row.payload) as unknown as CanonicalJsonValue)
               !== command.contentDigest
             || financeInsightDigestV1(storedWindows as unknown as CanonicalJsonValue)
               !== command.windowsDigest
           ) {
             throw new FinanceInsightBackfillProjectionConflictError();
           }
           return { promoted: false };
         }
         if (existingState) {
           throw new FinanceInsightBackfillProjectionConflictError();
         }
         await client.query(
           `DELETE FROM finance_insight_transaction_projection_facts
            WHERE connector_id = $1 AND generation_id = $2`,
           [command.connectorId, command.generationId],
         );
         await client.query(
           `DELETE FROM finance_insight_transaction_projection_windows
            WHERE connector_id = $1 AND generation_id = $2`,
           [command.connectorId, command.generationId],
         );
         for (const fact of command.facts) {
           const parsed = fact as { sourceRef: string; occurredOn: string };
           await client.query(
             `INSERT INTO finance_insight_transaction_projection_facts (
                connector_id, generation_id, source_ref, occurred_on, payload
              ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
             [
               command.connectorId,
               command.generationId,
               parsed.sourceRef,
               parsed.occurredOn,
               JSON.stringify(fact),
             ],
           );
         }
         for (const proof of command.windows) {
           await client.query(
             `INSERT INTO finance_insight_transaction_projection_windows (
                connector_id, generation_id, window_index, coverage_start,
                coverage_end, source_as_of, item_count, content_digest
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
             [
               command.connectorId,
               command.generationId,
               proof.index,
               proof.start,
               proof.end,
               proof.sourceAsOf,
               proof.itemCount,
               proof.digest,
             ],
           );
         }
         await client.query(
           `INSERT INTO finance_insight_transaction_projection_state (
              connector_id, status, current_attempt_id, last_attempt_at,
              last_successful_at, successful_generation_id, source_as_of,
              item_count, content_digest, coverage_start, coverage_end,
              window_count, windows_digest, bridge_contract_version,
              last_error_code, created_at, updated_at
            ) VALUES (
              $1, 'succeeded', NULL, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $2, $2
            )
            ON CONFLICT (connector_id) DO UPDATE SET
              status = 'succeeded',
              current_attempt_id = NULL,
              last_attempt_at = EXCLUDED.last_attempt_at,
              last_successful_at = EXCLUDED.last_successful_at,
              successful_generation_id = EXCLUDED.successful_generation_id,
              source_as_of = EXCLUDED.source_as_of,
              item_count = EXCLUDED.item_count,
              content_digest = EXCLUDED.content_digest,
              coverage_start = EXCLUDED.coverage_start,
              coverage_end = EXCLUDED.coverage_end,
              window_count = EXCLUDED.window_count,
              windows_digest = EXCLUDED.windows_digest,
              bridge_contract_version = EXCLUDED.bridge_contract_version,
              last_error_code = NULL,
              updated_at = EXCLUDED.updated_at`,
           [
             command.connectorId,
             command.completedAt,
             command.generationId,
             command.sourceAsOf,
             command.itemCount,
             command.contentDigest,
             command.coverageStart,
             command.coverageEnd,
             command.windowCount,
             command.windowsDigest,
             command.bridgeContractVersion,
           ],
         );
         await client.query(
           `DELETE FROM finance_insight_transaction_projection_facts
            WHERE connector_id = $1 AND generation_id <> $2`,
           [command.connectorId, command.generationId],
         );
         await client.query(
           `DELETE FROM finance_insight_transaction_projection_windows
            WHERE connector_id = $1 AND generation_id <> $2`,
           [command.connectorId, command.generationId],
         );
         return { promoted: true };
      });
    },
  };
}

// ─── Publication ────────────────────────────────────────────────────────────

function createPublicationPersistence(pool: Pool): FinanceInsightPublicationPersistence {
  return {
    async readCurrentState(connectorId: string) {
      const rows = await query<FinanceInsightPublicationState>(
         pool,
         `SELECT latest_publication_id AS "publicationId",
                 latest_generation_identity AS "generationIdentity",
                 last_source_sequence AS "sourceSequence"
          FROM finance_insight_publication_state WHERE connector_id = $1`,
         [connectorId],
      );
      return rows[0] ?? null;
    },

    async capture(command: FinanceInsightPublicationCaptureCommand): Promise<FinanceInsightPublicationCaptureResult> {
      return transaction(pool, async (client) => {
         await lockFinanceScope(client, 'publication', command.connectorId);
         const stateRows = await query<{
           publicationId: string | null;
           generationIdentity: string | null;
           sourceSequence: number;
         }>(
           client,
           `SELECT latest_publication_id AS "publicationId",
                   latest_generation_identity AS "generationIdentity",
                   last_source_sequence AS "sourceSequence"
            FROM finance_insight_publication_state WHERE connector_id = $1
            FOR UPDATE`,
           [command.connectorId],
         );
         const state = stateRows[0];
         if (state?.publicationId && state.generationIdentity === command.generationIdentity) {
           await client.query(
             `UPDATE finance_insight_publication_state
              SET last_capture_attempt_at = $1, last_capture_outcome = 'idempotent',
                  last_error_code = NULL, updated_at = $1
              WHERE connector_id = $2`,
             [command.capturedAt, command.connectorId],
           );
           return {
             status: 'idempotent' as const,
             publicationId: state.publicationId,
             sourceSequence: state.sourceSequence,
           };
         }
         const expectedSourceSequence = (state?.sourceSequence ?? 0) + 1;
         if (expectedSourceSequence !== command.expectedSourceSequence) {
           return { status: 'conflict' as const };
         }
         await client.query(
           `INSERT INTO finance_insight_publications (
              id, connector_id, source_sequence, generation_identity, contract_version,
              provider_type, source_as_of, coverage_start, coverage_end, currency,
              bridge_contract_version, captured_constituents, manifest, manifest_digest,
              create_request, idempotency_key, alert_capable, captured_at, expires_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14,
              $15::jsonb, $16, true, $17, $18)`,
           [
             command.publicationId,
             command.connectorId,
             command.expectedSourceSequence,
             command.generationIdentity,
             command.contractVersion,
             command.providerType,
             command.sourceAsOf,
             command.coverageStart,
             command.coverageEnd,
             command.currency,
             command.bridgeContractVersion,
             JSON.stringify(command.capturedConstituents),
             JSON.stringify(command.manifest),
             command.manifestDigest,
             JSON.stringify(command.createRequest),
             command.idempotencyKey,
             command.capturedAt,
             command.expiresAt,
           ],
         );
         for (const fact of command.facts) {
           await client.query(
             `INSERT INTO finance_insight_publication_facts (
                publication_id, kind, source_ref, batch_index, fact_index, payload
              ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
             [
               command.publicationId,
               fact.kind,
               fact.sourceRef,
               fact.batchIndex,
               fact.factIndex,
               JSON.stringify(fact.payload),
             ],
           );
         }
         await client.query(
           `INSERT INTO finance_insight_publication_state (
              connector_id, provider_type, latest_publication_id,
              latest_generation_identity, last_source_sequence,
              last_capture_attempt_at, last_capture_outcome, last_error_code,
              created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 'captured', NULL, $6, $6)
            ON CONFLICT (connector_id) DO UPDATE SET
              provider_type = EXCLUDED.provider_type,
              latest_publication_id = EXCLUDED.latest_publication_id,
              latest_generation_identity = EXCLUDED.latest_generation_identity,
              last_source_sequence = EXCLUDED.last_source_sequence,
              last_capture_attempt_at = EXCLUDED.last_capture_attempt_at,
              last_capture_outcome = 'captured',
              last_error_code = NULL,
              updated_at = EXCLUDED.updated_at`,
           [
             command.connectorId,
             command.providerType,
             command.publicationId,
             command.generationIdentity,
             command.expectedSourceSequence,
             command.capturedAt,
           ],
         );
         await client.query(
           `DELETE FROM finance_insight_publications
            WHERE connector_id = $1
              AND id NOT IN (
                SELECT id FROM finance_insight_publications
                WHERE connector_id = $1
                ORDER BY source_sequence DESC
                LIMIT $2
              )`,
           [command.connectorId, command.cacheCount],
         );
         await client.query(
           `DELETE FROM finance_insight_publications
            WHERE connector_id = $1 AND expires_at < $2 AND id <> $3`,
           [command.connectorId, command.capturedAt, command.publicationId],
         );
         return {
           status: 'captured' as const,
           publicationId: command.publicationId,
           sourceSequence: command.expectedSourceSequence,
         };
      });
    },

    async recordOutcome(input) {
      await transaction(pool, async (client) => {
         await lockFinanceScope(client, 'publication', input.connectorId);
         await client.query(
           `INSERT INTO finance_insight_publication_state (
              connector_id, provider_type, last_capture_attempt_at, last_capture_outcome,
              last_error_code, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $3, $3)
            ON CONFLICT (connector_id) DO UPDATE SET
              provider_type = EXCLUDED.provider_type,
              last_capture_attempt_at = EXCLUDED.last_capture_attempt_at,
              last_capture_outcome = EXCLUDED.last_capture_outcome,
              last_error_code = EXCLUDED.last_error_code,
              updated_at = EXCLUDED.updated_at`,
           [input.connectorId, input.providerType, input.now, input.outcome, input.code],
         );
      });
    },

    async loadLatest(connectorId: string, publicationId: string | null, now: string) {
      const rows = await query<{
         id: string;
         createRequest: unknown;
         manifestDigest: string;
         sourceAsOf: string;
         alertCapable: boolean;
         expiresAt: string;
      }>(
         pool,
         `SELECT id, create_request AS "createRequest", manifest_digest AS "manifestDigest",
                 source_as_of AS "sourceAsOf", alert_capable AS "alertCapable",
                 expires_at AS "expiresAt"
          FROM finance_insight_publications
          WHERE connector_id = $1 AND ($2::text IS NULL OR id = $2)
          ORDER BY source_sequence DESC
          LIMIT 1`,
         [connectorId, publicationId],
      );
      const row = rows[0];
      if (!row || Date.parse(row.expiresAt) < Date.parse(now)) return null;
      const facts = await query<{
         kind: string;
         sourceRef: string;
         batchIndex: number;
         factIndex: number;
         payload: unknown;
      }>(
         pool,
         `SELECT kind, source_ref AS "sourceRef", batch_index AS "batchIndex",
                 fact_index AS "factIndex", payload
          FROM finance_insight_publication_facts
          WHERE publication_id = $1
          ORDER BY kind, batch_index, fact_index`,
         [row.id],
      );
      const record: FinanceInsightPublicationRecord = {
         id: row.id,
         createRequest: row.createRequest,
         manifestDigest: row.manifestDigest,
         sourceAsOf: row.sourceAsOf,
         alertCapable: row.alertCapable,
         expiresAt: row.expiresAt,
      };
      return {
         record,
         facts: facts.map((fact) => ({
           kind: fact.kind,
           sourceRef: fact.sourceRef,
           batchIndex: fact.batchIndex,
           factIndex: fact.factIndex,
           payload: fact.payload,
         })),
      };
    },
  };
}

// ─── Delivery checkpoints ───────────────────────────────────────────────────

function createDeliveryPersistence(pool: Pool): FinanceInsightDeliveryPersistence {
  return {
    async findContinuationPublicationId(connectorId: string) {
      const rows = await query<{ publicationId: string }>(
         pool,
         `SELECT publication_id AS "publicationId"
          FROM finance_insight_publication_delivery
          WHERE connector_id = $1
            AND (
              evaluation_state IN ('queued', 'evaluating')
              OR last_error_retryable = true
            )
          ORDER BY source_sequence DESC
          LIMIT 1`,
         [connectorId],
      );
      return rows[0]?.publicationId ?? null;
    },

    async ensureState(input) {
      await query(
         pool,
         `INSERT INTO finance_insight_publication_delivery (
            publication_id, connector_id, source_sequence, stage, next_batch_ordinal,
            last_error_retryable, created_at, updated_at
          ) VALUES ($1, $2, $3, 'captured', 0, false, $4, $4)
          ON CONFLICT (publication_id) DO NOTHING`,
         [input.publicationId, input.connectorId, input.sourceSequence, input.now],
      );
      const rows = await query<FinanceInsightDeliveryState>(
         pool,
         `SELECT stage, next_batch_ordinal AS "nextBatchOrdinal",
                 detector_set_version AS "detectorSetVersion",
                 policy_version AS "policyVersion",
                 evaluation_sequence AS "evaluationSequence"
          FROM finance_insight_publication_delivery
          WHERE publication_id = $1 AND connector_id = $2 AND source_sequence = $3`,
         [input.publicationId, input.connectorId, input.sourceSequence],
      );
      if (!rows[0]) {
         throw new Error('Finance insight delivery checkpoint is unavailable');
      }
      return rows[0];
    },

    async markStaging(input) {
      await query(
         pool,
         `UPDATE finance_insight_publication_delivery
          SET stage = CASE
                WHEN stage IN ('captured', 'staging') THEN 'staging'
                ELSE stage
              END,
              last_attempt_at = $1, last_error_code = NULL,
              last_error_retryable = false, updated_at = $1
          WHERE publication_id = $2`,
         [input.now, input.publicationId],
      );
    },

    async advanceBatch(input) {
      await query(
         pool,
         `UPDATE finance_insight_publication_delivery
          SET stage = CASE
                WHEN stage IN ('captured', 'staging', 'uploading') THEN 'uploading'
                ELSE stage
              END,
              next_batch_ordinal = GREATEST(next_batch_ordinal, $1),
              last_successful_at = $2, updated_at = $2
          WHERE publication_id = $3`,
         [input.nextBatchOrdinal, input.now, input.publicationId],
      );
    },

    async markCommitted(input) {
      await query(
         pool,
         `UPDATE finance_insight_publication_delivery
          SET stage = CASE
                WHEN stage = 'evaluation-requested' THEN stage
                ELSE 'committed'
              END,
              detector_set_version = $1, policy_version = $2,
              last_successful_at = $3, last_error_code = NULL,
              last_error_retryable = false, updated_at = $3
          WHERE publication_id = $4`,
         [input.detectorSetVersion, input.policyVersion, input.now, input.publicationId],
      );
    },

    async readMaxEvaluationSequence(input) {
      const rows = await query<{ sequence: number | null }>(
         pool,
         `SELECT MAX(evaluation_sequence) AS sequence
          FROM finance_insight_publication_delivery
          WHERE connector_id = $1 AND publication_id <> $2`,
         [input.connectorId, input.excludingPublicationId],
      );
      return rows[0]?.sequence ?? null;
    },

    async recordEvaluationOutcome(input) {
      if (input.succeeded) {
         await query(
           pool,
           `UPDATE finance_insight_publication_delivery
            SET stage = 'evaluation-requested', evaluation_sequence = $1,
                evaluation_state = $2, evaluation_idempotency_key = $3,
                last_attempt_at = $4, last_successful_at = $4, last_error_code = NULL,
                last_error_retryable = false, updated_at = $4
            WHERE publication_id = $5`,
           [
             input.evaluationSequence,
             input.evaluationState,
             input.evaluationIdempotencyKey,
             input.now,
             input.publicationId,
           ],
         );
         return;
      }
      await query(
         pool,
         `UPDATE finance_insight_publication_delivery
          SET stage = 'evaluation-requested', evaluation_sequence = $1,
              evaluation_state = $2, evaluation_idempotency_key = $3,
              last_attempt_at = $4, last_error_code = $5,
              last_error_retryable = $6, updated_at = $4
          WHERE publication_id = $7`,
         [
           input.evaluationSequence,
           input.evaluationState,
           input.evaluationIdempotencyKey,
           input.now,
           input.errorCode,
           input.retryable,
           input.publicationId,
         ],
      );
    },

    async recordFailure(input) {
      await query(
         pool,
         `UPDATE finance_insight_publication_delivery
          SET last_attempt_at = $1, last_error_code = $2, last_error_retryable = $3, updated_at = $1
          WHERE publication_id = $4`,
         [input.now, input.code, input.retryable, input.publicationId],
      );
    },
  };
}

// ─── Occurrence cache ───────────────────────────────────────────────────────

function createOccurrenceCachePersistence(pool: Pool): FinanceInsightOccurrenceCachePersistence {
  return {
    async prune(now: string, payloadCutoff: string, tombstoneCutoff: string) {
      await transaction(pool, async (client) => {
         await client.query(
           `UPDATE finance_insight_occurrences
            SET entity_label = '', headline = '', target_descriptors = '[]'::jsonb,
                summary_payload = NULL
            WHERE cached_at < $1`,
           [payloadCutoff],
         );
         await client.query(
           `DELETE FROM finance_insight_occurrences
            WHERE is_tombstone = true
              AND source_lifecycle IN ('resolved', 'superseded')
              AND source_updated_at < $1`,
           [tombstoneCutoff],
         );
         await client.query(
           `DELETE FROM finance_insight_occurrences
            WHERE connector_id IN (
              SELECT connector_id FROM finance_insight_occurrence_cache_state
              WHERE purge_after < $1
            )`,
           [now],
         );
         await client.query(
           `DELETE FROM finance_insight_occurrence_cache_state WHERE purge_after < $1`,
           [now],
         );
      });
    },

    async replace(input) {
      const items: readonly FinanceInsightOccurrenceReplaceItem[] = input.items;
      await transaction(pool, async (client) => {
         await lockFinanceScope(client, 'occurrence-cache', input.connectorId);
         const previousStateRows = await query<{
           sourceGeneration: string;
           sourceSequence: number;
           sourceAsOf: string;
           summaryExpiresAt: string;
         }>(
           client,
           `SELECT source_generation AS "sourceGeneration", source_sequence AS "sourceSequence",
                   source_as_of AS "sourceAsOf",
                   summary_expires_at AS "summaryExpiresAt"
            FROM finance_insight_occurrence_cache_state WHERE connector_id = $1
            FOR UPDATE`,
           [input.connectorId],
         );
         const previousState = previousStateRows[0];
         if (previousState) {
           const previousSourceAsOf = Date.parse(previousState.sourceAsOf);
           const sourceAsOfTime = Date.parse(input.sourceAsOf);
           if (
             previousState.sourceSequence > 0
             && previousState.sourceGeneration === input.sourceGeneration
             && (
               previousState.sourceSequence !== input.sourceSequence
               || previousState.sourceAsOf !== input.sourceAsOf
             )
           ) {
             throw new Error('Finance insight occurrence cache identity is immutable');
           }
           if (
             input.sourceSequence < previousState.sourceSequence
             || sourceAsOfTime < previousSourceAsOf
           ) {
             throw new Error('Finance insight occurrence cache generation is stale');
           }
           if (
             input.sourceSequence === previousState.sourceSequence
             && previousState.sourceGeneration !== input.sourceGeneration
           ) {
             throw new Error('Finance insight occurrence cache generation conflicts');
           }
         }
         const previousRows = await query<{
           occurrenceId: string;
           deliveryRevision: number;
           revisionDigest: string;
           isTombstone: boolean;
           summaryPayload: unknown | null;
           sourceGeneration: string;
           sourceSequence: number;
           sourceLifecycle: string | null;
           sourceUpdatedAt: string;
         }>(
           client,
           `SELECT occurrence_id AS "occurrenceId", delivery_revision AS "deliveryRevision",
                   revision_digest AS "revisionDigest", summary_payload AS "summaryPayload",
                   source_generation AS "sourceGeneration", source_sequence AS "sourceSequence",
                   is_tombstone AS "isTombstone",
                   source_lifecycle AS "sourceLifecycle", source_updated_at AS "sourceUpdatedAt"
            FROM finance_insight_occurrences WHERE connector_id = $1`,
           [input.connectorId],
         );
         const previousByOccurrence = new Map(
           previousRows.map((row) => [row.occurrenceId, row]),
         );
         const previousCurrentRowCount = previousRows.filter(
           (row) => row.sourceGeneration === input.sourceGeneration && !row.isTombstone,
         ).length;
         for (const item of items) {
           const previous = previousByOccurrence.get(item.occurrenceId);
           if (previous && item.deliveryRevision < previous.deliveryRevision) {
             throw new Error('Finance insight occurrence cache revision is stale');
           }
           if (previous && Date.parse(item.updatedAt) < Date.parse(previous.sourceUpdatedAt)) {
             throw new Error('Finance insight occurrence cache revision is stale');
           }
           const previousRevisionDigest = previous?.revisionDigest || (
             previous?.summaryPayload
               ? financeInsightOccurrenceRevisionDigest(previous.summaryPayload)
               : null
           );
           if (
             previous
             && item.deliveryRevision === previous.deliveryRevision
             && item.revisionDigest !== previousRevisionDigest
           ) {
             throw new Error('Finance insight occurrence cache revision conflicts');
           }
           if (
             previous
             && item.deliveryRevision === previous.deliveryRevision
             && previous.sourceLifecycle !== 'open'
             && item.sourceLifecycle === 'open'
           ) {
             throw new Error('Finance insight occurrence cache lifecycle is stale');
           }
         }
         if (
           previousState?.sourceGeneration === input.sourceGeneration
           && previousState.sourceSequence === input.sourceSequence
           && previousState.sourceAsOf === input.sourceAsOf
           && previousCurrentRowCount === items.length
           && items.every((item) => (
             JSON.stringify(previousByOccurrence.get(item.occurrenceId)?.summaryPayload ?? null)
               === JSON.stringify(item.summaryPayload)
             && previousByOccurrence.get(item.occurrenceId)?.sourceGeneration
               === input.sourceGeneration
             && previousByOccurrence.get(item.occurrenceId)?.sourceSequence
               === input.sourceSequence
             && previousByOccurrence.get(item.occurrenceId)?.revisionDigest
               === item.revisionDigest
           ))
         ) {
           await client.query(
             `UPDATE finance_insight_occurrences
              SET cached_at = $1
              WHERE connector_id = $2 AND source_generation = $3 AND is_tombstone = false`,
             [input.refreshedAt, input.connectorId, input.sourceGeneration],
           );
           await client.query(
             `UPDATE finance_insight_occurrence_cache_state
              SET refreshed_at = $1, updated_at = $1
              WHERE connector_id = $2`,
             [input.refreshedAt, input.connectorId],
           );
           return;
         }
         await client.query(
           `DELETE FROM finance_insight_occurrences
            WHERE connector_id = $1
              AND (source_lifecycle IS NULL OR source_lifecycle NOT IN ('resolved', 'superseded'))`,
           [input.connectorId],
         );
         await client.query(
           `UPDATE finance_insight_occurrences
            SET is_tombstone = true
            WHERE connector_id = $1
              AND source_lifecycle IN ('resolved', 'superseded')`,
           [input.connectorId],
         );
         for (const item of items) {
           await client.query(
             `INSERT INTO finance_insight_occurrences (
                connector_id, occurrence_id, source_generation, source_sequence, is_tombstone,
                insight_id, delivery_revision, revision_digest, kind,
                entity_kind, entity_source_ref, entity_label, analysis_state,
                source_lifecycle, severity, confidence, baseline_sufficiency, headline,
                freshness_state, source_as_of, target_descriptors, summary_payload,
                source_updated_at, cached_at
              ) VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                $16, $17, $18, $19, $20::jsonb, $21::jsonb, $22, $23)
              ON CONFLICT (connector_id, occurrence_id) DO UPDATE SET
                source_generation = EXCLUDED.source_generation,
                source_sequence = EXCLUDED.source_sequence,
                is_tombstone = false,
                insight_id = EXCLUDED.insight_id,
                delivery_revision = EXCLUDED.delivery_revision,
                revision_digest = EXCLUDED.revision_digest,
                kind = EXCLUDED.kind,
                entity_kind = EXCLUDED.entity_kind,
                entity_source_ref = EXCLUDED.entity_source_ref,
                entity_label = EXCLUDED.entity_label,
                analysis_state = EXCLUDED.analysis_state,
                source_lifecycle = EXCLUDED.source_lifecycle,
                severity = EXCLUDED.severity,
                confidence = EXCLUDED.confidence,
                baseline_sufficiency = EXCLUDED.baseline_sufficiency,
                headline = EXCLUDED.headline,
                freshness_state = EXCLUDED.freshness_state,
                source_as_of = EXCLUDED.source_as_of,
                target_descriptors = EXCLUDED.target_descriptors,
                summary_payload = EXCLUDED.summary_payload,
                source_updated_at = EXCLUDED.source_updated_at,
                cached_at = EXCLUDED.cached_at`,
             [
               input.connectorId,
               item.occurrenceId,
               input.sourceGeneration,
               input.sourceSequence,
               item.insightId,
               item.deliveryRevision,
               item.revisionDigest,
               item.kind,
               item.entityKind,
               item.entitySourceRef,
               item.entityLabel,
               item.analysisState,
               item.sourceLifecycle,
               item.severity,
               item.confidence,
               item.baselineSufficiency,
               item.headline,
               item.freshnessState,
               item.freshnessSourceAsOf,
               JSON.stringify(item.targetDescriptors),
               JSON.stringify(item.summaryPayload),
               item.updatedAt,
               input.refreshedAt,
             ],
           );
         }
         await client.query(
           `UPDATE finance_insight_occurrences
            SET entity_label = '', headline = '', target_descriptors = '[]'::jsonb,
                summary_payload = NULL
            WHERE connector_id = $1
              AND is_tombstone = true
              AND source_lifecycle IN ('resolved', 'superseded')`,
           [input.connectorId],
         );
         await client.query(
           `DELETE FROM finance_insight_occurrences
            WHERE ctid IN (
              SELECT ctid FROM finance_insight_occurrences
              WHERE connector_id = $1
                AND is_tombstone = true
                AND source_lifecycle IN ('resolved', 'superseded')
              ORDER BY source_updated_at DESC, occurrence_id DESC
              OFFSET $2
            )`,
           [input.connectorId, input.tombstoneLimit],
         );
         await client.query(
           `INSERT INTO finance_insight_occurrence_cache_state (
              connector_id, source_generation, item_count, source_as_of, refreshed_at,
              source_sequence, summary_expires_at, purge_after, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $5, $5)
            ON CONFLICT (connector_id) DO UPDATE SET
              source_generation = EXCLUDED.source_generation,
              source_sequence = EXCLUDED.source_sequence,
              item_count = EXCLUDED.item_count,
              source_as_of = EXCLUDED.source_as_of,
              refreshed_at = EXCLUDED.refreshed_at,
              summary_expires_at = EXCLUDED.summary_expires_at,
              purge_after = EXCLUDED.purge_after,
              updated_at = EXCLUDED.updated_at`,
           [
             input.connectorId,
             input.sourceGeneration,
             items.length,
             input.sourceAsOf,
             input.refreshedAt,
             input.sourceSequence,
             input.summaryExpiresAt,
             input.purgeAfter,
           ],
         );
      });
    },

    async readState(connectorId: string): Promise<FinanceInsightOccurrenceCacheState | null> {
      const rows = await query<FinanceInsightOccurrenceCacheState>(
         pool,
         `SELECT source_generation AS "sourceGeneration", source_sequence AS "sourceSequence",
                 source_as_of AS "sourceAsOf",
                 summary_expires_at AS "summaryExpiresAt", purge_after AS "purgeAfter"
          FROM finance_insight_occurrence_cache_state WHERE connector_id = $1`,
         [connectorId],
      );
      return rows[0] ?? null;
    },

    async readCurrentGenerationRows(
      connectorId: string,
      sourceGeneration: string,
      limit: number,
    ): Promise<FinanceInsightOccurrenceMetadataRow[]> {
      const rows = await query<{
         occurrenceId: string;
         insightId: string;
         kind: string;
         sourceLifecycle: string | null;
         updatedAt: string;
         summaryPayload: unknown | null;
      }>(
         pool,
         `SELECT occurrence_id AS "occurrenceId", insight_id AS "insightId", kind,
                 source_lifecycle AS "sourceLifecycle", source_updated_at AS "updatedAt",
                 summary_payload AS "summaryPayload"
          FROM finance_insight_occurrences
          WHERE connector_id = $1 AND source_generation = $2 AND is_tombstone = false
          ORDER BY source_updated_at DESC, occurrence_id
          LIMIT $3`,
         [connectorId, sourceGeneration, limit],
      );
      return rows;
    },
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────

export function createPostgresFinanceInsightPersistence(
  pool: Pool,
): Omit<FinanceInsightPersistence, 'notifications'> {
  return {
    connectors: createConnectorPersistence(pool),
    projection: createProjectionPersistence(pool),
    backfill: createBackfillPersistence(pool),
    publication: createPublicationPersistence(pool),
    delivery: createDeliveryPersistence(pool),
    occurrenceCache: createOccurrenceCachePersistence(pool),
  };
}
