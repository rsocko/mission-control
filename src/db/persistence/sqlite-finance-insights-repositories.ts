import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { financeInsightDigestV1, type CanonicalJsonValue } from '@/lib/finance-insights/canonical';
import { transactionSourceFactSchema } from '@/lib/finance-insights/contract';
import { financeInsightOccurrenceRevisionDigest } from '@/lib/finance-insights/occurrence-shared';
import { loadFinanceInsightProjectionFacts } from './sqlite-finance-insight-projection-facts';
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
} from './finance-insights';

type SqliteDatabase = Database.Database;

function stableValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function localTransactionId(connectorId: string, upstreamId: string): string {
  return `finance:${connectorId}:${upstreamId}`;
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

function createConnectorPersistence(sqlite: SqliteDatabase): FinanceInsightConnectorPersistence {
  return {
    async listEnabledConnectorIds(connectorTypes, limit) {
      if (connectorTypes.length === 0 || limit < 1) return [];
      const placeholders = connectorTypes.map(() => '?').join(', ');
      return (sqlite.prepare(`
        SELECT id FROM connector_configs
        WHERE enabled = 1 AND deleted_at IS NULL
          AND type IN (${placeholders})
        ORDER BY id
        LIMIT ?
      `).all(...connectorTypes, limit) as Array<{ id: string }>).map((row) => row.id);
    },
    async resolveSingleEnabledConnectorId(connectorTypes) {
      const rows = await this.listEnabledConnectorIds(connectorTypes, 2);
      return rows.length === 1 ? rows[0]! : null;
    },
  };
}

// ─── History projection ─────────────────────────────────────────────────────

function createProjectionPersistence(sqlite: SqliteDatabase): FinanceInsightProjectionPersistence {
  return {
    async startAttempt(command: FinanceInsightProjectionAttemptStartCommand) {
      sqlite.transaction(() => {
        sqlite.prepare(`
          INSERT INTO finance_insight_transaction_projection_state (
            connector_id, status, current_attempt_id, last_attempt_at,
            created_at, updated_at
          ) VALUES (?, 'running', ?, ?, ?, ?)
          ON CONFLICT(connector_id) DO UPDATE SET
            status = 'running',
            current_attempt_id = excluded.current_attempt_id,
            last_attempt_at = excluded.last_attempt_at,
            last_error_code = NULL,
            updated_at = excluded.updated_at
        `).run(
          command.connectorId,
          command.attemptId,
          command.attemptAt,
          command.attemptAt,
          command.attemptAt,
        );
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_facts
          WHERE connector_id = ?
            AND generation_id <> COALESCE((
              SELECT successful_generation_id
              FROM finance_insight_transaction_projection_state
              WHERE connector_id = ?
            ), '')
        `).run(command.connectorId, command.connectorId);
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_windows
          WHERE connector_id = ?
            AND generation_id <> COALESCE((
              SELECT successful_generation_id
              FROM finance_insight_transaction_projection_state
              WHERE connector_id = ?
            ), '')
        `).run(command.connectorId, command.connectorId);
      }).immediate();
    },

    async insertAttemptFacts(command: FinanceInsightProjectionAttemptFactsCommand) {
      sqlite.transaction(() => {
        const insert = sqlite.prepare(`
          INSERT INTO finance_insight_transaction_projection_facts (
            connector_id, generation_id, source_ref, occurred_on, payload
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const fact of command.facts) {
          insert.run(
            command.connectorId,
            command.attemptId,
            fact.sourceRef,
            fact.occurredOn,
            JSON.stringify(fact.payload),
          );
        }
      }).immediate();
    },

    async insertAttemptWindowProof(command: FinanceInsightProjectionAttemptWindowCommand) {
      sqlite.prepare(`
        INSERT INTO finance_insight_transaction_projection_windows (
          connector_id, generation_id, window_index, coverage_start,
          coverage_end, source_as_of, item_count, content_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        command.connectorId,
        command.attemptId,
        command.proof.index,
        command.proof.start,
        command.proof.end,
        command.proof.sourceAsOf,
        command.proof.itemCount,
        command.proof.digest,
      );
    },

    async readAttemptFacts(connectorId: string, attemptId: string) {
      return (sqlite.prepare(`
        SELECT source_ref AS sourceRef, occurred_on AS occurredOn, payload
        FROM finance_insight_transaction_projection_facts
        WHERE connector_id = ? AND generation_id = ?
        ORDER BY source_ref
      `).all(connectorId, attemptId) as Array<{
        sourceRef: string;
        occurredOn: string;
        payload: string;
      }>).map((row) => ({
        sourceRef: row.sourceRef,
        occurredOn: row.occurredOn,
        payload: JSON.parse(row.payload) as unknown,
      }));
    },

    async readAttemptWindowProofs(connectorId: string, attemptId: string) {
      return sqlite.prepare(`
        SELECT window_index AS "index", coverage_start AS start, coverage_end AS end,
               source_as_of AS sourceAsOf, item_count AS itemCount,
               content_digest AS digest
        FROM finance_insight_transaction_projection_windows
        WHERE connector_id = ? AND generation_id = ?
        ORDER BY window_index
      `).all(connectorId, attemptId) as FinanceInsightWindowProof[];
    },

    async promoteAttempt(command: FinanceInsightProjectionPromoteAttemptCommand) {
      sqlite.transaction(() => {
        const stagedFacts = (sqlite.prepare(`
          SELECT payload
          FROM finance_insight_transaction_projection_facts
          WHERE connector_id = ? AND generation_id = ?
          ORDER BY source_ref
        `).all(command.connectorId, command.attemptId) as Array<{ payload: string }>)
          .map((row) => transactionSourceFactSchema.parse(JSON.parse(row.payload)));
        const stagedWindows = sqlite.prepare(`
          SELECT window_index AS "index", coverage_start AS start, coverage_end AS end,
                 source_as_of AS sourceAsOf, item_count AS itemCount,
                 content_digest AS digest
          FROM finance_insight_transaction_projection_windows
          WHERE connector_id = ? AND generation_id = ?
          ORDER BY window_index
        `).all(command.connectorId, command.attemptId) as FinanceInsightWindowProof[];
        if (
          stagedFacts.length !== command.itemCount
          || financeInsightDigestV1(stagedFacts as CanonicalJsonValue) !== command.contentDigest
          || stagedWindows.length !== command.windowCount
          || financeInsightDigestV1(stagedWindows as unknown as CanonicalJsonValue)
            !== command.windowsDigest
        ) {
          throw new Error('finance_insight_history_changed_before_commit');
        }
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_facts
          WHERE connector_id = ? AND generation_id = ?
        `).run(command.connectorId, command.generationId);
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_windows
          WHERE connector_id = ? AND generation_id = ?
        `).run(command.connectorId, command.generationId);
        sqlite.prepare(`
          UPDATE finance_insight_transaction_projection_facts
          SET generation_id = ?
          WHERE connector_id = ? AND generation_id = ?
        `).run(command.generationId, command.connectorId, command.attemptId);
        sqlite.prepare(`
          UPDATE finance_insight_transaction_projection_windows
          SET generation_id = ?
          WHERE connector_id = ? AND generation_id = ?
        `).run(command.generationId, command.connectorId, command.attemptId);
        const promoted = sqlite.prepare(`
          UPDATE finance_insight_transaction_projection_state
          SET status = 'succeeded', current_attempt_id = NULL,
              last_successful_at = ?, successful_generation_id = ?,
              source_as_of = ?, item_count = ?, content_digest = ?,
              coverage_start = ?, coverage_end = ?, window_count = ?,
              windows_digest = ?, bridge_contract_version = ?,
              last_error_code = NULL, updated_at = ?
          WHERE connector_id = ? AND current_attempt_id = ?
        `).run(
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
          command.completedAt,
          command.connectorId,
          command.attemptId,
        );
        if (promoted.changes !== 1) throw new FinanceInsightProjectionFenceError();
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_facts
          WHERE connector_id = ? AND generation_id <> ?
        `).run(command.connectorId, command.generationId);
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_windows
          WHERE connector_id = ? AND generation_id <> ?
        `).run(command.connectorId, command.generationId);
      }).immediate();
    },

    async failAttempt(command: FinanceInsightProjectionFailAttemptCommand) {
      return sqlite.transaction(() => {
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_facts
          WHERE connector_id = ? AND generation_id = ?
        `).run(command.connectorId, command.attemptId);
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_windows
          WHERE connector_id = ? AND generation_id = ?
        `).run(command.connectorId, command.attemptId);
        const result = sqlite.prepare(`
          UPDATE finance_insight_transaction_projection_state
          SET status = 'failed', current_attempt_id = NULL,
              last_error_code = ?, updated_at = ?
          WHERE connector_id = ? AND current_attempt_id = ?
        `).run(command.errorCode, command.failedAt, command.connectorId, command.attemptId);
        return { recorded: result.changes === 1 };
      }).immediate();
    },

    async readState(connectorId: string): Promise<FinanceInsightProjectionState | null> {
      const row = sqlite.prepare(`
        SELECT status, successful_generation_id AS generationId,
               last_successful_at AS lastSuccessfulAt, source_as_of AS sourceAsOf,
               item_count AS itemCount, content_digest AS contentDigest,
               coverage_start AS coverageStart, coverage_end AS coverageEnd,
               window_count AS windowCount, windows_digest AS windowsDigest,
               bridge_contract_version AS bridgeContractVersion
        FROM finance_insight_transaction_projection_state
        WHERE connector_id = ?
      `).get(connectorId) as FinanceInsightProjectionState | undefined;
      return row ?? null;
    },

    async readWindowProofs(connectorId: string, generationId: string) {
      return sqlite.prepare(`
        SELECT window_index AS "index", coverage_start AS start, coverage_end AS end,
               source_as_of AS sourceAsOf, item_count AS itemCount,
               content_digest AS digest
        FROM finance_insight_transaction_projection_windows
        WHERE connector_id = ? AND generation_id = ?
        ORDER BY window_index
      `).all(connectorId, generationId) as FinanceInsightWindowProof[];
    },

    async readPromotedTransactionFacts(connectorId: string, generationId: string) {
      return (sqlite.prepare(`
        SELECT payload
        FROM finance_insight_transaction_projection_facts
        WHERE connector_id = ? AND generation_id = ?
        ORDER BY source_ref
      `).all(connectorId, generationId) as Array<{ payload: string }>)
        .map((row) => JSON.parse(row.payload) as unknown);
    },

    async readDatasetInsightState(connectorId: string): Promise<FinanceInsightDatasetInsightState[]> {
      return sqlite.prepare(`
        SELECT dataset, current_generation_id AS generationId,
               source_as_of AS sourceAsOf, fresh_until AS freshUntil,
               last_attempt_outcome AS outcome,
               insight_item_count AS itemCount,
               insight_content_digest AS contentDigest,
               insight_bridge_contract_version AS bridgeContractVersion
        FROM finance_dataset_sync_state
        WHERE connector_id = ?
      `).all(connectorId) as FinanceInsightDatasetInsightState[];
    },

    async readOperationalProjectionFacts(connectorId, transactionStart, onlyKind, transactionEnd) {
      return loadFinanceInsightProjectionFacts(
        sqlite,
        connectorId,
        transactionStart,
        onlyKind,
        transactionEnd,
      );
    },
  };
}

