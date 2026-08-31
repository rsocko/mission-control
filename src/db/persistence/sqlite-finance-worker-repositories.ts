import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  FINANCE_ATTRIBUTION_READ_MAX,
  FINANCE_ATTRIBUTION_WRITE_MAX,
  FinanceAttributionFenceError,
  type FinanceAttributionApplyItem,
  type FinanceAttributionPersistence,
  type FinanceAttributionRow,
  type FinanceAttributionStateSnapshot,
  type FinanceAttributionUnavailableItem,
} from './finance-attribution';
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
} from './finance-datasets';
import {
  FINANCE_TRANSACTION_PAGE_MAX,
  FinanceSnapshotFenceError,
  type FinanceSnapshotPersistence,
  type FinanceSnapshotProjectionProof,
  type FinanceSnapshotTransaction,
} from './finance-snapshot';
import {
  FINANCE_IDENTITY_NAMESPACE_CREDENTIAL,
  type FinanceCorePersistence,
} from './finance-worker';

type SqliteDatabase = Database.Database;

interface FinanceDatasetProjectionProof {
  itemCount: number;
  contentDigest: string;
  bridgeContractVersion: string;
}

export interface SqliteFinanceProjectionProofs {
  snapshot(input: {
    connectorId: string;
    projectionStartDate: string;
    windowStart: string;
    windowEnd: string;
  }): FinanceSnapshotProjectionProof;
  dataset(
    connectorId: string,
    dataset: FinanceDataset,
  ): FinanceDatasetProjectionProof | null;
}

interface SqliteFinanceAdapterOptions {
  projectionProofs?: SqliteFinanceProjectionProofs;
  idFactory?: () => string;
}

const identityNamespacePattern = /^[a-f0-9]{64}$/;

function localId(prefix: string, connectorId: string, upstreamId: string): string {
  return `finance:${prefix}:${connectorId}:${upstreamId}`;
}

function localTransactionId(connectorId: string, upstreamId: string): string {
  return `finance:${connectorId}:${upstreamId}`;
}

function stableValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function transactionFingerprint(transaction: FinanceSnapshotTransaction): string {
  return stableValue(transaction);
}

function parseCredentials(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return (value as Record<string, unknown> | null) ?? {};
}

