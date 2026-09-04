import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  FINANCE_ATTRIBUTION_READ_MAX,
  FINANCE_ATTRIBUTION_WRITE_MAX,
  FinanceAttributionFenceError,
  FinanceAttributionMutationError,
  type FinanceAttributionApplyItem,
  type FinanceAttributionExceptionActionCommand,
  type FinanceAttributionExceptionView,
  type FinanceAttributionManualDecisionCommand,
  type FinanceAttributionPersistence,
  type FinanceAttributionRow,
  type FinanceAttributionSubjectView,
  type FinanceAttributionUnavailableItem,
  type FinanceManualAction,
} from '@/db/persistence/finance-attribution';
import {
  FinanceDatasetFenceError,
  type FinanceBudgetPublicationCommand,
  type FinanceDataset,
  type FinanceDatasetPersistence,
  type FinanceDatasetPublicationMetadata,
  type FinanceDatasetPublishResult,
  type FinanceDatasetState,
  type FinanceRecurringPublicationCommand,
  type FinanceReferenceDataset,
  type FinanceReferenceDatasetItem,
} from '@/db/persistence/finance-datasets';
import {
  FINANCE_TRANSACTION_PAGE_MAX,
  FinanceSnapshotFenceError,
  type FinanceSnapshotPersistence,
  type FinanceSnapshotTransaction,
} from '@/db/persistence/finance-snapshot';
import {
  FINANCE_IDENTITY_NAMESPACE_CREDENTIAL,
  type FinanceCorePersistence,
} from '@/db/persistence/finance-worker';
import { financeInsightDigestV1, type CanonicalJsonValue } from '@/lib/finance-insights/canonical';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';
import { MONARCH_BRIDGE_CONTRACT_VERSION } from '@/lib/connectors/monarch-money/constants';
import { createPostgresFinanceAssistantPersistence } from './finance-assistant-repository';
import { readPostgresFinanceInsightProjectionFacts } from './finance-insights-repositories';

type Client = Pool | PoolClient;

interface PostgresFinanceAdapterOptions {
  idFactory?: () => string;
}

const identityNamespacePattern = /^[a-f0-9]{64}$/;

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

async function readDatasetProjectionProof(
  client: PoolClient,
  connectorId: string,
  dataset: FinanceDataset,
): Promise<{
  itemCount: number;
  contentDigest: string;
  bridgeContractVersion: string;
} | null> {
  const kind = dataset === 'accounts'
    ? 'account'
    : dataset === 'categories'
      ? 'category'
      : dataset === 'tags'
        ? 'tag'
        : dataset === 'recurring'
          ? 'recurring'
          : null;
  if (!kind) return null;
  const facts = (
    await readPostgresFinanceInsightProjectionFacts(client, connectorId, '', kind, undefined)
  )[kind];
  return {
    itemCount: facts.length,
    contentDigest: financeInsightDigestV1(facts as unknown as CanonicalJsonValue),
    bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
  };
}

function localId(prefix: string, connectorId: string, upstreamId: string): string {
  return `finance:${prefix}:${connectorId}:${upstreamId}`;
}

function localTransactionId(connectorId: string, upstreamId: string): string {
  return `finance:${connectorId}:${upstreamId}`;
}

function stableValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function transactionFingerprint(value: FinanceSnapshotTransaction): string {
  return stableValue(value);
}

function assertBatch(size: number, maximum: number, label: string): void {
  if (size > maximum) {
    throw new RangeError(`${label} exceeds the maximum batch size of ${maximum}`);
  }
}

function assertDatasetBatch(size: number, sourceLimit: number): void {
  if (!Number.isSafeInteger(sourceLimit) || sourceLimit < 1 || size > sourceLimit) {
    throw new RangeError(`Finance dataset exceeds its source limit of ${sourceLimit}`);
  }
}

function acceptedNamespace(credentials: unknown): string {
  const value = (credentials as Record<string, unknown> | null)?.[
    FINANCE_IDENTITY_NAMESPACE_CREDENTIAL
  ];
  if (typeof value !== 'string' || !identityNamespacePattern.test(value)) {
    throw new Error('Finance connector identity state is invalid');
  }
  return value;
}