// ─── Transaction backfill ───────────────────────────────────────────────────

function assertDeliveryDisabledSync(sqlite: SqliteDatabase, connectorId: string): void {
  const row = sqlite.prepare(`
    SELECT delivery_enabled AS deliveryEnabled
    FROM finance_insight_cutovers WHERE connector_id = ?
  `).get(connectorId) as { deliveryEnabled: number } | undefined;
  if (row?.deliveryEnabled === 1) {
    throw new FinanceInsightBackfillDeliveryEnabledError();
  }
}

function loadPlanSync(
  sqlite: SqliteDatabase,
  connectorId: string,
  idempotencyKey: string,
): FinanceInsightBackfillPlan | null {
  const row = sqlite.prepare(`
    SELECT id, connector_id AS connectorId, idempotency_key AS idempotencyKey,
           horizon_months AS horizonMonths, coverage_start AS coverageStart,
           coverage_end AS coverageEnd, currency,
           bridge_contract_version AS bridgeContractVersion,
           window_count AS windowCount, next_window_ordinal AS nextWindowOrdinal,
           status
    FROM finance_insight_transaction_backfill_plans
    WHERE connector_id = ? AND idempotency_key = ?
  `).get(connectorId, idempotencyKey) as FinanceInsightBackfillPlan | undefined;
  return row ?? null;
}