function acceptedNamespace(credentials: unknown): string {
  const namespace = parseCredentials(credentials)[FINANCE_IDENTITY_NAMESPACE_CREDENTIAL];
  if (typeof namespace !== 'string' || !identityNamespacePattern.test(namespace)) {
    throw new Error('Finance connector identity state is invalid');
  }
  return namespace;
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

function stateSnapshotMatches(
  sqlite: SqliteDatabase,
  connectorId: string,
  transactionId: string,
  snapshot: FinanceAttributionStateSnapshot,
): boolean {
  if (snapshot.kidAssignmentMethod !== 'manual') {
    return sqlite.prepare(`
      SELECT 1 FROM finance_transactions
      WHERE id = ? AND connector_instance_id = ?
        AND (kid_assignment_method IS NULL OR kid_assignment_method <> 'manual')
    `).get(transactionId, connectorId) !== undefined;
  }
  return sqlite.prepare(`
    SELECT 1 FROM finance_transactions
    WHERE id = ? AND connector_instance_id = ?
      AND kid_assignment_method = 'manual'
      AND manual_decision_action IS ?
      AND manual_decided_at IS ?
      AND assigned_kid_id IS ?
  `).get(
    transactionId,
    connectorId,
    snapshot.manualDecisionAction,
    snapshot.manualDecidedAt,
    snapshot.assignedKidId,
  ) !== undefined;
}

type ExceptionStatus = 'open' | 'retry_requested' | 'resolved' | 'dismissed';

function upsertException(
  sqlite: SqliteDatabase,
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
): 'pending' | 'resolved' {
  const existing = sqlite.prepare(`
    SELECT id, status, reason_code AS reasonCode,
           source_fingerprint AS sourceFingerprint,
           policy_version AS policyVersion
    FROM finance_attribution_exceptions
    WHERE connector_id = ? AND transaction_id = ?
  `).get(input.connectorId, input.transactionId) as
    | {
        id: string;
        status: ExceptionStatus;
        reasonCode: string;
        sourceFingerprint: string;
        policyVersion: number | null;
      }
    | undefined;
  if (!existing) {
    sqlite.prepare(`
      INSERT INTO finance_attribution_exceptions (
        id, connector_id, transaction_id, source_ref, status, reason_code,
        retryable, review_state, source_fingerprint, policy_version,
        occurrence_count, created_at, first_observed_at, last_observed_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'open', ?, ?, 'pending', ?, ?, 1, ?, ?, ?, ?)
    `).run(
      idFactory(),
      input.connectorId,
      input.transactionId,
      input.sourceRef,
      input.reasonCode,
      input.retryable ? 1 : 0,
      input.sourceFingerprint,
      input.policyVersion,
      input.now,
      input.now,
      input.now,
      input.now,
    );
    return 'pending';
  }
  const unchanged = existing.reasonCode === input.reasonCode
    && existing.sourceFingerprint === input.sourceFingerprint
    && existing.policyVersion === input.policyVersion;
  const preserveResolution = unchanged
    && (existing.status === 'resolved' || existing.status === 'dismissed');
  sqlite.prepare(`
    UPDATE finance_attribution_exceptions
    SET source_ref = COALESCE(?, source_ref), status = ?, reason_code = ?, retryable = ?,
        review_state = ?, source_fingerprint = ?, policy_version = ?,
        occurrence_count = occurrence_count + 1, last_observed_at = ?,
        resolution = CASE WHEN ? THEN resolution ELSE NULL END,
        resolved_at = CASE WHEN ? THEN resolved_at ELSE NULL END,
        updated_at = ?
    WHERE id = ?
  `).run(
    input.sourceRef,
    preserveResolution ? existing.status : 'open',
    input.reasonCode,
    input.retryable ? 1 : 0,
    preserveResolution ? 'resolved' : 'pending',
    input.sourceFingerprint,
    input.policyVersion,
    input.now,
    preserveResolution ? 1 : 0,
    preserveResolution ? 1 : 0,
    input.now,
    existing.id,
  );
  return preserveResolution ? 'resolved' : 'pending';
}

function preserveClosedTransactionReview(
  sqlite: SqliteDatabase,
  connectorId: string,
  transactionId: string,
  reviewState: 'pending' | 'resolved',
  now: string,
): void {
  if (reviewState !== 'resolved') return;
  sqlite.prepare(`
    UPDATE finance_transactions
    SET attribution_review_state = 'resolved', attribution_updated_at = ?
    WHERE id = ? AND connector_instance_id = ?
  `).run(now, transactionId, connectorId);
}

function resolveCurrentException(
  sqlite: SqliteDatabase,
  connectorId: string,
  transactionId: string,
  now: string,
): void {
  sqlite.prepare(`
    UPDATE finance_attribution_exceptions
    SET status = CASE WHEN status = 'dismissed' THEN 'dismissed' ELSE 'resolved' END,
        review_state = 'resolved',
        resolution = CASE WHEN status = 'dismissed' THEN resolution ELSE 'reattributed' END,
        resolved_at = COALESCE(resolved_at, ?),
        updated_at = ?
    WHERE connector_id = ? AND transaction_id = ?
  `).run(now, now, connectorId, transactionId);
}

function createSnapshotPersistence(
  sqlite: SqliteDatabase,
  projectionProofs: SqliteFinanceProjectionProofs | undefined,
): FinanceSnapshotPersistence {
  return {
    async readBasis(connectorId, stableTagRecoveryStart) {
      const state = sqlite.prepare(`
        SELECT last_successful_window_end AS lastSuccessfulWindowEnd
        FROM finance_sync_state
        WHERE connector_id = ?
      `).get(connectorId) as { lastSuccessfulWindowEnd: string | null } | undefined;
      const needsStableTagBackfill = sqlite.prepare(`
        SELECT 1
        FROM finance_transactions
        WHERE connector_instance_id = ? AND lifecycle_status = 'active'
          AND date >= ? AND tags <> '[]' AND tag_references = '[]'
        LIMIT 1
      `).get(connectorId, stableTagRecoveryStart) !== undefined;
      return {
        lastSuccessfulWindowEnd: state?.lastSuccessfulWindowEnd ?? null,
        needsStableTagBackfill,
      };
    },

    async start(command) {
      sqlite.transaction(() => {
        sqlite.prepare(`
          INSERT INTO finance_sync_state (
            connector_id, status, current_generation_id, current_window_start,
            current_window_end, last_mode, last_attempt_at, created_at, updated_at
          ) VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(connector_id) DO UPDATE SET
            status = 'running',
            current_generation_id = excluded.current_generation_id,
            current_window_start = excluded.current_window_start,
            current_window_end = excluded.current_window_end,
            last_mode = excluded.last_mode,
            last_attempt_at = excluded.last_attempt_at,
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = excluded.updated_at
        `).run(
          command.connectorId,
          command.generationId,
          command.windowStart,
          command.windowEnd,
          command.mode,
          command.attemptAt,
          command.attemptAt,
          command.attemptAt,
        );
      }).immediate();
    },

    async upsertPage(command) {
      assertBatch(
        command.transactions.length,
        FINANCE_TRANSACTION_PAGE_MAX,
        'Finance transaction page',
      );
      return sqlite.transaction(() => {
        const fence = sqlite.prepare(`
          SELECT 1 FROM finance_sync_state
          WHERE connector_id = ? AND status = 'running' AND current_generation_id = ?
        `).get(command.connectorId, command.generationId);
        if (!fence) throw new FinanceSnapshotFenceError();

        const find = sqlite.prepare(`
          SELECT id, source_fingerprint AS sourceFingerprint
          FROM finance_transactions
          WHERE connector_instance_id = ? AND upstream_transaction_id = ?
        `);
        const insert = sqlite.prepare(`
          INSERT INTO finance_transactions (
            id, connector_instance_id, upstream_transaction_id, date, amount,
            merchant_name, merchant_logo_url, category_id, original_category,
            confirmed_category, account_id, account_name, card_last4,
            assigned_kid_id, kid_assignment_method, triage_status, flag_reason,
            is_pending, is_recurring, notes, tags, tag_references, lifecycle_status, deleted_at,
            provenance_provider, provenance_fetched_at, source_fingerprint, source_url,
            last_seen_generation_id, first_seen_at, last_seen_at, synced_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?,
            NULL, NULL, 'pending', NULL, ?, ?, ?, ?, ?, 'active', NULL,
            ?, ?, ?, NULL, ?, ?, ?, ?
          )
        `);
        const update = sqlite.prepare(`
          UPDATE finance_transactions
          SET date = ?, amount = ?, merchant_name = ?, merchant_logo_url = ?,
              category_id = ?, original_category = ?, account_id = ?, account_name = ?,
              card_last4 = ?, is_pending = ?, is_recurring = ?, notes = ?, tags = ?,
              tag_references = ?,
              lifecycle_status = 'active', deleted_at = NULL, provenance_provider = ?,
              provenance_fetched_at = ?, source_fingerprint = ?,
              last_seen_generation_id = ?, last_seen_at = ?, synced_at = ?
          WHERE connector_instance_id = ? AND upstream_transaction_id = ?
        `);
        let added = 0;
        let updated = 0;
        for (const transaction of command.transactions) {
          const hash = transactionFingerprint(transaction);
          const existing = find.get(command.connectorId, transaction.id) as
            | { id: string; sourceFingerprint: string }
            | undefined;
          const values = [
            transaction.date,
            transaction.amount,
            transaction.merchant.name,
            transaction.merchant.logoUrl,
            transaction.category?.id ?? null,
            transaction.category?.name ?? null,
            transaction.account.id,
            transaction.account.displayName,
            transaction.account.mask,
            transaction.isPending ? 1 : 0,
            transaction.isRecurring ? 1 : 0,
            transaction.notes,
            JSON.stringify(transaction.tags),
            JSON.stringify(transaction.tagReferences.map((tag) => tag.id)),
          ] as const;
          if (!existing) {
            insert.run(
              localTransactionId(command.connectorId, transaction.id),
              command.connectorId,
              transaction.id,
              ...values,
              command.provenance.provider,
              command.provenance.fetchedAt,
              hash,
              command.generationId,
              command.observedAt,
              command.observedAt,
              command.observedAt,
            );
            added++;
          } else {
            update.run(
              ...values,
              command.provenance.provider,
              command.provenance.fetchedAt,
              hash,
              command.generationId,
              command.observedAt,
              command.observedAt,
              command.connectorId,
              transaction.id,
            );
            if (existing.sourceFingerprint !== hash) updated++;
          }
        }
        return { added, updated };
      }).immediate();
    },

    async complete(command) {
      return sqlite.transaction(() => {
        const fence = sqlite.prepare(`
          SELECT 1 FROM finance_sync_state
          WHERE connector_id = ? AND status = 'running' AND current_generation_id = ?
        `).get(command.connectorId, command.generationId);
        if (!fence) throw new FinanceSnapshotFenceError();

        const removed = sqlite.prepare(`
          UPDATE finance_transactions
          SET lifecycle_status = 'deleted', deleted_at = ?, synced_at = ?
          WHERE connector_instance_id = ?
            AND lifecycle_status = 'active'
            AND date >= ? AND date <= ?
            AND (last_seen_generation_id IS NULL OR last_seen_generation_id <> ?)
        `).run(
          command.completedAt,
          command.completedAt,
          command.connectorId,
          command.windowStart,
          command.windowEnd,
          command.generationId,
        ).changes;
        sqlite.prepare(`
          UPDATE finance_attribution_exceptions
          SET status = 'dismissed', review_state = 'resolved',
              resolution = 'dismissed', resolved_at = COALESCE(resolved_at, ?),
              updated_at = ?
          WHERE connector_id = ?
            AND transaction_id IN (
              SELECT id FROM finance_transactions
              WHERE connector_instance_id = ? AND lifecycle_status = 'deleted'
                AND deleted_at = ?
            )
        `).run(
          command.completedAt,
          command.completedAt,
          command.connectorId,
          command.connectorId,
          command.completedAt,
        );
        const proof = projectionProofs?.snapshot({
          connectorId: command.connectorId,
          projectionStartDate: command.projectionStartDate,
          windowStart: command.windowStart,
          windowEnd: command.windowEnd,
        });
        const result = sqlite.prepare(`
          UPDATE finance_sync_state
          SET status = 'succeeded', current_generation_id = NULL,
              current_window_start = NULL, current_window_end = NULL,
              last_successful_generation_id = ?,
              last_successful_source_as_of = ?, last_successful_sync_at = ?,
              last_successful_item_count = ?,
              last_successful_content_digest = ?,
              last_successful_projection_start_date = ?,
              last_successful_projection_coverage_start = ?,
              last_successful_projection_coverage_end = ?,
              last_successful_bridge_contract_version = ?,
              last_successful_window_start = ?,
              last_successful_window_end = ?, last_error_code = NULL,
              last_error_message = NULL, last_added = ?, last_updated = ?,
              last_deleted = ?, updated_at = ?
          WHERE connector_id = ? AND current_generation_id = ?
        `).run(
          command.generationId,
          command.sourceAsOf,
          command.completedAt,
          proof?.itemCount ?? null,
          proof?.contentDigest ?? null,
          proof?.projectionStartDate ?? null,
          proof?.coverageStart ?? null,
          proof?.coverageEnd ?? null,
          proof?.bridgeContractVersion ?? null,
          command.windowStart,
          command.windowEnd,
          command.added,
          command.updated,
          removed,
          command.completedAt,
          command.connectorId,
          command.generationId,
        );
        if (result.changes !== 1) throw new FinanceSnapshotFenceError();
        return { removed };
      }).immediate();
    },

    async fail(command) {
      const result = sqlite.prepare(`
        UPDATE finance_sync_state
        SET status = 'failed', last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE connector_id = ? AND current_generation_id = ?
      `).run(
        command.errorCode,
        command.errorMessage,
        command.failedAt,
        command.connectorId,
        command.generationId,
      );
      return { recorded: result.changes === 1 };
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
  insertColumns: string;
  insertPlaceholders: string;
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
        insertColumns: 'display_name, type, institution, mask, is_active, source_is_active',
        insertPlaceholders: '?, ?, ?, ?, ?, ?',
        updateAssignments: `display_name = excluded.display_name, type = excluded.type,
          institution = excluded.institution, mask = excluded.mask,
          is_active = excluded.is_active, source_is_active = excluded.source_is_active`,
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
            item.isActive ? 1 : 0,
            item.isActive ? 1 : 0,
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
        insertColumns: 'name, upstream_group_id, group_name, icon, is_active, source_is_active',
        insertPlaceholders: '?, ?, ?, ?, ?, ?',
        updateAssignments: `name = excluded.name, upstream_group_id = excluded.upstream_group_id,
          group_name = excluded.group_name, icon = excluded.icon,
          is_active = excluded.is_active, source_is_active = excluded.source_is_active`,
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
            item.isActive ? 1 : 0,
            item.isActive ? 1 : 0,
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
        insertColumns: 'name, is_active, source_is_active',
        insertPlaceholders: '?, ?, ?',
        updateAssignments: `name = excluded.name, is_active = excluded.is_active,
          source_is_active = excluded.source_is_active`,
        values: (raw) => {
          const item = raw as { name: string; isActive: boolean };
          return [item.name, item.isActive ? 1 : 0, item.isActive ? 1 : 0];
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
        isActive: row.source_is_active === 1,
      });
    case 'categories':
      return stableValue({
        id: row.upstream_category_id,
        name: row.name,
        groupId: row.upstream_group_id,
        group: row.group_name,
        icon: row.icon,
        isActive: row.source_is_active === 1,
      });
    default:
      return stableValue({
        id: dataset === 'category-groups' ? row.upstream_group_id : row.upstream_tag_id,
        name: row.name,
        isActive: row.source_is_active === 1,
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

function createDatasetPersistence(
  sqlite: SqliteDatabase,
  projectionProofs: SqliteFinanceProjectionProofs | undefined,
): FinanceDatasetPersistence {
  function assertAttemptCurrent(metadata: FinanceDatasetPublicationMetadata): void {
    const state = sqlite.prepare(`
      SELECT last_attempt_at AS lastAttemptAt
      FROM finance_dataset_sync_state
      WHERE connector_id = ? AND dataset = ?
    `).get(metadata.connectorId, metadata.dataset) as { lastAttemptAt: string } | undefined;
    if (state?.lastAttemptAt !== metadata.attemptAt) throw new FinanceDatasetFenceError();
  }

  function recordSuccess(
    metadata: FinanceDatasetPublicationMetadata,
    generationId: string,
    count: number,
  ): void {
    const current = sqlite.prepare(`
      SELECT current_generation_id AS generationId,
             previous_generation_id AS previousGenerationId
      FROM finance_dataset_sync_state
      WHERE connector_id = ? AND dataset = ?
    `).get(metadata.connectorId, metadata.dataset) as {
      generationId: string | null;
      previousGenerationId: string | null;
    } | undefined;
    const proof = projectionProofs?.dataset(metadata.connectorId, metadata.dataset) ?? null;
    const result = sqlite.prepare(`
      UPDATE finance_dataset_sync_state
      SET last_attempt_outcome = 'succeeded', last_successful_at = ?,
          source_as_of = ?, fresh_until = ?, coverage_start = ?, coverage_end = ?,
          previous_generation_id = ?, current_generation_id = ?,
          schema_version = ?, config_version = ?, published_item_count = ?,
          insight_item_count = ?, insight_content_digest = ?,
          insight_bridge_contract_version = ?,
          source_limit = ?, last_error_code = NULL, updated_at = ?
      WHERE connector_id = ? AND dataset = ? AND last_attempt_at = ?
    `).run(
      metadata.completedAt,
      metadata.sourceAsOf,
      metadata.freshUntil,
      metadata.coverageStart,
      metadata.coverageEnd,
      current?.generationId === generationId
        ? current.previousGenerationId
        : current?.generationId ?? null,
      generationId,
      metadata.schemaVersion,
      metadata.configVersion,
      count,
      proof?.itemCount ?? null,
      proof?.contentDigest ?? null,
      proof?.bridgeContractVersion ?? null,
      metadata.sourceLimit,
      metadata.completedAt,
      metadata.connectorId,
      metadata.dataset,
      metadata.attemptAt,
    );
    if (result.changes !== 1) throw new FinanceDatasetFenceError();
  }

  function currentSnapshotCount(
    table: 'finance_recurring_obligations' | 'finance_budget_snapshots',
    connectorId: string,
  ): number {
    return (sqlite.prepare(`
      SELECT count(*) AS count FROM ${table}
      WHERE connector_id = ? AND is_current = 1
    `).get(connectorId) as { count: number }).count;
  }

  function rotateSnapshots(
    table: 'finance_recurring_obligations' | 'finance_budget_snapshots',
    connectorId: string,
    generationId: string,
    previousGenerationId: string | null,
  ): void {
    sqlite.prepare(`
      UPDATE ${table} SET is_current = 0
      WHERE connector_id = ? AND generation_id <> ?
    `).run(connectorId, generationId);
    sqlite.prepare(`
      DELETE FROM ${table}
      WHERE connector_id = ? AND generation_id NOT IN (?, ?)
    `).run(connectorId, generationId, previousGenerationId ?? generationId);
  }

  function currentGeneration(connectorId: string, dataset: FinanceDataset) {
    return (sqlite.prepare(`
      SELECT current_generation_id AS currentGenerationId,
             previous_generation_id AS previousGenerationId
      FROM finance_dataset_sync_state
      WHERE connector_id = ? AND dataset = ?
    `).get(connectorId, dataset) as {
      currentGenerationId: string | null;
      previousGenerationId: string | null;
    } | undefined) ?? {
      currentGenerationId: null,
      previousGenerationId: null,
    };
  }

  return {
    async listState(connectorId): Promise<FinanceDatasetState[]> {
      return sqlite.prepare(`
        SELECT dataset, last_attempt_at AS lastAttemptAt,
               last_attempt_outcome AS lastAttemptOutcome,
               last_successful_at AS lastSuccessfulAt,
               source_as_of AS sourceAsOf, fresh_until AS freshUntil,
               coverage_start AS coverageStart, coverage_end AS coverageEnd,
               current_generation_id AS currentGenerationId,
               previous_generation_id AS previousGenerationId,
               schema_version AS schemaVersion, config_version AS configVersion,
               published_item_count AS publishedItemCount, source_limit AS sourceLimit,
               last_error_code AS lastErrorCode
        FROM finance_dataset_sync_state
        WHERE connector_id = ?
      `).all(connectorId) as FinanceDatasetState[];
    },

    async recordAttempt(command) {
      sqlite.prepare(`
        INSERT INTO finance_dataset_sync_state (
          connector_id, dataset, last_attempt_at, source_limit,
          schema_version, config_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connector_id, dataset) DO UPDATE SET
          last_attempt_at = excluded.last_attempt_at,
          updated_at = excluded.updated_at
      `).run(
        command.connectorId,
        command.dataset,
        command.attemptAt,
        command.sourceLimit,
        command.schemaVersion,
        command.configVersion,
        command.attemptAt,
        command.attemptAt,
      );
    },

    async publishReference(command): Promise<FinanceDatasetPublishResult> {
      assertDatasetBatch(command.items.length, command.sourceLimit);
      const definition = referenceDefinition(command.dataset);
      return sqlite.transaction(() => {
        assertAttemptCurrent(command);
        const existingRows = sqlite.prepare(`
          SELECT * FROM ${definition.table} WHERE connector_id = ?
        `).all(command.connectorId) as Array<Record<string, unknown>>;
        const existing = new Map(existingRows.map((row) => [
          String(row[definition.sourceIdColumn]),
          stableReferenceRow(command.dataset, row),
        ]));
        let added = 0;
        let updated = 0;
        const upsert = sqlite.prepare(`
          INSERT INTO ${definition.table} (
            id, connector_id, ${definition.sourceIdColumn}, ${definition.insertColumns},
            last_seen_generation_id, first_seen_at, last_seen_at, deactivated_at
          ) VALUES (?, ?, ?, ${definition.insertPlaceholders}, ?, ?, ?, NULL)
          ON CONFLICT(connector_id, ${definition.sourceIdColumn}) DO UPDATE SET
            ${definition.updateAssignments},
            last_seen_generation_id = excluded.last_seen_generation_id,
            last_seen_at = excluded.last_seen_at,
            deactivated_at = CASE WHEN excluded.is_active = 1 THEN NULL
              ELSE COALESCE(${definition.table}.deactivated_at, excluded.last_seen_at) END
        `);
        for (const item of command.items) {
          const next = definition.comparable(item);
          const previous = existing.get(item.id);
          if (previous === undefined) added++;
          else if (previous !== next) updated++;
          upsert.run(
            localId(definition.localPrefix, command.connectorId, item.id),
            command.connectorId,
            item.id,
            ...definition.values(item),
            command.generationId,
            command.completedAt,
            command.completedAt,
          );
        }
        const removed = sqlite.prepare(`
          UPDATE ${definition.table}
          SET is_active = 0, deactivated_at = COALESCE(deactivated_at, ?)
          WHERE connector_id = ? AND is_active = 1 AND last_seen_generation_id <> ?
        `).run(command.completedAt, command.connectorId, command.generationId).changes;
        recordSuccess(command, command.generationId, command.items.length);
        return { added, updated, removed, count: command.items.length };
      }).immediate();
    },

    async publishRecurring(command): Promise<FinanceDatasetPublishResult> {
      assertDatasetBatch(command.items.length, command.sourceLimit);
      return sqlite.transaction(() => {
        assertAttemptCurrent(command);
        const current = currentGeneration(command.connectorId, 'recurring');
        const nextFingerprint = stableValue(command.items
          .map((item) => recurringComparable(item))
          .sort(binaryIdCompare));
        const currentFingerprint = stableValue((sqlite.prepare(`
          SELECT upstream_recurring_id AS id, merchant, amount, frequency,
                 next_expected_date AS nextExpectedDate,
                 upstream_account_id AS accountId, account_name AS accountName,
                 upstream_category_id AS categoryId, category_name AS categoryName
          FROM finance_recurring_obligations
          WHERE connector_id = ? AND is_current = 1
        `).all(command.connectorId) as Array<{ id: string }>).sort(binaryIdCompare));
        if (current.currentGenerationId && currentFingerprint === nextFingerprint) {
          recordSuccess(
            command,
            current.currentGenerationId,
            command.items.length,
          );
          return { added: 0, updated: 0, removed: 0, count: command.items.length };
        }
        const previousCount = currentSnapshotCount(
          'finance_recurring_obligations',
          command.connectorId,
        );
        const insert = sqlite.prepare(`
          INSERT INTO finance_recurring_obligations (
            id, connector_id, generation_id, upstream_recurring_id, merchant,
            amount, frequency, next_expected_date, upstream_account_id, account_name,
            upstream_category_id, category_name, is_current, source_as_of, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `);
        for (const item of command.items) {
          insert.run(
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
          );
        }
        rotateSnapshots(
          'finance_recurring_obligations',
          command.connectorId,
          command.generationId,
          current.currentGenerationId,
        );
        recordSuccess(command, command.generationId, command.items.length);
        return {
          added: command.items.length,
          updated: 0,
          removed: Math.max(0, previousCount - command.items.length),
          count: command.items.length,
        };
      }).immediate();
    },

    async publishBudgets(command): Promise<FinanceDatasetPublishResult> {
      assertDatasetBatch(command.items.length, command.sourceLimit);
      return sqlite.transaction(() => {
        assertAttemptCurrent(command);
        const current = currentGeneration(command.connectorId, 'budgets');
        const nextFingerprint = stableValue(command.items
          .map((item) => budgetComparable(item, command.periodStart, command.periodEnd))
          .sort(binaryIdCompare));
        const currentFingerprint = stableValue((sqlite.prepare(`
          SELECT upstream_category_id AS id, category_name AS categoryName,
                 period_start AS periodStart, period_end AS periodEnd,
                 budgeted, spent, remaining, percent_used AS percentUsed
          FROM finance_budget_snapshots
          WHERE connector_id = ? AND is_current = 1
        `).all(command.connectorId) as Array<{ id: string }>).sort(binaryIdCompare));
        if (current.currentGenerationId && currentFingerprint === nextFingerprint) {
          recordSuccess(
            command,
            current.currentGenerationId,
            command.items.length,
          );
          return { added: 0, updated: 0, removed: 0, count: command.items.length };
        }
        const previousCount = currentSnapshotCount(
          'finance_budget_snapshots',
          command.connectorId,
        );
        const insert = sqlite.prepare(`
          INSERT INTO finance_budget_snapshots (
            id, connector_id, generation_id, period_start, period_end,
            upstream_category_id, category_name, budgeted, spent, remaining,
            percent_used, is_current, source_as_of, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `);
        for (const item of command.items) {
          insert.run(
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
          );
        }
        rotateSnapshots(
          'finance_budget_snapshots',
          command.connectorId,
          command.generationId,
          current.currentGenerationId,
        );
        recordSuccess(command, command.generationId, command.items.length);
        return {
          added: command.items.length,
          updated: 0,
          removed: Math.max(0, previousCount - command.items.length),
          count: command.items.length,
        };
      }).immediate();
    },

    async recordFailure(command) {
      return sqlite.transaction(() => {
        const result = sqlite.prepare(`
          UPDATE finance_dataset_sync_state
          SET last_attempt_at = ?, last_attempt_outcome = 'failed',
              last_error_code = ?, updated_at = ?
          WHERE connector_id = ? AND dataset = ? AND last_attempt_at = ?
        `).run(
          command.failedAt,
          command.errorCode,
          command.failedAt,
          command.connectorId,
          command.dataset,
          command.attemptAt,
        );
        if (result.changes === 1) return { recorded: true };
        const inserted = sqlite.prepare(`
          INSERT INTO finance_dataset_sync_state (
            connector_id, dataset, last_attempt_at, last_attempt_outcome,
            source_limit, schema_version, config_version, last_error_code,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(connector_id, dataset) DO NOTHING
        `).run(
          command.connectorId,
          command.dataset,
          command.failedAt,
          command.sourceLimit,
          command.schemaVersion,
          command.configVersion,
          command.errorCode,
          command.failedAt,
          command.failedAt,
        );
        return { recorded: inserted.changes === 1 };
      }).immediate();
    },
  };
}

function createAttributionPersistence(
  sqlite: SqliteDatabase,
  idFactory: () => string,
): FinanceAttributionPersistence {
  function reviewException(
    item: FinanceAttributionApplyItem | FinanceAttributionUnavailableItem,
    input: {
      connectorId: string;
      now: string;
      reasonCode: string;
      retryable: boolean;
      policyVersion: number | null;
    },
  ): void {
    const reviewState = upsertException(sqlite, idFactory, {
      connectorId: input.connectorId,
      transactionId: item.transactionId,
      sourceRef: item.sourceRef,
      sourceFingerprint: item.sourceFingerprint,
      reasonCode: input.reasonCode,
      retryable: input.retryable,
      policyVersion: input.policyVersion,
      now: input.now,
    });
    preserveClosedTransactionReview(
      sqlite,
      input.connectorId,
      item.transactionId,
      reviewState,
      input.now,
    );
  }

  function assertAttributionFence(input: {
    connectorId: string;
    generationId: string;
    fenceMode?: 'snapshot' | 'row-generation';
    items: ReadonlyArray<{ transactionId: string }>;
  }): void {
    if (input.fenceMode === 'row-generation') {
      if (input.items.length === 0) return;
      const placeholders = input.items.map(() => '?').join(', ');
      const row = sqlite.prepare(`
        SELECT COUNT(DISTINCT id) AS count
        FROM finance_transactions
        WHERE connector_instance_id = ?
          AND last_seen_generation_id = ?
          AND id IN (${placeholders})
      `).get(
        input.connectorId,
        input.generationId,
        ...input.items.map((item) => item.transactionId),
      ) as { count: number };
      if (row.count !== input.items.length) throw new FinanceAttributionFenceError();
      return;
    }
    const fence = sqlite.prepare(`
      SELECT 1 FROM finance_sync_state
      WHERE connector_id = ? AND status = 'running' AND current_generation_id = ?
    `).get(input.connectorId, input.generationId);
    if (!fence) throw new FinanceAttributionFenceError();
  }

  return {
    async readRows(connectorId, upstreamTransactionIds) {
      assertBatch(
        upstreamTransactionIds.length,
        FINANCE_ATTRIBUTION_READ_MAX,
        'Finance attribution read',
      );
      if (upstreamTransactionIds.length === 0) return new Map();
      const placeholders = upstreamTransactionIds.map(() => '?').join(',');
      const rows = sqlite.prepare(`
        SELECT id,
               upstream_transaction_id AS upstreamTransactionId,
               assigned_kid_id AS assignedKidId,
               kid_assignment_method AS kidAssignmentMethod,
               manual_decision_action AS manualDecisionAction,
               manual_decided_at AS manualDecidedAt,
               source_fingerprint AS sourceFingerprint,
               first_seen_at AS firstSeenAt
        FROM finance_transactions
        WHERE connector_instance_id = ?
          AND upstream_transaction_id IN (${placeholders})
      `).all(connectorId, ...upstreamTransactionIds) as FinanceAttributionRow[];
      return new Map(rows.map((row) => [row.upstreamTransactionId, row]));
    },

    async applyResults(input) {
      assertBatch(
        input.items.length,
        FINANCE_ATTRIBUTION_WRITE_MAX,
        'Finance attribution result write',
      );
      sqlite.transaction(() => {
        assertAttributionFence(input);
        const updateAutomated = sqlite.prepare(`
          UPDATE finance_transactions
          SET assigned_kid_id = ?, kid_assignment_method = ?,
              attribution_source_ref = ?, attribution_contract_version = ?,
              attribution_status = ?, attribution_confidence = ?,
              attribution_method = ?, attribution_explanation = ?,
              attribution_reasons = ?, attribution_decision_source = ?,
              attribution_policy_version = ?, attribution_engine_version = ?,
              attribution_evaluated_at = ?, attribution_review_state = ?,
              attribution_provenance = ?, attribution_last_error_code = NULL,
              attribution_retryable = 0, attribution_updated_at = ?,
              triage_status = ?
          WHERE id = ? AND connector_instance_id = ?
            AND (kid_assignment_method IS NULL OR kid_assignment_method <> 'manual')
        `);
        const updateManual = sqlite.prepare(`
          UPDATE finance_transactions
          SET attribution_source_ref = ?, attribution_contract_version = ?,
              attribution_status = ?, attribution_confidence = ?,
              attribution_method = ?, attribution_explanation = ?,
              attribution_reasons = ?, attribution_decision_source = ?,
              attribution_policy_version = ?, attribution_engine_version = ?,
              attribution_evaluated_at = ?, attribution_review_state = ?,
              attribution_provenance = ?, attribution_last_error_code = NULL,
              attribution_retryable = 0, attribution_updated_at = ?
          WHERE id = ? AND connector_instance_id = ?
            AND kid_assignment_method = 'manual'
            AND manual_decision_action IS ?
            AND manual_decided_at IS ?
            AND assigned_kid_id IS ?
        `);
        const conflictUpdate = sqlite.prepare(`
          UPDATE finance_transactions
          SET attribution_source_ref = ?, attribution_contract_version = ?,
              attribution_status = 'pending', attribution_confidence = 'none',
              attribution_method = 'manual',
              attribution_explanation = 'Manual decision requires policy review',
              attribution_reasons = '["policy-version-mismatch"]',
              attribution_decision_source = 'manual',
              attribution_policy_version = ?, attribution_engine_version = ?,
              attribution_evaluated_at = ?, attribution_review_state = 'pending',
              attribution_provenance = ?, attribution_last_error_code = ?,
              attribution_retryable = 0, attribution_updated_at = ?
          WHERE id = ? AND connector_instance_id = ?
            AND kid_assignment_method = 'manual'
            AND manual_decision_action IS ?
            AND manual_decided_at IS ?
            AND assigned_kid_id IS ?
        `);
        const upsertSubject = sqlite.prepare(`
          INSERT INTO finance_attribution_subjects (
            id, connector_id, kid_id, policy_version, engine_version,
            first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(connector_id, kid_id) DO UPDATE SET
            policy_version = excluded.policy_version,
            engine_version = excluded.engine_version,
            last_seen_at = excluded.last_seen_at
        `);
        for (const item of input.items) {
          const result = item.result;
          if (!item.manualResultMatches) {
            const updated = conflictUpdate.run(
              item.sourceRef,
              result.contractVersion,
              result.policyVersion,
              result.engineVersion,
              result.evaluatedAt,
              input.provenance,
              'manual_decision_conflict',
              input.now,
              item.transactionId,
              input.connectorId,
              item.stateSnapshot.manualDecisionAction,
              item.stateSnapshot.manualDecidedAt,
              item.stateSnapshot.assignedKidId,
            );
            if (updated.changes === 0) continue;
            reviewException(item, {
              connectorId: input.connectorId,
              now: input.now,
              reasonCode: 'manual_decision_conflict',
              retryable: false,
              policyVersion: result.policyVersion,
            });
            continue;
          }
          const values = [
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
          const updateResult = item.hasManualDecision
            ? updateManual.run(
              ...values,
              item.transactionId,
              input.connectorId,
              item.stateSnapshot.manualDecisionAction,
              item.stateSnapshot.manualDecidedAt,
              item.stateSnapshot.assignedKidId,
            )
            : updateAutomated.run(
              result.kidId,
              result.method,
              ...values,
              result.reviewStatus === 'pending' ? 'pending' : 'confirmed',
              item.transactionId,
              input.connectorId,
            );
          if (updateResult.changes === 0) continue;
          if (result.kidId) {
            upsertSubject.run(
              idFactory(),
              input.connectorId,
              result.kidId,
              result.policyVersion,
              result.engineVersion,
              input.now,
              input.now,
            );
          }
          if (result.reviewStatus === 'pending' || result.status === 'pending') {
            reviewException(item, {
              connectorId: input.connectorId,
              now: input.now,
              reasonCode: result.reasons[0] ?? 'review-required',
              retryable: false,
              policyVersion: result.policyVersion,
            });
          } else {
            resolveCurrentException(
              sqlite,
              input.connectorId,
              item.transactionId,
              input.now,
            );
          }
        }
      }).immediate();
    },

    async persistUnavailable(input) {
      assertBatch(
        input.items.length,
        FINANCE_ATTRIBUTION_WRITE_MAX,
        'Finance attribution unavailable write',
      );
      sqlite.transaction(() => {
        assertAttributionFence(input);
        const update = sqlite.prepare(`
          UPDATE finance_transactions
          SET attribution_source_ref = COALESCE(?, attribution_source_ref),
              attribution_contract_version = ?,
              attribution_status = 'unavailable',
              attribution_confidence = 'none',
              attribution_method = 'unavailable',
              attribution_explanation = ?,
              attribution_reasons = ?,
              attribution_decision_source = 'fallback',
              attribution_review_state = 'pending',
              attribution_provenance = ?,
              attribution_last_error_code = ?,
              attribution_retryable = ?,
              attribution_updated_at = ?
          WHERE id = ? AND connector_instance_id = ?
            AND (kid_assignment_method IS NULL OR kid_assignment_method <> 'manual')
        `);
        for (const item of input.items) {
          if (!stateSnapshotMatches(
            sqlite,
            input.connectorId,
            item.transactionId,
            item.stateSnapshot,
          )) {
            continue;
          }
          if (item.stateSnapshot.kidAssignmentMethod !== 'manual') {
            update.run(
              item.sourceRef,
              input.contractVersion,
              input.failure.explanation,
              JSON.stringify([input.failure.reason]),
              input.provenance,
              input.failure.code,
              input.failure.retryable ? 1 : 0,
              input.now,
              item.transactionId,
              input.connectorId,
            );
          }
          reviewException(item, {
            connectorId: input.connectorId,
            now: input.now,
            reasonCode: input.failure.code,
            retryable: input.failure.retryable,
            policyVersion: null,
          });
        }
      }).immediate();
    },

    async finish(command) {
      const fenceClause = command.fenceMode === 'row-generation'
        ? ''
        : `AND (
             current_generation_id = ?
             OR (current_generation_id IS NULL AND last_successful_generation_id = ?)
           )`;
      const result = sqlite.prepare(`
        UPDATE finance_sync_state
        SET attribution_status = ?,
            attribution_last_attempt_at = ?,
            attribution_last_successful_at = CASE WHEN ? THEN ?
              ELSE attribution_last_successful_at END,
            attribution_last_error_code = ?,
            attribution_policy_version = COALESCE(?, attribution_policy_version),
            attribution_engine_version = CASE WHEN ? THEN ?
              ELSE attribution_engine_version END,
            updated_at = ?
        WHERE connector_id = ?
          ${fenceClause}
      `).run(
        command.status,
        command.attemptedAt,
        command.succeeded && !command.terminalFailureCode ? 1 : 0,
        command.attemptedAt,
        command.terminalFailureCode,
        command.policyVersion,
        command.succeeded ? 1 : 0,
        command.engineVersion,
        command.attemptedAt,
        command.connectorId,
        ...(command.fenceMode === 'row-generation'
          ? []
          : [command.generationId, command.generationId]),
      );
      return { recorded: result.changes === 1 };
    },
  };
}

export function createSqliteFinanceWorkerPersistence(
  sqlite: SqliteDatabase,
  options: SqliteFinanceAdapterOptions = {},
): FinanceCorePersistence {
  const idFactory = options.idFactory ?? randomUUID;
  return {
    identity: {
      async ensureNamespace(input) {
        return sqlite.transaction(() => {
          sqlite.prepare(`
            UPDATE connector_configs
            SET credentials = json_set(
                  COALESCE(credentials, '{}'),
                  '$.${FINANCE_IDENTITY_NAMESPACE_CREDENTIAL}',
                  ?
                ),
                updated_at = ?
            WHERE id = ?
              AND json_type(
                COALESCE(credentials, '{}'),
                '$.${FINANCE_IDENTITY_NAMESPACE_CREDENTIAL}'
              ) IS NULL
          `).run(input.candidate, input.updatedAt, input.connectorId);
          const row = sqlite.prepare(`
            SELECT credentials FROM connector_configs WHERE id = ?
          `).get(input.connectorId) as { credentials: string | null } | undefined;
          if (!row) throw new Error('Finance connector identity state is unavailable');
          return acceptedNamespace(row.credentials);
        }).immediate();
      },
    },
    snapshots: createSnapshotPersistence(sqlite, options.projectionProofs),
    datasets: createDatasetPersistence(sqlite, options.projectionProofs),
    attribution: createAttributionPersistence(sqlite, idFactory),
  };
}