function createSnapshotPersistence(pool: Pool): FinanceSnapshotPersistence {
  return {
    async readBasis(connectorId, stableTagRecoveryStart) {
      const [state, recovery] = await Promise.all([
        query<{ lastSuccessfulWindowEnd: string | null }>(
          pool,
          `SELECT last_successful_window_end AS "lastSuccessfulWindowEnd"
           FROM finance_sync_state
           WHERE connector_id = $1`,
          [connectorId],
        ),
        query<{ present: number }>(
          pool,
          `SELECT 1 AS present
           FROM finance_transactions
           WHERE connector_instance_id = $1
             AND lifecycle_status = 'active'
             AND date >= $2
             AND jsonb_array_length(tags) > 0
             AND jsonb_array_length(tag_references) = 0
           LIMIT 1`,
          [connectorId, stableTagRecoveryStart],
        ),
      ]);
      return {
        lastSuccessfulWindowEnd: state[0]?.lastSuccessfulWindowEnd ?? null,
        needsStableTagBackfill: recovery.length > 0,
      };
    },

    async start(command) {
      await transaction(pool, async (client) => {
        await client.query(
          `INSERT INTO finance_sync_state (
             connector_id, status, current_generation_id, current_window_start,
             current_window_end, last_mode, last_attempt_at, created_at, updated_at
           ) VALUES ($1, 'running', $2, $3, $4, $5, $6, $6, $6)
           ON CONFLICT (connector_id) DO UPDATE SET
             status = 'running',
             current_generation_id = EXCLUDED.current_generation_id,
             current_window_start = EXCLUDED.current_window_start,
             current_window_end = EXCLUDED.current_window_end,
             last_mode = EXCLUDED.last_mode,
             last_attempt_at = EXCLUDED.last_attempt_at,
             last_error_code = NULL,
             last_error_message = NULL,
             updated_at = EXCLUDED.updated_at`,
          [
            command.connectorId,
            command.generationId,
            command.windowStart,
            command.windowEnd,
            command.mode,
            command.attemptAt,
          ],
        );
      });
    },

    async upsertPage(command) {
      assertBatch(
        command.transactions.length,
        FINANCE_TRANSACTION_PAGE_MAX,
        'Finance transaction page',
      );
      return transaction(pool, async (client) => {
        const fence = await query<{ present: number }>(
          client,
          `SELECT 1 AS present
           FROM finance_sync_state
           WHERE connector_id = $1
             AND status = 'running'
             AND current_generation_id = $2
           FOR UPDATE`,
          [command.connectorId, command.generationId],
        );
        if (fence.length === 0) throw new FinanceSnapshotFenceError();

        const upstreamIds = command.transactions.map((item) => item.id);
        const existingRows = upstreamIds.length === 0
          ? []
          : await query<{
              upstreamTransactionId: string;
              sourceFingerprint: string;
            }>(
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
                command.generationId,
                command.observedAt,
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
                command.generationId,
                command.observedAt,
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

    async complete(command) {
      return transaction(pool, async (client) => {
        const fence = await query<{ present: number }>(
          client,
          `SELECT 1 AS present
           FROM finance_sync_state
           WHERE connector_id = $1
             AND status = 'running'
             AND current_generation_id = $2
           FOR UPDATE`,
          [command.connectorId, command.generationId],
        );
        if (fence.length === 0) throw new FinanceSnapshotFenceError();

        const tombstones = await client.query(
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
            command.generationId,
          ],
        );
        await client.query(
          `UPDATE finance_attribution_exceptions
           SET status = 'dismissed', review_state = 'resolved',
               resolution = 'dismissed', resolved_at = COALESCE(resolved_at, $1),
               updated_at = $1
           WHERE connector_id = $2
             AND transaction_id IN (
               SELECT id FROM finance_transactions
               WHERE connector_instance_id = $2
                 AND lifecycle_status = 'deleted'
                 AND deleted_at = $1
             )`,
          [command.completedAt, command.connectorId],
        );
        const projectionFacts = (
          await readPostgresFinanceInsightProjectionFacts(
            client,
            command.connectorId,
            command.projectionStartDate,
            'transaction',
            undefined,
          )
        ).transaction;
        const projectionDates = projectionFacts.map((fact) => fact.occurredOn).sort();
        const completed = await client.query(
          `UPDATE finance_sync_state
           SET status = 'succeeded', current_generation_id = NULL,
               current_window_start = NULL, current_window_end = NULL,
               last_successful_generation_id = $1,
               last_successful_source_as_of = $2, last_successful_sync_at = $3,
               last_successful_item_count = $4,
               last_successful_content_digest = $5,
               last_successful_projection_start_date = $6,
               last_successful_projection_coverage_start = $7,
               last_successful_projection_coverage_end = $8,
               last_successful_bridge_contract_version = $9,
               last_successful_window_start = $10,
               last_successful_window_end = $11, last_error_code = NULL,
               last_error_message = NULL, last_added = $12, last_updated = $13,
               last_deleted = $14, updated_at = $3
           WHERE connector_id = $15 AND current_generation_id = $1`,
          [
            command.generationId,
            command.sourceAsOf,
            command.completedAt,
            projectionFacts.length,
            financeInsightDigestV1(projectionFacts as unknown as CanonicalJsonValue),
            command.projectionStartDate,
            projectionDates[0] ?? command.windowStart,
            projectionDates.at(-1) ?? command.windowEnd,
            MONARCH_BRIDGE_CONTRACT_VERSION,
            command.windowStart,
            command.windowEnd,
            command.added,
            command.updated,
            tombstones.rowCount ?? 0,
            command.connectorId,
          ],
        );
        if (completed.rowCount !== 1) throw new FinanceSnapshotFenceError();
        return { removed: tombstones.rowCount ?? 0 };
      });
    },

    async fail(command) {
      const result = await pool.query(
        `UPDATE finance_sync_state
         SET status = 'failed', last_error_code = $1,
             last_error_message = $2, updated_at = $3
         WHERE connector_id = $4 AND current_generation_id = $5`,
        [
          command.errorCode,
          command.errorMessage,
          command.failedAt,
          command.connectorId,
          command.generationId,
        ],
      );
      return { recorded: result.rowCount === 1 };
    },
  };
}

interface ReferenceDefinition {
  table: 'finance_accounts' | 'finance_category_groups' | 'finance_categories' | 'finance_tags';
  sourceIdColumn:
    | 'upstream_account_id'
    | 'upstream_group_id'
    | 'upstream_category_id'
    | 'upstream_tag_id';
  localPrefix: string;
  insertColumns: readonly string[];
  updateAssignments: string;
  values(item: FinanceReferenceDatasetItem): readonly unknown[];
  comparable(item: FinanceReferenceDatasetItem): string;
}

function referenceDefinition(dataset: FinanceReferenceDataset): ReferenceDefinition {
  switch (dataset) {
    case 'accounts':
      return {
        table: 'finance_accounts',
        sourceIdColumn: 'upstream_account_id',
        localPrefix: 'account',
        insertColumns: [
          'display_name',
          'type',
          'institution',
          'mask',
          'is_active',
          'source_is_active',
        ],
        updateAssignments: `display_name = EXCLUDED.display_name, type = EXCLUDED.type,
          institution = EXCLUDED.institution, mask = EXCLUDED.mask,
          is_active = EXCLUDED.is_active, source_is_active = EXCLUDED.source_is_active`,
        values: (raw) => {
          const item = raw as {
            displayName: string;
            type: string;
            institution: string | null;
            mask: string | null;
            isActive: boolean;
          };
          return [
            item.displayName,
            item.type,
            item.institution,
            item.mask,
            item.isActive,
            item.isActive,
          ];
        },
        comparable: (raw) => {
          const item = raw as {
            displayName: string;
            type: string;
            institution: string | null;
            mask: string | null;
            isActive: boolean;
          };
          return stableValue({
            displayName: item.displayName,
            type: item.type,
            institution: item.institution,
            mask: item.mask,
            isActive: item.isActive,
          });
        },
      };
    case 'categories':
      return {
        table: 'finance_categories',
        sourceIdColumn: 'upstream_category_id',
        localPrefix: 'category',
        insertColumns: [
          'name',
          'upstream_group_id',
          'group_name',
          'icon',
          'is_active',
          'source_is_active',
        ],
        updateAssignments: `name = EXCLUDED.name,
          upstream_group_id = EXCLUDED.upstream_group_id,
          group_name = EXCLUDED.group_name, icon = EXCLUDED.icon,
          is_active = EXCLUDED.is_active, source_is_active = EXCLUDED.source_is_active`,
        values: (raw) => {
          const item = raw as {
            name: string;
            groupId: string | null;
            group: string | null;
            icon: string | null;
            isActive: boolean;
          };
          return [
            item.name,
            item.groupId,
            item.group,
            item.icon,
            item.isActive,
            item.isActive,
          ];
        },
        comparable: (item) => stableValue(item),
      };
    case 'category-groups':
    case 'tags': {
      const group = dataset === 'category-groups';
      return {
        table: group ? 'finance_category_groups' : 'finance_tags',
        sourceIdColumn: group ? 'upstream_group_id' : 'upstream_tag_id',
        localPrefix: group ? 'category-group' : 'tag',
        insertColumns: ['name', 'is_active', 'source_is_active'],
        updateAssignments: `name = EXCLUDED.name, is_active = EXCLUDED.is_active,
          source_is_active = EXCLUDED.source_is_active`,
        values: (raw) => {
          const item = raw as { name: string; isActive: boolean };
          return [item.name, item.isActive, item.isActive];
        },
        comparable: (item) => stableValue(item),
      };
    }
  }
}

function stableReferenceRow(
  dataset: FinanceReferenceDataset,
  row: Record<string, unknown>,
): string {
  switch (dataset) {
    case 'accounts':
      return stableValue({
        displayName: row.display_name,
        type: row.type,
        institution: row.institution,
        mask: row.mask,
        isActive: row.source_is_active === true,
      });
    case 'categories':
      return stableValue({
        id: row.upstream_category_id,
        name: row.name,
        groupId: row.upstream_group_id,
        group: row.group_name,
        icon: row.icon,
        isActive: row.source_is_active === true,
      });
    default:
      return stableValue({
        id: dataset === 'category-groups' ? row.upstream_group_id : row.upstream_tag_id,
        name: row.name,
        isActive: row.source_is_active === true,
      });
  }
}

function recurringComparable(item: FinanceRecurringPublicationCommand['items'][number]) {
  return {
    id: item.id,
    merchant: item.merchant,
    amount: item.amount,
    frequency: item.frequency,
    nextExpectedDate: item.nextExpectedDate,
    accountId: item.account?.id ?? null,
    accountName: item.account?.displayName ?? null,
    categoryId: item.category?.id ?? null,
    categoryName: item.category?.name ?? null,
  };
}

function budgetComparable(
  item: FinanceBudgetPublicationCommand['items'][number],
  periodStart: string,
  periodEnd: string,
) {
  return {
    id: item.category.id,
    categoryName: item.category.name,
    periodStart,
    periodEnd,
    budgeted: item.budgeted,
    spent: item.spent,
    remaining: item.remaining,
    percentUsed: item.percentUsed,
  };
}

function binaryIdCompare(left: { id: string }, right: { id: string }): number {
  return Buffer.compare(Buffer.from(left.id, 'utf8'), Buffer.from(right.id, 'utf8'));
}

function createDatasetPersistence(pool: Pool): FinanceDatasetPersistence {
  async function lockAttempt(
    client: PoolClient,
    metadata: FinanceDatasetPublicationMetadata,
  ): Promise<{
    currentGenerationId: string | null;
    previousGenerationId: string | null;
  }> {
    const rows = await query<{
      lastAttemptAt: string;
      currentGenerationId: string | null;
      previousGenerationId: string | null;
    }>(
      client,
      `SELECT last_attempt_at AS "lastAttemptAt",
              current_generation_id AS "currentGenerationId",
              previous_generation_id AS "previousGenerationId"
       FROM finance_dataset_sync_state
       WHERE connector_id = $1 AND dataset = $2
       FOR UPDATE`,
      [metadata.connectorId, metadata.dataset],
    );
    const state = rows[0];
    if (!state || state.lastAttemptAt !== metadata.attemptAt) {
      throw new FinanceDatasetFenceError();
    }
    return state;
  }

  async function recordSuccess(
    client: PoolClient,
    metadata: FinanceDatasetPublicationMetadata,
    previousState: {
      currentGenerationId: string | null;
      previousGenerationId: string | null;
    },
    generationId: string,
    count: number,
  ): Promise<void> {
    const proof = await readDatasetProjectionProof(
      client,
      metadata.connectorId,
      metadata.dataset,
    );
    const result = await client.query(
      `UPDATE finance_dataset_sync_state
       SET last_attempt_outcome = 'succeeded', last_successful_at = $1,
           source_as_of = $2, fresh_until = $3, coverage_start = $4,
           coverage_end = $5, previous_generation_id = $6,
           current_generation_id = $7, schema_version = $8,
           config_version = $9, published_item_count = $10,
           insight_item_count = $11, insight_content_digest = $12,
           insight_bridge_contract_version = $13, source_limit = $14,
           last_error_code = NULL, updated_at = $1
       WHERE connector_id = $15 AND dataset = $16 AND last_attempt_at = $17`,
      [
        metadata.completedAt,
        metadata.sourceAsOf,
        metadata.freshUntil,
        metadata.coverageStart,
        metadata.coverageEnd,
        previousState.currentGenerationId === generationId
          ? previousState.previousGenerationId
          : previousState.currentGenerationId,
        generationId,
        metadata.schemaVersion,
        metadata.configVersion,
        count,
        proof?.itemCount ?? null,
        proof?.contentDigest ?? null,
        proof?.bridgeContractVersion ?? null,
        metadata.sourceLimit,
        metadata.connectorId,
        metadata.dataset,
        metadata.attemptAt,
      ],
    );
    if (result.rowCount !== 1) throw new FinanceDatasetFenceError();
  }

  async function currentSnapshotCount(
    client: PoolClient,
    table: 'finance_recurring_obligations' | 'finance_budget_snapshots',
    connectorId: string,
  ): Promise<number> {
    const rows = await query<{ count: string | number }>(
      client,
      `SELECT count(*) AS count FROM ${table}
       WHERE connector_id = $1 AND is_current = true`,
      [connectorId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function rotateSnapshots(
    client: PoolClient,
    table: 'finance_recurring_obligations' | 'finance_budget_snapshots',
    connectorId: string,
    generationId: string,
    previousGenerationId: string | null,
  ): Promise<void> {
    await client.query(
      `UPDATE ${table} SET is_current = false
       WHERE connector_id = $1 AND generation_id <> $2`,
      [connectorId, generationId],
    );
    await client.query(
      `DELETE FROM ${table}
       WHERE connector_id = $1 AND generation_id NOT IN ($2, $3)`,
      [connectorId, generationId, previousGenerationId ?? generationId],
    );
  }

  return {
    async listState(connectorId): Promise<FinanceDatasetState[]> {
      return query<FinanceDatasetState>(
        pool,
        `SELECT dataset, last_attempt_at AS "lastAttemptAt",
                last_attempt_outcome AS "lastAttemptOutcome",
                last_successful_at AS "lastSuccessfulAt",
                source_as_of AS "sourceAsOf", fresh_until AS "freshUntil",
                coverage_start AS "coverageStart", coverage_end AS "coverageEnd",
                current_generation_id AS "currentGenerationId",
                previous_generation_id AS "previousGenerationId",
                schema_version AS "schemaVersion", config_version AS "configVersion",
                published_item_count AS "publishedItemCount",
                source_limit AS "sourceLimit", last_error_code AS "lastErrorCode"
         FROM finance_dataset_sync_state
         WHERE connector_id = $1`,
        [connectorId],
      );
    },

    async recordAttempt(command) {
      await pool.query(
        `INSERT INTO finance_dataset_sync_state (
           connector_id, dataset, last_attempt_at, source_limit,
           schema_version, config_version, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $3, $3)
         ON CONFLICT (connector_id, dataset) DO UPDATE SET
           last_attempt_at = EXCLUDED.last_attempt_at,
           updated_at = EXCLUDED.updated_at`,
        [
          command.connectorId,
          command.dataset,
          command.attemptAt,
          command.sourceLimit,
          command.schemaVersion,
          command.configVersion,
        ],
      );
    },

    async publishReference(command): Promise<FinanceDatasetPublishResult> {
      assertDatasetBatch(command.items.length, command.sourceLimit);
      const definition = referenceDefinition(command.dataset);
      return transaction(pool, async (client) => {
        const state = await lockAttempt(client, command);
        const existingRows = await query<Record<string, unknown> & QueryResultRow>(
          client,
          `SELECT * FROM ${definition.table} WHERE connector_id = $1`,
          [command.connectorId],
        );
        const existing = new Map(existingRows.map((row) => [
          String(row[definition.sourceIdColumn]),
          stableReferenceRow(command.dataset, row),
        ]));
        let added = 0;
        let updated = 0;
        for (const item of command.items) {
          const next = definition.comparable(item);
          const previous = existing.get(item.id);
          if (previous === undefined) added++;
          else if (previous !== next) updated++;
          const itemValues = definition.values(item);
          const fixedValues: unknown[] = [
            localId(definition.localPrefix, command.connectorId, item.id),
            command.connectorId,
            item.id,
            ...itemValues,
            command.generationId,
            command.completedAt,
            command.completedAt,
          ];
          const placeholders = fixedValues.map((_value, index) => `$${index + 1}`);
          const valueColumnCount = 3 + definition.insertColumns.length;
          const generationPlaceholder = placeholders[valueColumnCount];
          const firstSeenPlaceholder = placeholders[valueColumnCount + 1];
          const lastSeenPlaceholder = placeholders[valueColumnCount + 2];
          await client.query(
            `INSERT INTO ${definition.table} (
               id, connector_id, ${definition.sourceIdColumn},
               ${definition.insertColumns.join(', ')},
               last_seen_generation_id, first_seen_at, last_seen_at, deactivated_at
             ) VALUES (
               ${placeholders.slice(0, valueColumnCount).join(', ')},
               ${generationPlaceholder}, ${firstSeenPlaceholder}, ${lastSeenPlaceholder}, NULL
             )
             ON CONFLICT (connector_id, ${definition.sourceIdColumn}) DO UPDATE SET
               ${definition.updateAssignments},
               last_seen_generation_id = EXCLUDED.last_seen_generation_id,
               last_seen_at = EXCLUDED.last_seen_at,
               deactivated_at = CASE WHEN EXCLUDED.is_active = true THEN NULL
                 ELSE COALESCE(${definition.table}.deactivated_at, EXCLUDED.last_seen_at) END`,
            fixedValues,
          );
        }
        const removed = await client.query(
          `UPDATE ${definition.table}
           SET is_active = false, deactivated_at = COALESCE(deactivated_at, $1)
           WHERE connector_id = $2 AND is_active = true
             AND last_seen_generation_id <> $3`,
          [command.completedAt, command.connectorId, command.generationId],
        );
        await recordSuccess(
          client,
          command,
          state,
          command.generationId,
          command.items.length,
        );
        return {
          added,
          updated,
          removed: removed.rowCount ?? 0,
          count: command.items.length,
        };
      });
    },

    async publishRecurring(command): Promise<FinanceDatasetPublishResult> {
      assertDatasetBatch(command.items.length, command.sourceLimit);
      return transaction(pool, async (client) => {
        const state = await lockAttempt(client, command);
        const currentRows = await query<{
          id: string;
          merchant: string;
          amount: number;
          frequency: string;
          nextExpectedDate: string | null;
          accountId: string | null;
          accountName: string | null;
          categoryId: string | null;
          categoryName: string | null;
        }>(
          client,
          `SELECT upstream_recurring_id AS id, merchant, amount, frequency,
                  next_expected_date AS "nextExpectedDate",
                  upstream_account_id AS "accountId", account_name AS "accountName",
                  upstream_category_id AS "categoryId", category_name AS "categoryName"
           FROM finance_recurring_obligations
           WHERE connector_id = $1 AND is_current = true`,
          [command.connectorId],
        );
        const nextFingerprint = stableValue(command.items
          .map((item) => recurringComparable(item))
          .sort(binaryIdCompare));
        const currentFingerprint = stableValue(currentRows.sort(binaryIdCompare));
        if (state.currentGenerationId && currentFingerprint === nextFingerprint) {
          await recordSuccess(
            client,
            command,
            state,
            state.currentGenerationId,
            command.items.length,
          );
          return { added: 0, updated: 0, removed: 0, count: command.items.length };
        }
        const previousCount = await currentSnapshotCount(
          client,
          'finance_recurring_obligations',
          command.connectorId,
        );
        for (const item of command.items) {
          await client.query(
            `INSERT INTO finance_recurring_obligations (
               id, connector_id, generation_id, upstream_recurring_id, merchant,
               amount, frequency, next_expected_date, upstream_account_id,
               account_name, upstream_category_id, category_name, is_current,
               source_as_of, created_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $14
             )`,
            [
              localId('recurring', command.connectorId, `${command.generationId}:${item.id}`),
              command.connectorId,
              command.generationId,
              item.id,
              item.merchant,
              item.amount,
              item.frequency,
              item.nextExpectedDate,
              item.account?.id ?? null,
              item.account?.displayName ?? null,
              item.category?.id ?? null,
              item.category?.name ?? null,
              command.sourceAsOf,
              command.completedAt,
            ],
          );
        }
        await rotateSnapshots(
          client,
          'finance_recurring_obligations',
          command.connectorId,
          command.generationId,
          state.currentGenerationId,
        );
        await recordSuccess(
          client,
          command,
          state,
          command.generationId,
          command.items.length,
        );
        return {
          added: command.items.length,
          updated: 0,
          removed: Math.max(0, previousCount - command.items.length),
          count: command.items.length,
        };
      });
    },

    async publishBudgets(command): Promise<FinanceDatasetPublishResult> {
      assertDatasetBatch(command.items.length, command.sourceLimit);
      return transaction(pool, async (client) => {
        const state = await lockAttempt(client, command);
        const currentRows = await query<{
          id: string;
          categoryName: string;
          periodStart: string;
          periodEnd: string;
          budgeted: number;
          spent: number;
          remaining: number;
          percentUsed: number | null;
        }>(
          client,
          `SELECT upstream_category_id AS id, category_name AS "categoryName",
                  period_start AS "periodStart", period_end AS "periodEnd",
                  budgeted, spent, remaining, percent_used AS "percentUsed"
           FROM finance_budget_snapshots
           WHERE connector_id = $1 AND is_current = true`,
          [command.connectorId],
        );
        const nextFingerprint = stableValue(command.items
          .map((item) => budgetComparable(item, command.periodStart, command.periodEnd))
          .sort(binaryIdCompare));
        const currentFingerprint = stableValue(currentRows.sort(binaryIdCompare));
        if (state.currentGenerationId && currentFingerprint === nextFingerprint) {
          await recordSuccess(
            client,
            command,
            state,
            state.currentGenerationId,
            command.items.length,
          );
          return { added: 0, updated: 0, removed: 0, count: command.items.length };
        }
        const previousCount = await currentSnapshotCount(
          client,
          'finance_budget_snapshots',
          command.connectorId,
        );
        for (const item of command.items) {
          await client.query(
            `INSERT INTO finance_budget_snapshots (
               id, connector_id, generation_id, period_start, period_end,
               upstream_category_id, category_name, budgeted, spent, remaining,
               percent_used, is_current, source_as_of, created_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12, $13
             )`,
            [
              localId(
                'budget',
                command.connectorId,
                `${command.generationId}:${command.periodStart}:${item.category.id}`,
              ),
              command.connectorId,
              command.generationId,
              command.periodStart,
              command.periodEnd,
              item.category.id,
              item.category.name,
              item.budgeted,
              item.spent,
              item.remaining,
              item.percentUsed,
              command.sourceAsOf,
              command.completedAt,
            ],
          );
        }
        await rotateSnapshots(
          client,
          'finance_budget_snapshots',
          command.connectorId,
          command.generationId,
          state.currentGenerationId,
        );
        await recordSuccess(
          client,
          command,
          state,
          command.generationId,
          command.items.length,
        );
        return {
          added: command.items.length,
          updated: 0,
          removed: Math.max(0, previousCount - command.items.length),
          count: command.items.length,
        };
      });
    },

    async recordFailure(command) {
      return transaction(pool, async (client) => {
        const result = await client.query(
          `UPDATE finance_dataset_sync_state
           SET last_attempt_at = $1, last_attempt_outcome = 'failed',
               last_error_code = $2, updated_at = $1
           WHERE connector_id = $3 AND dataset = $4 AND last_attempt_at = $5`,
          [
            command.failedAt,
            command.errorCode,
            command.connectorId,
            command.dataset,
            command.attemptAt,
          ],
        );
        if (result.rowCount === 1) return { recorded: true };
        const inserted = await client.query(
          `INSERT INTO finance_dataset_sync_state (
             connector_id, dataset, last_attempt_at, last_attempt_outcome,
             source_limit, schema_version, config_version, last_error_code,
             created_at, updated_at
           ) VALUES ($1, $2, $3, 'failed', $4, $5, $6, $7, $3, $3)
           ON CONFLICT (connector_id, dataset) DO NOTHING`,
          [
            command.connectorId,
            command.dataset,
            command.failedAt,
            command.sourceLimit,
            command.schemaVersion,
            command.configVersion,
            command.errorCode,
          ],
        );
        return { recorded: inserted.rowCount === 1 };
      });
    },
  };
}

type ExceptionStatus = 'open' | 'retry_requested' | 'resolved' | 'dismissed';

async function upsertException(
  client: PoolClient,
  idFactory: () => string,
  input: {
    connectorId: string;
    transactionId: string;
    sourceRef: string | null;
    sourceFingerprint: string;
    reasonCode: string;
    retryable: boolean;
    policyVersion: number | null;
    now: string;
  },
): Promise<'pending' | 'resolved'> {
  const rows = await query<{
    id: string;
    status: ExceptionStatus;
    reasonCode: string;
    sourceFingerprint: string;
    policyVersion: number | null;
  }>(
    client,
    `SELECT id, status, reason_code AS "reasonCode",
            source_fingerprint AS "sourceFingerprint",
            policy_version AS "policyVersion"
     FROM finance_attribution_exceptions
     WHERE connector_id = $1 AND transaction_id = $2
     FOR UPDATE`,
    [input.connectorId, input.transactionId],
  );
  const existing = rows[0];
  if (!existing) {
    await client.query(
      `INSERT INTO finance_attribution_exceptions (
         id, connector_id, transaction_id, source_ref, status, reason_code,
         retryable, review_state, source_fingerprint, policy_version,
         occurrence_count, created_at, first_observed_at, last_observed_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, 'open', $5, $6, 'pending', $7, $8, 1, $9, $9, $9, $9
       )`,
      [
        idFactory(),
        input.connectorId,
        input.transactionId,
        input.sourceRef,
        input.reasonCode,
        input.retryable,
        input.sourceFingerprint,
        input.policyVersion,
        input.now,
      ],
    );
    return 'pending';
  }
  const unchanged = existing.reasonCode === input.reasonCode
    && existing.sourceFingerprint === input.sourceFingerprint
    && existing.policyVersion === input.policyVersion;
  const preserveResolution = unchanged
    && (existing.status === 'resolved' || existing.status === 'dismissed');
  await client.query(
    `UPDATE finance_attribution_exceptions
     SET source_ref = COALESCE($1, source_ref), status = $2,
         reason_code = $3, retryable = $4, review_state = $5,
         source_fingerprint = $6, policy_version = $7,
         occurrence_count = occurrence_count + 1, last_observed_at = $8,
         resolution = CASE WHEN $9 THEN resolution ELSE NULL END,
         resolved_at = CASE WHEN $9 THEN resolved_at ELSE NULL END,
         updated_at = $8
     WHERE id = $10`,
    [
      input.sourceRef,
      preserveResolution ? existing.status : 'open',
      input.reasonCode,
      input.retryable,
      preserveResolution ? 'resolved' : 'pending',
      input.sourceFingerprint,
      input.policyVersion,
      input.now,
      preserveResolution,
      existing.id,
    ],
  );
  return preserveResolution ? 'resolved' : 'pending';
}

async function preserveClosedTransactionReview(
  client: PoolClient,
  connectorId: string,
  transactionId: string,
  reviewState: 'pending' | 'resolved',
  now: string,
): Promise<void> {
  if (reviewState !== 'resolved') return;
  await client.query(
    `UPDATE finance_transactions
     SET attribution_review_state = 'resolved', attribution_updated_at = $1
     WHERE id = $2 AND connector_instance_id = $3`,
    [now, transactionId, connectorId],
  );
}

async function resolveCurrentException(
  client: PoolClient,
  connectorId: string,
  transactionId: string,
  now: string,
): Promise<void> {
  await client.query(
    `UPDATE finance_attribution_exceptions
     SET status = CASE WHEN status = 'dismissed' THEN 'dismissed' ELSE 'resolved' END,
         review_state = 'resolved',
         resolution = CASE WHEN status = 'dismissed' THEN resolution ELSE 'reattributed' END,
         resolved_at = COALESCE(resolved_at, $1), updated_at = $1
     WHERE connector_id = $2 AND transaction_id = $3`,
    [now, connectorId, transactionId],
  );
}

function manualCasClause(start: number): string {
  return `kid_assignment_method = 'manual'
    AND manual_decision_action IS NOT DISTINCT FROM $${start}
    AND manual_decided_at IS NOT DISTINCT FROM $${start + 1}
    AND assigned_kid_id IS NOT DISTINCT FROM $${start + 2}`;
}

// ─── API-shaped attribution mutation helpers ────────────────────────────────

function normalizeReasons(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function requireFinanceConnector(
  client: Client,
  connectorId: string,
): Promise<void> {
  const rows = await query<{ present: number }>(
    client,
    `SELECT 1 AS present FROM connector_configs
     WHERE id = $1 AND type = ANY($2::text[])
       AND enabled = true AND deleted_at IS NULL`,
    [connectorId, [...FINANCE_PROVIDER_ALIASES]],
  );
  if (rows.length === 0) {
    throw new FinanceAttributionMutationError(
      'connector_not_found',
      'Finance connector was not found',
      404,
    );
  }
}

interface AttributionActionAuditRow {
  transactionId: string;
  exceptionId: string | null;
  action: string;
  requestedKidId: string | null;
  requestedDecision: FinanceManualAction | null;
  resultStatus: string;
}

async function findAttributionActionAudit(
  client: Client,
  connectorId: string,
  idempotencyKey: string,
): Promise<AttributionActionAuditRow | undefined> {
  const rows = await query<AttributionActionAuditRow>(
    client,
    `SELECT transaction_id AS "transactionId", exception_id AS "exceptionId",
            action, requested_kid_id AS "requestedKidId",
            requested_decision AS "requestedDecision",
            result_status AS "resultStatus"
     FROM finance_attribution_audit
     WHERE connector_id = $1 AND idempotency_key = $2`,
    [connectorId, idempotencyKey],
  );
  return rows[0];
}

function idempotencyConflict(message: string): never {
  throw new FinanceAttributionMutationError('idempotency_conflict', message, 409);
}

function isAttributionIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value);
}

function assertManualDecisionShape(
  action: FinanceManualAction,
  kidId: string | null,
): void {
  if (action === 'assign-kid' && (!kidId || !isAttributionIdentifier(kidId))) {
    throw new FinanceAttributionMutationError(
      'invalid_manual_decision',
      'A valid Tyrion kid identifier is required',
      400,
    );
  }
  if (action === 'parent-expense' && kidId !== null) {
    throw new FinanceAttributionMutationError(
      'invalid_manual_decision',
      'Parent expense decisions cannot include a kid identifier',
      400,
    );
  }
}

function assertManualDecisionReplay(
  audit: AttributionActionAuditRow,
  command: FinanceAttributionManualDecisionCommand,
): void {
  if (
    audit.transactionId !== command.transactionId
    || audit.requestedKidId !== command.kidId
    || audit.requestedDecision !== command.action
    || audit.action !== command.auditAction
  ) {
    idempotencyConflict('Idempotency key was already used for another decision');
  }
}

function assertExceptionActionReplay(
  audit: AttributionActionAuditRow,
  command: FinanceAttributionExceptionActionCommand,
): void {
  const requestedKidId = command.action === 'manual-resolve' ? command.kidId ?? null : null;
  if (
    audit.exceptionId !== command.exceptionId
    || audit.action !== command.action
    || (command.action === 'manual-resolve' && audit.requestedKidId !== requestedKidId)
  ) {
    idempotencyConflict('Idempotency key was already used for another action');
  }
}

async function readExceptionForAction(
  client: PoolClient,
  command: FinanceAttributionExceptionActionCommand,
): Promise<{ id: string; transactionId: string; assignedKidId: string | null }> {
  const [exception] = await query<{
    id: string;
    transactionId: string;
    assignedKidId: string | null;
  }>(client, `
    SELECT e.id, e.transaction_id AS "transactionId",
           t.assigned_kid_id AS "assignedKidId"
    FROM finance_attribution_exceptions e
    INNER JOIN finance_transactions t
      ON t.id = e.transaction_id
      AND t.connector_instance_id = e.connector_id
    WHERE e.id = $1 AND e.connector_id = $2
    FOR UPDATE OF e, t
  `, [command.exceptionId, command.connectorId]);
  if (!exception) {
    throw new FinanceAttributionMutationError(
      'exception_not_found',
      'Attribution exception was not found',
      404,
    );
  }
  return exception;
}

/**
 * The manual-decision write. It runs inside the caller's transaction with the
 * target transaction, exception, and idempotency rows locked, so connector
 * ownership, expected-version CAS, projected-subject membership, exception CAS,
 * the state mutation, and the audit row all commit or all abort together.
 * Returns `true` when a concurrent writer already committed this exact key.
 */
async function applyManualDecisionInTransaction(
  client: PoolClient,
  idFactory: () => string,
  command: FinanceAttributionManualDecisionCommand,
): Promise<boolean> {
  const concurrent = await findAttributionActionAudit(
    client,
    command.connectorId,
    command.idempotencyKey,
  );
  if (concurrent) {
    assertManualDecisionReplay(concurrent, command);
    return true;
  }
  await requireFinanceConnector(client, command.connectorId);
  const [transactionRow] = await query<{
    id: string;
    sourceFingerprint: string;
    lastSeenAt: string;
    assignedKidId: string | null;
    confirmedCategory: string | null;
    manualDecidedAt: string | null;
  }>(client, `
    SELECT id, source_fingerprint AS "sourceFingerprint",
           last_seen_at AS "lastSeenAt", assigned_kid_id AS "assignedKidId",
           confirmed_category AS "confirmedCategory",
           manual_decided_at AS "manualDecidedAt"
    FROM finance_transactions
    WHERE id = $1 AND connector_instance_id = $2 AND lifecycle_status = 'active'
    FOR UPDATE
  `, [command.transactionId, command.connectorId]);
  if (!transactionRow) {
    throw new FinanceAttributionMutationError(
      'transaction_not_found',
      'Finance transaction was not found',
      404,
    );
  }
  const expectedVersion = command.expectedTransactionVersion;
  if (
    expectedVersion
    && (
      transactionRow.sourceFingerprint !== expectedVersion.sourceFingerprint
      || transactionRow.lastSeenAt !== expectedVersion.lastSeenAt
      || transactionRow.assignedKidId !== expectedVersion.assignedKidId
      || transactionRow.confirmedCategory !== expectedVersion.confirmedCategory
      || transactionRow.manualDecidedAt !== expectedVersion.manualDecidedAt
    )
  ) {
    throw new FinanceAttributionMutationError(
      'transaction_conflict',
      'Finance transaction changed after approval',
      409,
    );
  }
  if (command.action === 'assign-kid') {
    const projected = await query<{ present: number }>(client, `
      SELECT 1 AS present
      FROM finance_attribution_subjects subjects
      INNER JOIN finance_sync_state state
        ON state.connector_id = subjects.connector_id
        AND state.attribution_policy_version = subjects.policy_version
      WHERE subjects.connector_id = $1 AND subjects.kid_id = $2
    `, [command.connectorId, command.kidId]);
    if (projected.length === 0) {
      throw new FinanceAttributionMutationError(
        'unknown_attribution_subject',
        'Kid identifier is not present in the current Tyrion projection',
        409,
      );
    }
  }
  if (command.exceptionId) {
    const [currentException] = await query<{ status: string; updatedAt: string }>(client, `
      SELECT status, updated_at AS "updatedAt"
      FROM finance_attribution_exceptions
      WHERE id = $1 AND connector_id = $2 AND transaction_id = $3
      FOR UPDATE
    `, [command.exceptionId, command.connectorId, command.transactionId]);
    if (!currentException || !['open', 'retry_requested'].includes(currentException.status)) {
      throw new FinanceAttributionMutationError(
        'exception_conflict',
        'This exception was already resolved by a newer decision',
        409,
      );
    }
    if (currentException.updatedAt !== command.expectedExceptionUpdatedAt) {
      throw new FinanceAttributionMutationError(
        'exception_conflict',
        'This exception changed after it was loaded',
        409,
      );
    }
    if (
      transactionRow.manualDecidedAt
      && Date.parse(transactionRow.manualDecidedAt) > Date.parse(currentException.updatedAt)
    ) {
      throw new FinanceAttributionMutationError(
        'manual_decision_superseded',
        'A newer manual decision already exists',
        409,
      );
    }
  }
  await client.query(`
    UPDATE finance_transactions
    SET assigned_kid_id = $1, kid_assignment_method = 'manual',
        manual_decision_action = $2, manual_decided_at = $3,
        attribution_status = $4, attribution_confidence = 'definite',
        attribution_method = 'manual',
        attribution_explanation = 'Confirmed by parent administrator',
        attribution_reasons = '[]'::jsonb, attribution_decision_source = 'manual',
        attribution_evaluated_at = $3, attribution_review_state = 'resolved',
        attribution_provenance = 'mission-control-manual-v1',
        attribution_last_error_code = NULL, attribution_retryable = false,
        attribution_updated_at = $3, triage_status = 'confirmed'
    WHERE id = $5 AND connector_instance_id = $6
  `, [
    command.kidId,
    command.action,
    command.now,
    command.action === 'assign-kid' ? 'attributed' : 'unassigned',
    command.transactionId,
    command.connectorId,
  ]);
  await client.query(`
    UPDATE finance_attribution_exceptions
    SET status = 'resolved', review_state = 'resolved',
        resolution = $1, resolved_at = $2, updated_at = $2
    WHERE connector_id = $3 AND transaction_id = $4
      AND ($5::text IS NULL OR id = $5)
  `, [
    command.auditAction === 'approve' ? 'approved' : 'manual',
    command.now,
    command.connectorId,
    command.transactionId,
    command.exceptionId ?? null,
  ]);
  await client.query(`
    INSERT INTO finance_attribution_audit (
      id, connector_id, transaction_id, exception_id, idempotency_key,
      action, actor_type, requested_kid_id, requested_decision,
      result_status, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'resolved', $10)
  `, [
    idFactory(),
    command.connectorId,
    command.transactionId,
    command.exceptionId ?? null,
    command.idempotencyKey,
    command.auditAction,
    command.actorType,
    command.kidId,
    command.action,
    command.now,
  ]);
  return false;
}

function createAttributionPersistence(
  pool: Pool,
  idFactory: () => string,
): FinanceAttributionPersistence {
  async function reviewException(
    client: PoolClient,
    item: FinanceAttributionApplyItem | FinanceAttributionUnavailableItem,
    input: {
      connectorId: string;
      now: string;
      reasonCode: string;
      retryable: boolean;
      policyVersion: number | null;
    },
  ): Promise<void> {
    const reviewState = await upsertException(client, idFactory, {
      connectorId: input.connectorId,
      transactionId: item.transactionId,
      sourceRef: item.sourceRef,
      sourceFingerprint: item.sourceFingerprint,
      reasonCode: input.reasonCode,
      retryable: input.retryable,
      policyVersion: input.policyVersion,
      now: input.now,
    });
    await preserveClosedTransactionReview(
      client,
      input.connectorId,
      item.transactionId,
      reviewState,
      input.now,
    );
  }

  async function assertAttributionFence(
    client: PoolClient,
    input: {
      connectorId: string;
      generationId: string;
      fenceMode?: 'snapshot' | 'row-generation';
      items: ReadonlyArray<{ transactionId: string }>;
    },
  ): Promise<void> {
    if (input.fenceMode === 'row-generation') {
      if (input.items.length === 0) return;
      const rows = await query<{ id: string }>(
        client,
        `SELECT id FROM finance_transactions
         WHERE connector_instance_id = $1
           AND last_seen_generation_id = $2
           AND id = ANY($3::text[])
         FOR UPDATE`,
        [
          input.connectorId,
          input.generationId,
          input.items.map((item) => item.transactionId),
        ],
      );
      if (new Set(rows.map((row) => row.id)).size !== input.items.length) {
        throw new FinanceAttributionFenceError();
      }
      return;
    }
    const fence = await query<{ present: number }>(
      client,
      `SELECT 1 AS present FROM finance_sync_state
       WHERE connector_id = $1 AND status = 'running'
         AND current_generation_id = $2
       FOR UPDATE`,
      [input.connectorId, input.generationId],
    );
    if (fence.length === 0) throw new FinanceAttributionFenceError();
  }

  return {
    async assertConnector(connectorId) {
      await requireFinanceConnector(pool, connectorId);
    },

    async readRows(connectorId, upstreamTransactionIds) {
      assertBatch(
        upstreamTransactionIds.length,
        FINANCE_ATTRIBUTION_READ_MAX,
        'Finance attribution read',
      );
      if (upstreamTransactionIds.length === 0) return new Map();
      const rows = await query<FinanceAttributionRow>(
        pool,
        `SELECT id, upstream_transaction_id AS "upstreamTransactionId",
                assigned_kid_id AS "assignedKidId",
                kid_assignment_method AS "kidAssignmentMethod",
                manual_decision_action AS "manualDecisionAction",
                manual_decided_at AS "manualDecidedAt",
                source_fingerprint AS "sourceFingerprint",
                first_seen_at AS "firstSeenAt"
         FROM finance_transactions
         WHERE connector_instance_id = $1
           AND upstream_transaction_id = ANY($2::text[])`,
        [connectorId, upstreamTransactionIds],
      );
      return new Map(rows.map((row) => [row.upstreamTransactionId, row]));
    },

    async applyResults(input) {
      assertBatch(
        input.items.length,
        FINANCE_ATTRIBUTION_WRITE_MAX,
        'Finance attribution result write',
      );
      await transaction(pool, async (client) => {
        await assertAttributionFence(client, input);
        for (const item of input.items) {
          const result = item.result;
          if (!item.manualResultMatches) {
            const updated = await client.query(
              `UPDATE finance_transactions
               SET attribution_source_ref = $1, attribution_contract_version = $2,
                   attribution_status = 'pending', attribution_confidence = 'none',
                   attribution_method = 'manual',
                   attribution_explanation = 'Manual decision requires policy review',
                   attribution_reasons = '["policy-version-mismatch"]'::jsonb,
                   attribution_decision_source = 'manual',
                   attribution_policy_version = $3, attribution_engine_version = $4,
                   attribution_evaluated_at = $5, attribution_review_state = 'pending',
                   attribution_provenance = $6,
                   attribution_last_error_code = 'manual_decision_conflict',
                   attribution_retryable = false, attribution_updated_at = $7
               WHERE id = $8 AND connector_instance_id = $9
                 AND ${manualCasClause(10)}`,
              [
                item.sourceRef,
                result.contractVersion,
                result.policyVersion,
                result.engineVersion,
                result.evaluatedAt,
                input.provenance,
                input.now,
                item.transactionId,
                input.connectorId,
                item.stateSnapshot.manualDecisionAction,
                item.stateSnapshot.manualDecidedAt,
                item.stateSnapshot.assignedKidId,
              ],
            );
            if (updated.rowCount !== 1) continue;
            await reviewException(client, item, {
              connectorId: input.connectorId,
              now: input.now,
              reasonCode: 'manual_decision_conflict',
              retryable: false,
              policyVersion: result.policyVersion,
            });
            continue;
          }

          let updated;
          const common = [
            item.sourceRef,
            result.contractVersion,
            result.status,
            result.confidence,
            result.method,
            result.explanation,
            JSON.stringify(result.reasons),
            result.decisionSource,
            result.policyVersion,
            result.engineVersion,
            result.evaluatedAt,
            result.reviewStatus,
            input.provenance,
            input.now,
          ] as const;
          if (item.hasManualDecision) {
            updated = await client.query(
              `UPDATE finance_transactions
               SET attribution_source_ref = $1, attribution_contract_version = $2,
                   attribution_status = $3, attribution_confidence = $4,
                   attribution_method = $5, attribution_explanation = $6,
                   attribution_reasons = $7::jsonb, attribution_decision_source = $8,
                   attribution_policy_version = $9, attribution_engine_version = $10,
                   attribution_evaluated_at = $11, attribution_review_state = $12,
                   attribution_provenance = $13, attribution_last_error_code = NULL,
                   attribution_retryable = false, attribution_updated_at = $14
               WHERE id = $15 AND connector_instance_id = $16
                 AND ${manualCasClause(17)}`,
              [
                ...common,
                item.transactionId,
                input.connectorId,
                item.stateSnapshot.manualDecisionAction,
                item.stateSnapshot.manualDecidedAt,
                item.stateSnapshot.assignedKidId,
              ],
            );
          } else {
            updated = await client.query(
              `UPDATE finance_transactions
               SET assigned_kid_id = $1, kid_assignment_method = $2,
                   attribution_source_ref = $3, attribution_contract_version = $4,
                   attribution_status = $5, attribution_confidence = $6,
                   attribution_method = $7, attribution_explanation = $8,
                   attribution_reasons = $9::jsonb, attribution_decision_source = $10,
                   attribution_policy_version = $11, attribution_engine_version = $12,
                   attribution_evaluated_at = $13, attribution_review_state = $14,
                   attribution_provenance = $15, attribution_last_error_code = NULL,
                   attribution_retryable = false, attribution_updated_at = $16,
                   triage_status = $17
               WHERE id = $18 AND connector_instance_id = $19
                 AND (kid_assignment_method IS NULL OR kid_assignment_method <> 'manual')`,
              [
                result.kidId,
                result.method,
                ...common,
                result.reviewStatus === 'pending' ? 'pending' : 'confirmed',
                item.transactionId,
                input.connectorId,
              ],
            );
          }
          if (updated.rowCount !== 1) continue;
          if (result.kidId) {
            await client.query(
              `INSERT INTO finance_attribution_subjects (
                 id, connector_id, kid_id, policy_version, engine_version,
                 first_seen_at, last_seen_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $6)
               ON CONFLICT (connector_id, kid_id) DO UPDATE SET
                 policy_version = EXCLUDED.policy_version,
                 engine_version = EXCLUDED.engine_version,
                 last_seen_at = EXCLUDED.last_seen_at`,
              [
                idFactory(),
                input.connectorId,
                result.kidId,
                result.policyVersion,
                result.engineVersion,
                input.now,
              ],
            );
          }
          if (result.reviewStatus === 'pending' || result.status === 'pending') {
            await reviewException(client, item, {
              connectorId: input.connectorId,
              now: input.now,
              reasonCode: result.reasons[0] ?? 'review-required',
              retryable: false,
              policyVersion: result.policyVersion,
            });
          } else {
            await resolveCurrentException(
              client,
              input.connectorId,
              item.transactionId,
              input.now,
            );
          }
        }
      });
    },

    async persistUnavailable(input) {
      assertBatch(
        input.items.length,
        FINANCE_ATTRIBUTION_WRITE_MAX,
        'Finance attribution unavailable write',
      );
      await transaction(pool, async (client) => {
        await assertAttributionFence(client, input);
        for (const item of input.items) {
          const manual = item.stateSnapshot.kidAssignmentMethod === 'manual';
          const current = await query<{ present: number }>(
            client,
            manual
              ? `SELECT 1 AS present FROM finance_transactions
                 WHERE id = $1 AND connector_instance_id = $2
                   AND ${manualCasClause(3)}
                 FOR UPDATE`
              : `SELECT 1 AS present FROM finance_transactions
                 WHERE id = $1 AND connector_instance_id = $2
                   AND (kid_assignment_method IS NULL OR kid_assignment_method <> 'manual')
                 FOR UPDATE`,
            manual
              ? [
                  item.transactionId,
                  input.connectorId,
                  item.stateSnapshot.manualDecisionAction,
                  item.stateSnapshot.manualDecidedAt,
                  item.stateSnapshot.assignedKidId,
                ]
              : [item.transactionId, input.connectorId],
          );
          if (current.length === 0) continue;
          if (!manual) {
            await client.query(
              `UPDATE finance_transactions
               SET attribution_source_ref = COALESCE($1, attribution_source_ref),
                   attribution_contract_version = $2,
                   attribution_status = 'unavailable',
                   attribution_confidence = 'none',
                   attribution_method = 'unavailable',
                   attribution_explanation = $3,
                   attribution_reasons = $4::jsonb,
                   attribution_decision_source = 'fallback',
                   attribution_review_state = 'pending',
                   attribution_provenance = $5,
                   attribution_last_error_code = $6,
                   attribution_retryable = $7,
                   attribution_updated_at = $8
               WHERE id = $9 AND connector_instance_id = $10
                 AND (kid_assignment_method IS NULL OR kid_assignment_method <> 'manual')`,
              [
                item.sourceRef,
                input.contractVersion,
                input.failure.explanation,
                JSON.stringify([input.failure.reason]),
                input.provenance,
                input.failure.code,
                input.failure.retryable,
                input.now,
                item.transactionId,
                input.connectorId,
              ],
            );
          }
          await reviewException(client, item, {
            connectorId: input.connectorId,
            now: input.now,
            reasonCode: input.failure.code,
            retryable: input.failure.retryable,
            policyVersion: null,
          });
        }
      });
    },

    async finish(command) {
      const fenceClause = command.fenceMode === 'row-generation'
        ? ''
        : `AND (
             current_generation_id = $9
             OR (current_generation_id IS NULL AND last_successful_generation_id = $9)
           )`;
      const result = await pool.query(
        `UPDATE finance_sync_state
         SET attribution_status = $1,
             attribution_last_attempt_at = $2,
             attribution_last_successful_at = CASE WHEN $3 THEN $2
               ELSE attribution_last_successful_at END,
             attribution_last_error_code = $4,
             attribution_policy_version = COALESCE($5, attribution_policy_version),
             attribution_engine_version = CASE WHEN $6 THEN $7
               ELSE attribution_engine_version END,
             updated_at = $2
         WHERE connector_id = $8
           ${fenceClause}`,
        [
          command.status,
          command.attemptedAt,
          command.succeeded && !command.terminalFailureCode,
          command.terminalFailureCode,
          command.policyVersion,
          command.succeeded,
          command.engineVersion,
          command.connectorId,
          ...(command.fenceMode === 'row-generation' ? [] : [command.generationId]),
        ],
      );
      return { recorded: result.rowCount === 1 };
    },

    async listExceptions(request) {
      return transaction(pool, async (client) => {
        await requireFinanceConnector(client, request.connectorId);
        const conditions = ['e.connector_id = $1'];
        const parameters: unknown[] = [request.connectorId];
        if (request.status === 'current') {
          conditions.push(`e.status IN ('open', 'retry_requested')`);
        } else if (request.status !== 'all') {
          parameters.push(request.status);
          conditions.push(`e.status = $${parameters.length}`);
        }
        if (request.cursor) {
          parameters.push(request.cursor.updatedAt, request.cursor.id);
          const updatedAtIndex = parameters.length - 1;
          const idIndex = parameters.length;
          conditions.push(
            `(e.updated_at < $${updatedAtIndex}`
            + ` OR (e.updated_at = $${updatedAtIndex} AND e.id < $${idIndex}))`,
          );
        }
        parameters.push(request.limit + 1);
        const rows = await query<
          Omit<FinanceAttributionExceptionView, 'reasons'> & { reasons: unknown }
        >(client, `
          SELECT e.id, e.status,
                 e.reason_code AS "reasonCode", e.retryable,
                 e.review_state AS "reviewState",
                 e.policy_version AS "policyVersion",
                 e.occurrence_count AS "occurrenceCount",
                 e.first_observed_at AS "firstObservedAt",
                 e.last_observed_at AS "lastObservedAt", e.updated_at AS "updatedAt",
                 t.date, t.merchant_name AS "merchantName",
                 t.assigned_kid_id AS "assignedKidId",
                 t.attribution_status AS "attributionStatus",
                 t.attribution_confidence AS "confidence",
                 t.attribution_method AS "method",
                 t.attribution_explanation AS "explanation",
                 t.attribution_reasons AS "reasons",
                 t.attribution_decision_source AS "decisionSource",
                 t.attribution_engine_version AS "engineVersion",
                 t.attribution_evaluated_at AS "evaluatedAt"
          FROM finance_attribution_exceptions e
          INNER JOIN finance_transactions t
            ON t.id = e.transaction_id
            AND t.connector_instance_id = e.connector_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY e.updated_at DESC, e.id DESC
          LIMIT $${parameters.length}
        `, parameters);
        const hasMore = rows.length > request.limit;
        const page = hasMore ? rows.slice(0, request.limit) : rows;
        const subjects = await query<FinanceAttributionSubjectView>(client, `
          SELECT subjects.kid_id AS "kidId",
                 COALESCE(NULLIF(profiles.name, ''), 'Household member') AS name
          FROM finance_attribution_subjects subjects
          INNER JOIN finance_sync_state state
            ON state.connector_id = subjects.connector_id
            AND state.attribution_policy_version = subjects.policy_version
          LEFT JOIN kid_profiles profiles ON profiles.id = subjects.kid_id
          WHERE subjects.connector_id = $1
          ORDER BY name, subjects.kid_id
        `, [request.connectorId]);
        return {
          exceptions: page.map((row) => ({
            ...row,
            retryable: row.retryable === true,
            reasons: normalizeReasons(row.reasons),
          })),
          hasMore,
          subjects,
        };
      });
    },

    async applyManualDecision(command) {
      assertManualDecisionShape(command.action, command.kidId);
      const existing = await findAttributionActionAudit(
        pool,
        command.connectorId,
        command.idempotencyKey,
      );
      if (existing) {
        assertManualDecisionReplay(existing, command);
        return {
          status: 'resolved',
          transactionId: command.transactionId,
          kidId: command.kidId,
          replayed: true,
        };
      }
      const replayed = await transaction(pool, async (client) => (
        applyManualDecisionInTransaction(client, idFactory, command)
      ));
      return {
        status: 'resolved',
        transactionId: command.transactionId,
        kidId: command.kidId,
        replayed,
      };
    },

    async actOnException(command) {
      const existing = await findAttributionActionAudit(
        pool,
        command.connectorId,
        command.idempotencyKey,
      );
      if (existing) {
        assertExceptionActionReplay(existing, command);
        return {
          status: existing.resultStatus,
          exceptionId: command.exceptionId,
          replayed: true,
          retryScheduled: false,
        };
      }
      if (command.action === 'approve' || command.action === 'manual-resolve') {
        const auditAction = command.action;
        const replayed = await transaction(pool, async (client) => {
          await requireFinanceConnector(client, command.connectorId);
          const exception = await readExceptionForAction(client, command);
          const kidId = auditAction === 'approve'
            ? exception.assignedKidId
            : command.kidId ?? null;
          const action: FinanceManualAction = kidId ? 'assign-kid' : 'parent-expense';
          assertManualDecisionShape(action, kidId);
          return applyManualDecisionInTransaction(client, idFactory, {
            connectorId: command.connectorId,
            transactionId: exception.transactionId,
            action,
            kidId,
            idempotencyKey: command.idempotencyKey,
            auditAction,
            actorType: command.actorType,
            exceptionId: exception.id,
            expectedExceptionUpdatedAt: command.expectedUpdatedAt,
            expectedTransactionVersion: null,
            now: command.now,
          });
        });
        return {
          status: 'resolved',
          exceptionId: command.exceptionId,
          replayed,
          retryScheduled: false,
        };
      }
      const action = command.action;
      const replayed = await transaction(pool, async (client) => {
        const concurrent = await findAttributionActionAudit(
          client,
          command.connectorId,
          command.idempotencyKey,
        );
        if (concurrent) {
          assertExceptionActionReplay(concurrent, command);
          return true;
        }
        await requireFinanceConnector(client, command.connectorId);
        const [currentException] = await query<{
          id: string;
          transactionId: string;
          status: string;
          retryable: boolean;
          updatedAt: string;
          manualDecidedAt: string | null;
        }>(client, `
          SELECT e.id, e.transaction_id AS "transactionId", e.status, e.retryable,
                 e.updated_at AS "updatedAt",
                 t.manual_decided_at AS "manualDecidedAt"
          FROM finance_attribution_exceptions e
          INNER JOIN finance_transactions t
            ON t.id = e.transaction_id
            AND t.connector_instance_id = e.connector_id
          WHERE e.id = $1 AND e.connector_id = $2
          FOR UPDATE OF e, t
        `, [command.exceptionId, command.connectorId]);
        if (!currentException) {
          throw new FinanceAttributionMutationError(
            'exception_not_found',
            'Attribution exception was not found',
            404,
          );
        }
        if (!['open', 'retry_requested'].includes(currentException.status)) {
          throw new FinanceAttributionMutationError(
            'exception_conflict',
            'This exception was already resolved by a newer decision',
            409,
          );
        }
        if (currentException.updatedAt !== command.expectedUpdatedAt) {
          throw new FinanceAttributionMutationError(
            'exception_conflict',
            'This exception changed after it was loaded',
            409,
          );
        }
        if (action === 'retry' && currentException.retryable !== true) {
          throw new FinanceAttributionMutationError(
            'exception_not_retryable',
            'Attribution exception is not retryable',
            409,
          );
        }
        if (
          currentException.manualDecidedAt
          && Date.parse(currentException.manualDecidedAt)
            > Date.parse(currentException.updatedAt)
        ) {
          throw new FinanceAttributionMutationError(
            'manual_decision_superseded',
            'A newer manual decision already exists',
            409,
          );
        }
        await client.query(`
          UPDATE finance_attribution_exceptions
          SET status = $1, review_state = $2, resolution = $3,
              resolved_at = $4, updated_at = $5
          WHERE id = $6 AND connector_id = $7
        `, [
          action === 'retry' ? 'retry_requested' : 'dismissed',
          action === 'retry' ? 'pending' : 'resolved',
          action === 'dismiss' ? 'dismissed' : null,
          action === 'dismiss' ? command.now : null,
          command.now,
          currentException.id,
          command.connectorId,
        ]);
        if (action === 'retry') {
          await client.query(`
            UPDATE finance_transactions
            SET attribution_status = 'pending',
                attribution_review_state = 'pending',
                attribution_updated_at = $1
            WHERE id = $2 AND connector_instance_id = $3
          `, [command.now, currentException.transactionId, command.connectorId]);
        } else {
          await client.query(`
            UPDATE finance_transactions
            SET attribution_review_state = 'resolved',
                attribution_updated_at = $1
            WHERE id = $2 AND connector_instance_id = $3
          `, [command.now, currentException.transactionId, command.connectorId]);
        }
        await client.query(`
          INSERT INTO finance_attribution_audit (
            id, connector_id, transaction_id, exception_id, idempotency_key,
            action, actor_type, requested_kid_id, requested_decision,
            result_status, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8, $9)
        `, [
          idFactory(),
          command.connectorId,
          currentException.transactionId,
          currentException.id,
          command.idempotencyKey,
          action,
          command.actorType,
          action === 'retry' ? 'retry_requested' : 'dismissed',
          command.now,
        ]);
        return false;
      });
      return {
        status: action === 'retry' ? 'retry_requested' : 'dismissed',
        exceptionId: command.exceptionId,
        replayed,
        retryScheduled: action === 'retry' && !replayed,
      };
    },
  };
}

export function createPostgresFinanceWorkerPersistence(
  pool: Pool,
  options: PostgresFinanceAdapterOptions = {},
): FinanceCorePersistence {
  const idFactory = options.idFactory ?? randomUUID;
  return {
    identity: {
      async ensureNamespace(input) {
        return transaction(pool, async (client) => {
          await client.query(
            `UPDATE connector_configs
             SET credentials = jsonb_set(
                   COALESCE(credentials, '{}'::jsonb),
                   '{${FINANCE_IDENTITY_NAMESPACE_CREDENTIAL}}',
                   to_jsonb($1::text),
                   true
                 ),
                 updated_at = $2
             WHERE id = $3
               AND NOT (
                 COALESCE(credentials, '{}'::jsonb)
                 ? '${FINANCE_IDENTITY_NAMESPACE_CREDENTIAL}'
               )`,
            [input.candidate, input.updatedAt, input.connectorId],
          );
          const rows = await query<{ credentials: unknown }>(
            client,
            `SELECT credentials FROM connector_configs WHERE id = $1 FOR UPDATE`,
            [input.connectorId],
          );
          if (!rows[0]) {
            throw new Error('Finance connector identity state is unavailable');
          }
          return acceptedNamespace(rows[0].credentials);
        });
      },
    },
    snapshots: createSnapshotPersistence(pool),
    datasets: createDatasetPersistence(pool),
    attribution: createAttributionPersistence(pool, idFactory),
    assistant: createPostgresFinanceAssistantPersistence(pool, { idFactory }),
  };
}