function createBackfillPersistence(
  sqlite: SqliteDatabase,
): FinanceInsightBackfillPersistence {
  return {
    async assertDeliveryDisabled(connectorId: string) {
      assertDeliveryDisabledSync(sqlite, connectorId);
    },

    async loadPlan(connectorId: string, idempotencyKey: string) {
      return loadPlanSync(sqlite, connectorId, idempotencyKey);
    },

    async createPlan(input) {
      return sqlite.transaction(() => {
        assertDeliveryDisabledSync(sqlite, input.connectorId);
        const existing = loadPlanSync(sqlite, input.connectorId, input.idempotencyKey);
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
        sqlite.prepare(`
          INSERT INTO finance_insight_transaction_backfill_plans (
            id, connector_id, idempotency_key, horizon_months, coverage_start,
            coverage_end, currency, bridge_contract_version, window_count,
            next_window_ordinal, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'running', ?, ?)
        `).run(
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
          input.now,
        );
        return loadPlanSync(sqlite, input.connectorId, input.idempotencyKey)!;
      }).immediate();
    },

    async loadWindowProofs(planId: string): Promise<FinanceInsightBackfillWindowProof[]> {
      return sqlite.prepare(`
        SELECT window_ordinal AS windowOrdinal, generation_ref AS generationRef,
               window_start AS windowStart, window_end AS windowEnd,
               source_as_of AS sourceAsOf, item_count AS itemCount,
               content_digest AS contentDigest, currency,
               bridge_contract_version AS bridgeContractVersion
        FROM finance_insight_transaction_window_proofs
        WHERE plan_id = ?
        ORDER BY window_ordinal
      `).all(planId) as FinanceInsightBackfillWindowProof[];
    },

    async findPriorWindowTransactionDate(connectorId, planId, upstreamTransactionId) {
      const row = sqlite.prepare(`
        SELECT date
        FROM finance_transactions
        WHERE connector_instance_id = ? AND upstream_transaction_id = ?
          AND last_seen_generation_id IN (
            SELECT generation_ref
            FROM finance_insight_transaction_window_proofs
            WHERE plan_id = ?
          )
      `).get(connectorId, upstreamTransactionId, planId) as { date: string } | undefined;
      return row?.date ?? null;
    },

    async upsertTransactionPage(command: FinanceInsightBackfillPageCommand) {
      assertBatch(command.transactions.length, 500, 'Finance insight backfill transaction page');
      return sqlite.transaction(() => {
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
              command.generationRef,
              command.now,
              command.now,
              command.now,
            );
            added++;
          } else {
            update.run(
              ...values,
              command.provenance.provider,
              command.provenance.fetchedAt,
              hash,
              command.generationRef,
              command.now,
              command.now,
              command.connectorId,
              transaction.id,
            );
            if (existing.sourceFingerprint !== hash) updated++;
          }
        }
        return { added, updated };
      }).immediate();
    },

    async recordWindowCapture(command: FinanceInsightBackfillWindowCaptureCommand) {
      return sqlite.transaction(() => {
        assertDeliveryDisabledSync(sqlite, command.connectorId);
        sqlite.prepare(`
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
          command.generationRef,
        );
        const facts = loadFinanceInsightProjectionFacts(
          sqlite,
          command.connectorId,
          command.windowStart,
          'transaction',
          command.windowEnd,
        ).transaction;
        if (facts.length !== command.expectedItemCount) {
          throw new FinanceInsightBackfillWindowIncompleteError();
        }
        const previousCount = sqlite.prepare(`
          SELECT COALESCE(SUM(item_count), 0) AS itemCount
          FROM finance_insight_transaction_window_proofs WHERE plan_id = ?
        `).get(command.planId) as { itemCount: number };
        if (previousCount.itemCount + facts.length > command.maxTotalItemCount) {
          throw new FinanceInsightBackfillTooLargeError();
        }
        sqlite.prepare(`
          INSERT INTO finance_insight_transaction_window_proofs (
            plan_id, connector_id, window_ordinal, generation_ref, window_start,
            window_end, source_as_of, item_count, content_digest, currency,
            bridge_contract_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
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
        );
        const nextOrdinal = command.windowOrdinal + 1;
        const completed = nextOrdinal === command.planWindowCount;
        sqlite.prepare(`
          UPDATE finance_insight_transaction_backfill_plans
          SET next_window_ordinal = ?, status = ?, last_error_code = NULL,
              completed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
          nextOrdinal,
          completed ? 'completed' : 'running',
          completed ? command.completedAt : null,
          command.completedAt,
          command.planId,
        );
        return { itemCount: facts.length };
      }).immediate();
    },

    async recordPlanFailure(planId: string, errorCode: string, now: string) {
      sqlite.prepare(`
        UPDATE finance_insight_transaction_backfill_plans
        SET last_error_code = ?, updated_at = ? WHERE id = ?
      `).run(errorCode, now, planId);
    },

    async promoteCompletedPlan(command: FinanceInsightBackfillPromotionCommand) {
      return sqlite.transaction(() => {
        assertDeliveryDisabledSync(sqlite, command.connectorId);
        const current = loadPlanSync(sqlite, command.connectorId, command.idempotencyKey);
        if (!current || current.id !== command.planId || current.status !== 'completed') {
          throw new FinanceInsightBackfillPlanUnavailableError();
        }
        const existingState = sqlite.prepare(`
          SELECT successful_generation_id AS generationId,
                 source_as_of AS sourceAsOf, item_count AS itemCount,
                 content_digest AS contentDigest, coverage_start AS coverageStart,
                 coverage_end AS coverageEnd, window_count AS windowCount,
                 windows_digest AS windowsDigest,
                 bridge_contract_version AS bridgeContractVersion
          FROM finance_insight_transaction_projection_state
          WHERE connector_id = ? AND status = 'succeeded'
        `).get(command.connectorId) as {
          generationId: string;
          sourceAsOf: string;
          itemCount: number;
          contentDigest: string;
          coverageStart: string;
          coverageEnd: string;
          windowCount: number;
          windowsDigest: string;
          bridgeContractVersion: string;
        } | undefined;
        if (existingState?.generationId === command.generationId) {
          const storedFacts = (sqlite.prepare(`
            SELECT payload FROM finance_insight_transaction_projection_facts
            WHERE connector_id = ? AND generation_id = ?
            ORDER BY source_ref
          `).all(command.connectorId, command.generationId) as Array<{ payload: string }>)
            .map((row) => JSON.parse(row.payload) as unknown);
          const storedWindows = sqlite.prepare(`
            SELECT window_index AS "index", coverage_start AS start,
                   coverage_end AS end, source_as_of AS sourceAsOf,
                   item_count AS itemCount, content_digest AS digest
            FROM finance_insight_transaction_projection_windows
            WHERE connector_id = ? AND generation_id = ?
            ORDER BY window_index
          `).all(command.connectorId, command.generationId) as FinanceInsightWindowProof[];
          if (
            existingState.sourceAsOf !== command.sourceAsOf
            || existingState.itemCount !== command.itemCount
            || existingState.contentDigest !== command.contentDigest
            || existingState.coverageStart !== command.coverageStart
            || existingState.coverageEnd !== command.coverageEnd
            || existingState.windowCount !== command.windowCount
            || existingState.windowsDigest !== command.windowsDigest
            || existingState.bridgeContractVersion !== command.bridgeContractVersion
            || financeInsightDigestV1(storedFacts as CanonicalJsonValue) !== command.contentDigest
            || financeInsightDigestV1(storedWindows as unknown as CanonicalJsonValue) !== command.windowsDigest
          ) {
            throw new FinanceInsightBackfillProjectionConflictError();
          }
          return { promoted: false };
        }
        if (existingState) {
          throw new FinanceInsightBackfillProjectionConflictError();
        }
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_facts
          WHERE connector_id = ? AND generation_id = ?
        `).run(command.connectorId, command.generationId);
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_windows
          WHERE connector_id = ? AND generation_id = ?
        `).run(command.connectorId, command.generationId);
        const insertFact = sqlite.prepare(`
          INSERT INTO finance_insight_transaction_projection_facts (
            connector_id, generation_id, source_ref, occurred_on, payload
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const fact of command.facts) {
          const parsed = fact as { sourceRef: string; occurredOn: string };
          insertFact.run(
            command.connectorId,
            command.generationId,
            parsed.sourceRef,
            parsed.occurredOn,
            JSON.stringify(fact),
          );
        }
        const insertWindow = sqlite.prepare(`
          INSERT INTO finance_insight_transaction_projection_windows (
            connector_id, generation_id, window_index, coverage_start,
            coverage_end, source_as_of, item_count, content_digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const proof of command.windows) {
          insertWindow.run(
            command.connectorId,
            command.generationId,
            proof.index,
            proof.start,
            proof.end,
            proof.sourceAsOf,
            proof.itemCount,
            proof.digest,
          );
        }
        sqlite.prepare(`
          INSERT INTO finance_insight_transaction_projection_state (
            connector_id, status, current_attempt_id, last_attempt_at,
            last_successful_at, successful_generation_id, source_as_of,
            item_count, content_digest, coverage_start, coverage_end,
            window_count, windows_digest, bridge_contract_version,
            last_error_code, created_at, updated_at
          ) VALUES (
            ?, 'succeeded', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
          )
          ON CONFLICT(connector_id) DO UPDATE SET
            status = 'succeeded',
            current_attempt_id = NULL,
            last_attempt_at = excluded.last_attempt_at,
            last_successful_at = excluded.last_successful_at,
            successful_generation_id = excluded.successful_generation_id,
            source_as_of = excluded.source_as_of,
            item_count = excluded.item_count,
            content_digest = excluded.content_digest,
            coverage_start = excluded.coverage_start,
            coverage_end = excluded.coverage_end,
            window_count = excluded.window_count,
            windows_digest = excluded.windows_digest,
            bridge_contract_version = excluded.bridge_contract_version,
            last_error_code = NULL,
            updated_at = excluded.updated_at
        `).run(
          command.connectorId,
          command.completedAt,
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
          command.completedAt,
          command.completedAt,
        );
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_facts
          WHERE connector_id = ? AND generation_id <> ?
        `).run(command.connectorId, command.generationId);
        sqlite.prepare(`
          DELETE FROM finance_insight_transaction_projection_windows
          WHERE connector_id = ? AND generation_id <> ?
        `).run(command.connectorId, command.generationId);
        return { promoted: true };
      }).immediate();
    },
  };
}

// ─── Publication ────────────────────────────────────────────────────────────

function createPublicationPersistence(sqlite: SqliteDatabase): FinanceInsightPublicationPersistence {
  return {
    async readCurrentState(connectorId: string) {
      const row = sqlite.prepare(`
        SELECT latest_publication_id AS publicationId,
               latest_generation_identity AS generationIdentity,
               last_source_sequence AS sourceSequence
        FROM finance_insight_publication_state WHERE connector_id = ?
      `).get(connectorId) as FinanceInsightPublicationState | undefined;
      return row ?? null;
    },

    async capture(command: FinanceInsightPublicationCaptureCommand): Promise<FinanceInsightPublicationCaptureResult> {
      return sqlite.transaction(() => {
        const state = sqlite.prepare(`
          SELECT latest_publication_id AS publicationId,
                 latest_generation_identity AS generationIdentity,
                 last_source_sequence AS sourceSequence
          FROM finance_insight_publication_state WHERE connector_id = ?
        `).get(command.connectorId) as {
          publicationId: string | null;
          generationIdentity: string | null;
          sourceSequence: number;
        } | undefined;
        if (state?.publicationId && state.generationIdentity === command.generationIdentity) {
          sqlite.prepare(`
            UPDATE finance_insight_publication_state
            SET last_capture_attempt_at = ?, last_capture_outcome = 'idempotent',
                last_error_code = NULL, updated_at = ?
            WHERE connector_id = ?
          `).run(command.capturedAt, command.capturedAt, command.connectorId);
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
        sqlite.prepare(`
          INSERT INTO finance_insight_publications (
            id, connector_id, source_sequence, generation_identity, contract_version,
            provider_type, source_as_of, coverage_start, coverage_end, currency,
            bridge_contract_version, captured_constituents, manifest, manifest_digest,
            create_request, idempotency_key, alert_capable, captured_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(
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
        );
        const insertFact = sqlite.prepare(`
          INSERT INTO finance_insight_publication_facts (
            publication_id, kind, source_ref, batch_index, fact_index, payload
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const fact of command.facts) {
          insertFact.run(
            command.publicationId,
            fact.kind,
            fact.sourceRef,
            fact.batchIndex,
            fact.factIndex,
            JSON.stringify(fact.payload),
          );
        }
        sqlite.prepare(`
          INSERT INTO finance_insight_publication_state (
            connector_id, provider_type, latest_publication_id,
            latest_generation_identity, last_source_sequence,
            last_capture_attempt_at, last_capture_outcome, last_error_code,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'captured', NULL, ?, ?)
          ON CONFLICT(connector_id) DO UPDATE SET
            provider_type = excluded.provider_type,
            latest_publication_id = excluded.latest_publication_id,
            latest_generation_identity = excluded.latest_generation_identity,
            last_source_sequence = excluded.last_source_sequence,
            last_capture_attempt_at = excluded.last_capture_attempt_at,
            last_capture_outcome = 'captured',
            last_error_code = NULL,
            updated_at = excluded.updated_at
        `).run(
          command.connectorId,
          command.providerType,
          command.publicationId,
          command.generationIdentity,
          command.expectedSourceSequence,
          command.capturedAt,
          command.capturedAt,
          command.capturedAt,
        );
        sqlite.prepare(`
          DELETE FROM finance_insight_publications
          WHERE connector_id = ?
            AND id NOT IN (
              SELECT id FROM finance_insight_publications
              WHERE connector_id = ?
              ORDER BY source_sequence DESC
              LIMIT ?
            )
        `).run(command.connectorId, command.connectorId, command.cacheCount);
        sqlite.prepare(`
          DELETE FROM finance_insight_publications
          WHERE connector_id = ? AND expires_at < ? AND id <> ?
        `).run(command.connectorId, command.capturedAt, command.publicationId);
        return {
          status: 'captured' as const,
          publicationId: command.publicationId,
          sourceSequence: command.expectedSourceSequence,
        };
      }).immediate();
    },

    async recordOutcome(input) {
      sqlite.prepare(`
        INSERT INTO finance_insight_publication_state (
          connector_id, provider_type, last_capture_attempt_at, last_capture_outcome,
          last_error_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connector_id) DO UPDATE SET
          provider_type = excluded.provider_type,
          last_capture_attempt_at = excluded.last_capture_attempt_at,
          last_capture_outcome = excluded.last_capture_outcome,
          last_error_code = excluded.last_error_code,
          updated_at = excluded.updated_at
      `).run(
        input.connectorId,
        input.providerType,
        input.now,
        input.outcome,
        input.code,
        input.now,
        input.now,
      );
    },

    async loadLatest(connectorId: string, publicationId: string | null, now: string) {
      const row = sqlite.prepare(`
        SELECT id, create_request AS createRequest, manifest_digest AS manifestDigest,
               source_as_of AS sourceAsOf, alert_capable AS alertCapable, expires_at AS expiresAt
        FROM finance_insight_publications
        WHERE connector_id = ? AND (? IS NULL OR id = ?)
        ORDER BY source_sequence DESC
        LIMIT 1
      `).get(connectorId, publicationId, publicationId) as {
        id: string;
        createRequest: string;
        manifestDigest: string;
        sourceAsOf: string;
        alertCapable: number;
        expiresAt: string;
      } | undefined;
      if (!row || Date.parse(row.expiresAt) < Date.parse(now)) return null;
      const facts = sqlite.prepare(`
        SELECT kind, source_ref AS sourceRef, batch_index AS batchIndex,
               fact_index AS factIndex, payload
        FROM finance_insight_publication_facts
        WHERE publication_id = ?
        ORDER BY kind, batch_index, fact_index
      `).all(row.id) as Array<{
        kind: string;
        sourceRef: string;
        batchIndex: number;
        factIndex: number;
        payload: string;
      }>;
      const record: FinanceInsightPublicationRecord = {
        id: row.id,
        createRequest: JSON.parse(row.createRequest),
        manifestDigest: row.manifestDigest,
        sourceAsOf: row.sourceAsOf,
        alertCapable: row.alertCapable === 1,
        expiresAt: row.expiresAt,
      };
      return {
        record,
        facts: facts.map((fact) => ({
          kind: fact.kind,
          sourceRef: fact.sourceRef,
          batchIndex: fact.batchIndex,
          factIndex: fact.factIndex,
          payload: JSON.parse(fact.payload) as unknown,
        })),
      };
    },
  };
}

// ─── Delivery checkpoints ───────────────────────────────────────────────────

function createDeliveryPersistence(sqlite: SqliteDatabase): FinanceInsightDeliveryPersistence {
  return {
    async findContinuationPublicationId(connectorId: string) {
      const pending = sqlite.prepare(`
        SELECT publication_id AS publicationId
        FROM finance_insight_publication_delivery
        WHERE connector_id = ?
          AND (
            evaluation_state IN ('queued', 'evaluating')
            OR last_error_retryable = 1
          )
        ORDER BY source_sequence DESC
        LIMIT 1
      `).get(connectorId) as { publicationId: string } | undefined;
      return pending?.publicationId ?? null;
    },

    async ensureState(input) {
      sqlite.prepare(`
        INSERT INTO finance_insight_publication_delivery (
          publication_id, connector_id, source_sequence, stage, next_batch_ordinal,
          last_error_retryable, created_at, updated_at
        ) VALUES (?, ?, ?, 'captured', 0, 0, ?, ?)
        ON CONFLICT(publication_id) DO NOTHING
      `).run(input.publicationId, input.connectorId, input.sourceSequence, input.now, input.now);
      const state = sqlite.prepare(`
        SELECT stage, next_batch_ordinal AS nextBatchOrdinal,
               detector_set_version AS detectorSetVersion,
               policy_version AS policyVersion,
               evaluation_sequence AS evaluationSequence
        FROM finance_insight_publication_delivery
        WHERE publication_id = ? AND connector_id = ? AND source_sequence = ?
      `).get(input.publicationId, input.connectorId, input.sourceSequence) as
        FinanceInsightDeliveryState | undefined;
      if (!state) {
        throw new Error('Finance insight delivery checkpoint is unavailable');
      }
      return state;
    },

    async markStaging(input) {
      sqlite.prepare(`
        UPDATE finance_insight_publication_delivery
        SET stage = CASE
              WHEN stage IN ('captured', 'staging') THEN 'staging'
              ELSE stage
            END,
            last_attempt_at = ?, last_error_code = NULL,
            last_error_retryable = 0, updated_at = ?
        WHERE publication_id = ?
      `).run(input.now, input.now, input.publicationId);
    },

    async advanceBatch(input) {
      sqlite.prepare(`
        UPDATE finance_insight_publication_delivery
        SET stage = CASE
              WHEN stage IN ('captured', 'staging', 'uploading') THEN 'uploading'
              ELSE stage
            END,
            next_batch_ordinal = MAX(next_batch_ordinal, ?),
            last_successful_at = ?, updated_at = ?
        WHERE publication_id = ?
      `).run(input.nextBatchOrdinal, input.now, input.now, input.publicationId);
    },

    async markCommitted(input) {
      sqlite.prepare(`
        UPDATE finance_insight_publication_delivery
        SET stage = CASE
              WHEN stage = 'evaluation-requested' THEN stage
              ELSE 'committed'
            END,
            detector_set_version = ?, policy_version = ?,
            last_successful_at = ?, last_error_code = NULL,
            last_error_retryable = 0, updated_at = ?
        WHERE publication_id = ?
      `).run(input.detectorSetVersion, input.policyVersion, input.now, input.now, input.publicationId);
    },

    async readMaxEvaluationSequence(input) {
      const row = sqlite.prepare(`
        SELECT MAX(evaluation_sequence) AS sequence
        FROM finance_insight_publication_delivery
        WHERE connector_id = ? AND publication_id <> ?
      `).get(input.connectorId, input.excludingPublicationId) as { sequence: number | null };
      return row.sequence;
    },

    async recordEvaluationOutcome(input) {
      if (input.succeeded) {
        sqlite.prepare(`
          UPDATE finance_insight_publication_delivery
          SET stage = 'evaluation-requested', evaluation_sequence = ?,
              evaluation_state = ?, evaluation_idempotency_key = ?,
              last_attempt_at = ?, last_successful_at = ?, last_error_code = NULL,
              last_error_retryable = 0, updated_at = ?
          WHERE publication_id = ?
        `).run(
          input.evaluationSequence,
          input.evaluationState,
          input.evaluationIdempotencyKey,
          input.now,
          input.now,
          input.now,
          input.publicationId,
        );
        return;
      }
      sqlite.prepare(`
        UPDATE finance_insight_publication_delivery
        SET stage = 'evaluation-requested', evaluation_sequence = ?,
            evaluation_state = ?, evaluation_idempotency_key = ?,
            last_attempt_at = ?, last_error_code = ?,
            last_error_retryable = ?, updated_at = ?
        WHERE publication_id = ?
      `).run(
        input.evaluationSequence,
        input.evaluationState,
        input.evaluationIdempotencyKey,
        input.now,
        input.errorCode,
        input.retryable ? 1 : 0,
        input.now,
        input.publicationId,
      );
    },

    async recordFailure(input) {
      sqlite.prepare(`
        UPDATE finance_insight_publication_delivery
        SET last_attempt_at = ?, last_error_code = ?, last_error_retryable = ?, updated_at = ?
        WHERE publication_id = ?
      `).run(input.now, input.code, input.retryable ? 1 : 0, input.now, input.publicationId);
    },
  };
}

// ─── Occurrence cache ───────────────────────────────────────────────────────

function createOccurrenceCachePersistence(
  sqlite: SqliteDatabase,
): FinanceInsightOccurrenceCachePersistence {
  return {
    async prune(now: string, payloadCutoff: string, tombstoneCutoff: string) {
      sqlite.transaction(() => {
        sqlite.prepare(`
          UPDATE finance_insight_occurrences
          SET entity_label = '', headline = '', target_descriptors = '[]',
              summary_payload = NULL
          WHERE cached_at < ?
        `).run(payloadCutoff);
        sqlite.prepare(`
          DELETE FROM finance_insight_occurrences
          WHERE is_tombstone = 1
            AND source_lifecycle IN ('resolved', 'superseded')
            AND source_updated_at < ?
        `).run(tombstoneCutoff);
        sqlite.prepare(`
          DELETE FROM finance_insight_occurrences
          WHERE connector_id IN (
            SELECT connector_id FROM finance_insight_occurrence_cache_state
            WHERE purge_after < ?
          )
        `).run(now);
        sqlite.prepare(`
          DELETE FROM finance_insight_occurrence_cache_state WHERE purge_after < ?
        `).run(now);
      }).immediate();
    },

    async replace(input) {
      const items: readonly FinanceInsightOccurrenceReplaceItem[] = input.items;
      sqlite.transaction(() => {
        const previousState = sqlite.prepare(`
          SELECT source_generation AS sourceGeneration, source_sequence AS sourceSequence,
                 source_as_of AS sourceAsOf,
                 summary_expires_at AS summaryExpiresAt
          FROM finance_insight_occurrence_cache_state WHERE connector_id = ?
        `).get(input.connectorId) as {
          sourceGeneration: string;
          sourceSequence: number;
          sourceAsOf: string;
          summaryExpiresAt: string;
        } | undefined;
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
        const previousRows = sqlite.prepare(`
          SELECT occurrence_id AS occurrenceId, delivery_revision AS deliveryRevision,
                 revision_digest AS revisionDigest, summary_payload AS summaryPayload,
                 source_generation AS sourceGeneration, source_sequence AS sourceSequence,
                 is_tombstone AS isTombstone,
                 source_lifecycle AS sourceLifecycle, source_updated_at AS sourceUpdatedAt
          FROM finance_insight_occurrences WHERE connector_id = ?
        `).all(input.connectorId) as Array<{
          occurrenceId: string;
          deliveryRevision: number;
          revisionDigest: string;
          isTombstone: number;
          summaryPayload: string | null;
          sourceGeneration: string;
          sourceSequence: number;
          sourceLifecycle: string | null;
          sourceUpdatedAt: string;
        }>;
        const previousByOccurrence = new Map(
          previousRows.map((row) => [row.occurrenceId, row]),
        );
        const previousCurrentRowCount = previousRows.filter(
          (row) => row.sourceGeneration === input.sourceGeneration && row.isTombstone === 0,
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
              ? financeInsightOccurrenceRevisionDigest(JSON.parse(previous.summaryPayload))
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
            previousByOccurrence.get(item.occurrenceId)?.summaryPayload
              === JSON.stringify(item.summaryPayload)
            && previousByOccurrence.get(item.occurrenceId)?.sourceGeneration
              === input.sourceGeneration
            && previousByOccurrence.get(item.occurrenceId)?.sourceSequence
              === input.sourceSequence
            && previousByOccurrence.get(item.occurrenceId)?.revisionDigest
              === item.revisionDigest
          ))
        ) {
          sqlite.prepare(`
            UPDATE finance_insight_occurrences
            SET cached_at = ?
            WHERE connector_id = ? AND source_generation = ? AND is_tombstone = 0
          `).run(input.refreshedAt, input.connectorId, input.sourceGeneration);
          sqlite.prepare(`
            UPDATE finance_insight_occurrence_cache_state
            SET refreshed_at = ?, updated_at = ?
            WHERE connector_id = ?
          `).run(input.refreshedAt, input.refreshedAt, input.connectorId);
          return;
        }
        sqlite.prepare(`
          DELETE FROM finance_insight_occurrences
          WHERE connector_id = ?
            AND (source_lifecycle IS NULL OR source_lifecycle NOT IN ('resolved', 'superseded'))
        `).run(input.connectorId);
        sqlite.prepare(`
          UPDATE finance_insight_occurrences
          SET is_tombstone = 1
          WHERE connector_id = ?
            AND source_lifecycle IN ('resolved', 'superseded')
        `).run(input.connectorId);
        const insert = sqlite.prepare(`
          INSERT INTO finance_insight_occurrences (
            connector_id, occurrence_id, source_generation, source_sequence, is_tombstone,
            insight_id, delivery_revision, revision_digest, kind,
            entity_kind, entity_source_ref, entity_label, analysis_state,
            source_lifecycle, severity, confidence, baseline_sufficiency, headline,
            freshness_state, source_as_of, target_descriptors, summary_payload,
            source_updated_at, cached_at
          ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(connector_id, occurrence_id) DO UPDATE SET
            source_generation = excluded.source_generation,
            source_sequence = excluded.source_sequence,
            is_tombstone = 0,
            insight_id = excluded.insight_id,
            delivery_revision = excluded.delivery_revision,
            revision_digest = excluded.revision_digest,
            kind = excluded.kind,
            entity_kind = excluded.entity_kind,
            entity_source_ref = excluded.entity_source_ref,
            entity_label = excluded.entity_label,
            analysis_state = excluded.analysis_state,
            source_lifecycle = excluded.source_lifecycle,
            severity = excluded.severity,
            confidence = excluded.confidence,
            baseline_sufficiency = excluded.baseline_sufficiency,
            headline = excluded.headline,
            freshness_state = excluded.freshness_state,
            source_as_of = excluded.source_as_of,
            target_descriptors = excluded.target_descriptors,
            summary_payload = excluded.summary_payload,
            source_updated_at = excluded.source_updated_at,
            cached_at = excluded.cached_at
        `);
        for (const item of items) {
          insert.run(
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
          );
        }
        sqlite.prepare(`
          UPDATE finance_insight_occurrences
          SET entity_label = '', headline = '', target_descriptors = '[]',
              summary_payload = NULL
          WHERE connector_id = ?
            AND is_tombstone = 1
            AND source_lifecycle IN ('resolved', 'superseded')
        `).run(input.connectorId);
        sqlite.prepare(`
          DELETE FROM finance_insight_occurrences
          WHERE rowid IN (
            SELECT rowid FROM finance_insight_occurrences
            WHERE connector_id = ?
              AND is_tombstone = 1
              AND source_lifecycle IN ('resolved', 'superseded')
            ORDER BY source_updated_at DESC, occurrence_id DESC
            LIMIT -1 OFFSET ?
          )
        `).run(input.connectorId, input.tombstoneLimit);
        sqlite.prepare(`
          INSERT INTO finance_insight_occurrence_cache_state (
            connector_id, source_generation, item_count, source_as_of, refreshed_at,
            source_sequence, summary_expires_at, purge_after, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(connector_id) DO UPDATE SET
            source_generation = excluded.source_generation,
            source_sequence = excluded.source_sequence,
            item_count = excluded.item_count,
            source_as_of = excluded.source_as_of,
            refreshed_at = excluded.refreshed_at,
            summary_expires_at = excluded.summary_expires_at,
            purge_after = excluded.purge_after,
            updated_at = excluded.updated_at
        `).run(
          input.connectorId,
          input.sourceGeneration,
          items.length,
          input.sourceAsOf,
          input.refreshedAt,
          input.sourceSequence,
          input.summaryExpiresAt,
          input.purgeAfter,
          input.refreshedAt,
          input.refreshedAt,
        );
      }).immediate();
    },

    async readState(connectorId: string): Promise<FinanceInsightOccurrenceCacheState | null> {
      const row = sqlite.prepare(`
        SELECT source_generation AS sourceGeneration, source_sequence AS sourceSequence,
               source_as_of AS sourceAsOf,
               summary_expires_at AS summaryExpiresAt, purge_after AS purgeAfter
        FROM finance_insight_occurrence_cache_state WHERE connector_id = ?
      `).get(connectorId) as FinanceInsightOccurrenceCacheState | undefined;
      return row ?? null;
    },

    async readCurrentGenerationRows(
      connectorId: string,
      sourceGeneration: string,
      limit: number,
    ): Promise<FinanceInsightOccurrenceMetadataRow[]> {
      return (sqlite.prepare(`
        SELECT occurrence_id AS occurrenceId, insight_id AS insightId, kind,
               source_lifecycle AS sourceLifecycle, source_updated_at AS updatedAt,
               summary_payload AS summaryPayload
        FROM finance_insight_occurrences
        WHERE connector_id = ? AND source_generation = ? AND is_tombstone = 0
        ORDER BY source_updated_at DESC, occurrence_id
        LIMIT ?
      `).all(connectorId, sourceGeneration, limit) as Array<{
        occurrenceId: string;
        insightId: string;
        kind: string;
        sourceLifecycle: string | null;
        updatedAt: string;
        summaryPayload: string | null;
      }>).map((row) => ({
        occurrenceId: row.occurrenceId,
        insightId: row.insightId,
        kind: row.kind,
        sourceLifecycle: row.sourceLifecycle,
        updatedAt: row.updatedAt,
        summaryPayload: row.summaryPayload === null ? null : JSON.parse(row.summaryPayload),
      }));
    },
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────

export function createSqliteFinanceInsightPersistence(
  sqlite: SqliteDatabase,
): Omit<FinanceInsightPersistence, 'notifications'> {
  return {
    connectors: createConnectorPersistence(sqlite),
    projection: createProjectionPersistence(sqlite),
    backfill: createBackfillPersistence(sqlite),
    publication: createPublicationPersistence(sqlite),
    delivery: createDeliveryPersistence(sqlite),
    occurrenceCache: createOccurrenceCachePersistence(sqlite),
  };
}
