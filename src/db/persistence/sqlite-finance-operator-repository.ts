import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import db, { sqlite } from '@/db';
import * as schema from '@/db/schema';
import { notificationActions, notifications } from '@/db/schema';
import {
  createNotificationsInTransaction,
  type CreateNotificationInput,
} from '@/lib/notifications/service';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';
import type {
  FinanceInsightNotificationIngestItem,
  FinanceInsightNotificationReconcileItem,
} from './finance-insights';
import {
  FinanceOperatorPersistenceError,
  type FinanceOperatorCutoverEnableOutcome,
  type FinanceOperatorHealthSnapshot,
  type FinanceOperatorPersistence,
  type FinanceOperatorReadinessInputs,
} from './finance-operator';
import { syncFinanceProviderPresentation } from './sqlite-finance-insight-notification-lifecycle';

/**
 * SQLite implementation of `FinanceWorkerPersistence.operator`.
 *
 * Everything the finance connector/operator web surface needs is expressed as a
 * domain operation here: the bounded health snapshot is a pure read, and both
 * cutover mutations run inside a single serialized (`immediate`) write
 * transaction so the readiness/generation fence, the idempotency audit, the
 * notification lifecycle, and the cutover state switch commit together.
 * Dispatcher wake is deliberately *not* performed here — `hasPendingDelivery`
 * is reported so the caller can wake strictly after commit.
 */

type SqliteDatabase = Database.Database;
type DrizzleDatabase = BetterSQLite3Database<typeof schema>;
type NotificationTransaction = Parameters<typeof createNotificationsInTransaction>[0];

interface SqliteFinanceOperatorHandles {
  sqlite: SqliteDatabase;
  db: DrizzleDatabase;
}

interface SqliteFinanceOperatorOptions {
  idFactory?: () => string;
}

const financeTypePlaceholders = FINANCE_PROVIDER_ALIASES.map(() => '?').join(', ');

interface CutoverAuditRow {
  operation: 'enable' | 'rollback';
  sourceGeneration: string | null;
  resultCode: string;
  blockerCodes: string;
  legacyExpiredCount: number;
  importedCount: number;
  suppressedDeliveryCount: number;
}

function parseBlockerCodes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function existingAudit(
  handles: SqliteFinanceOperatorHandles,
  connectorId: string,
  idempotencyKey: string | null,
  operation: 'enable' | 'rollback',
  sourceGeneration: string,
): CutoverAuditRow | undefined {
  if (!idempotencyKey) return undefined;
  const row = handles.sqlite.prepare(`
    SELECT operation, source_generation AS sourceGeneration, result_code AS resultCode,
           blocker_codes AS blockerCodes, legacy_expired_count AS legacyExpiredCount,
           imported_count AS importedCount,
           suppressed_delivery_count AS suppressedDeliveryCount
    FROM finance_insight_cutover_audit
    WHERE connector_id = ? AND idempotency_key = ?
  `).get(connectorId, idempotencyKey) as CutoverAuditRow | undefined;
  if (!row) return undefined;
  if (row.operation !== operation || row.sourceGeneration !== sourceGeneration) {
    throw new FinanceOperatorPersistenceError('cutover_idempotency_conflict');
  }
  return row;
}

function insertAudit(
  handles: SqliteFinanceOperatorHandles,
  idFactory: () => string,
  input: {
    connectorId: string;
    operation: 'enable' | 'rollback';
    actorType: string | null;
    idempotencyKey: string | null;
    sourceGeneration: string;
    resultCode: string;
    blockerCodes?: readonly string[];
    legacyExpiredCount?: number;
    importedCount?: number;
    suppressedDeliveryCount?: number;
    now: string;
  },
): void {
  if (!input.idempotencyKey || !input.actorType) return;
  handles.sqlite.prepare(`
    INSERT INTO finance_insight_cutover_audit (
      id, connector_id, operation, actor_type, idempotency_key, source_generation,
      result_code, blocker_codes, legacy_expired_count, imported_count,
      suppressed_delivery_count, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    idFactory(),
    input.connectorId,
    input.operation,
    input.actorType,
    input.idempotencyKey,
    input.sourceGeneration,
    input.resultCode,
    JSON.stringify(input.blockerCodes ?? []),
    input.legacyExpiredCount ?? 0,
    input.importedCount ?? 0,
    input.suppressedDeliveryCount ?? 0,
    input.now,
    input.now,
  );
}

function enabledFinanceConnectorIds(handles: SqliteFinanceOperatorHandles): string[] {
  return (handles.sqlite.prepare(`
    SELECT id FROM connector_configs
    WHERE enabled = 1 AND deleted_at IS NULL
      AND type IN (${financeTypePlaceholders})
    ORDER BY id
  `).all(...FINANCE_PROVIDER_ALIASES) as Array<{ id: string }>).map((row) => row.id);
}

function reconcileNotifications(
  transaction: NotificationTransaction,
  connectorId: string,
  items: readonly FinanceInsightNotificationReconcileItem[],
  nowIso: string,
): void {
  for (const item of items) {
    const existing = transaction.select({
      id: notifications.id,
      disposition: notifications.disposition,
      sourceResolvedAt: notifications.sourceResolvedAt,
    }).from(notifications).where(and(
      eq(notifications.sourceId, item.sourceId),
      eq(notifications.connectorType, 'finance-manager'),
      eq(notifications.connectorInstanceId, connectorId),
    )).get();
    if (!existing) continue;

    const state = existing.disposition === 'dismissed'
      ? 'dismissed'
      : existing.disposition === 'handled'
        ? 'archived'
        : 'resolved';
    transaction.update(notifications).set({
      state,
      sourceState: 'resolved',
      sourceResolvedAt: existing.sourceResolvedAt ?? item.sourceResolvedAt ?? nowIso,
      lastSourceActivityAt: item.lastSourceActivityAt,
      lastSourceActivityKey: item.lastSourceActivityKey,
      lastSourceSyncedAt: nowIso,
      isActionable: false,
      primaryActionId: null,
      metadata: item.metadata,
    }).where(eq(notifications.id, existing.id)).run();
    transaction.delete(notificationActions).where(and(
      eq(notificationActions.notificationId, existing.id),
      eq(notificationActions.createdBy, 'connector'),
    )).run();
  }
}

function toCreateNotificationInput(
  item: FinanceInsightNotificationIngestItem,
): CreateNotificationInput {
  const input = item.input;
  return {
    id: input.id,
    sourceId: input.sourceId,
    connectorType: input.connectorType,
    connectorInstanceId: input.connectorInstanceId,
    title: input.title,
    body: input.body,
    level: input.level,
    category: input.category,
    templateKey: input.templateKey,
    readState: input.readState,
    disposition: input.disposition,
    sourceState: input.sourceState,
    syncState: input.syncState,
    sourceActivityAt: input.sourceActivityAt,
    sourceActivityKey: input.sourceActivityKey,
    reopenPolicy: input.reopenPolicy,
    occurrenceKey: input.occurrenceKey,
    isActionable: input.isActionable,
    primaryActionId: input.primaryActionId,
    receivedAt: input.receivedAt,
    sortAt: input.sortAt,
    relatedTaskId: input.relatedTaskId,
    relatedProjectId: input.relatedProjectId,
    relatedEntityType: input.relatedEntityType,
    relatedEntityId: input.relatedEntityId,
    navigationTarget: input.navigationTarget,
    metadata: input.metadata,
    presentation: input.presentation,
    groupKey: item.groupKey,
    dedupeKey: item.dedupeKey,
  };
}

function defaultHandles(): SqliteFinanceOperatorHandles {
  return { sqlite, db };
}

export function createSqliteFinanceOperatorPersistence(
  handles: SqliteFinanceOperatorHandles = defaultHandles(),
  options: SqliteFinanceOperatorOptions = {},
): FinanceOperatorPersistence {
  const idFactory = options.idFactory ?? randomUUID;

  return {
    async isLegacyAnomalyProductionEnabled(): Promise<boolean> {
      const cutover = handles.sqlite.prepare(`
        SELECT 1
        FROM finance_insight_cutovers
        WHERE legacy_disabled = 1
        LIMIT 1
      `).get();
      return cutover === undefined;
    },

    async readHealthSnapshot(connectorId): Promise<FinanceOperatorHealthSnapshot> {
      const state = handles.sqlite.prepare(`
        SELECT status, last_attempt_at AS lastAttemptAt,
               last_successful_sync_at AS lastSuccessfulSyncAt,
               last_successful_window_start AS lastSuccessfulWindowStart,
               last_successful_window_end AS lastSuccessfulWindowEnd,
               last_error_code AS lastErrorCode,
               attribution_status AS attributionStatus,
               attribution_last_attempt_at AS attributionLastAttemptAt,
               attribution_last_successful_at AS attributionLastSuccessfulAt,
               attribution_last_error_code AS attributionLastErrorCode,
               attribution_policy_version AS attributionPolicyVersion,
               attribution_engine_version AS attributionEngineVersion
        FROM finance_sync_state
        WHERE connector_id = ?
        LIMIT 1
      `).get(connectorId) as
        | {
            status: string;
            lastAttemptAt: string | null;
            lastSuccessfulSyncAt: string | null;
            lastSuccessfulWindowStart: string | null;
            lastSuccessfulWindowEnd: string | null;
            lastErrorCode: string | null;
            attributionStatus: string | null;
            attributionLastAttemptAt: string | null;
            attributionLastSuccessfulAt: string | null;
            attributionLastErrorCode: string | null;
            attributionPolicyVersion: number | null;
            attributionEngineVersion: string | null;
          }
        | undefined;
      const activeJob = handles.sqlite.prepare(`
        SELECT id, status, attempt, max_attempts AS maxAttempts,
               available_at AS availableAt, started_at AS startedAt
        FROM sync_jobs
        WHERE connector_id = ? AND status IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1
      `).get(connectorId) as
        | {
            id: string;
            status: string;
            attempt: number;
            maxAttempts: number;
            availableAt: string | null;
            startedAt: string | null;
          }
        | undefined;
      const capture = handles.sqlite.prepare(`
        SELECT last_capture_outcome AS status,
               last_capture_attempt_at AS lastAttemptAt,
               last_error_code AS lastErrorCode
        FROM finance_insight_publication_state
        WHERE connector_id = ?
        LIMIT 1
      `).get(connectorId) as
        | { status: string | null; lastAttemptAt: string | null; lastErrorCode: string | null }
        | undefined;
      const evaluation = handles.sqlite.prepare(`
        SELECT evaluation_state AS status, stage,
               last_attempt_at AS lastAttemptAt,
               last_successful_at AS lastSuccessfulAt,
               last_error_code AS lastErrorCode,
               last_error_retryable AS retryable
        FROM finance_insight_publication_delivery
        WHERE connector_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(connectorId) as
        | {
            status: string | null;
            stage: string | null;
            lastAttemptAt: string | null;
            lastSuccessfulAt: string | null;
            lastErrorCode: string | null;
            retryable: number | null;
          }
        | undefined;
      return {
        sync: state
          ? {
              status: state.status,
              lastAttemptAt: state.lastAttemptAt,
              lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
              lastSuccessfulWindowStart: state.lastSuccessfulWindowStart,
              lastSuccessfulWindowEnd: state.lastSuccessfulWindowEnd,
              lastErrorCode: state.lastErrorCode,
            }
          : null,
        attribution: state
          ? {
              status: state.attributionStatus ?? 'idle',
              lastAttemptAt: state.attributionLastAttemptAt,
              lastSuccessfulAt: state.attributionLastSuccessfulAt,
              lastErrorCode: state.attributionLastErrorCode,
              policyVersion: state.attributionPolicyVersion,
              engineVersion: state.attributionEngineVersion,
            }
          : null,
        activeJob: activeJob ?? null,
        capture: capture ?? null,
        evaluation: evaluation
          ? {
              status: evaluation.status,
              stage: evaluation.stage,
              lastAttemptAt: evaluation.lastAttemptAt,
              lastSuccessfulAt: evaluation.lastSuccessfulAt,
              lastErrorCode: evaluation.lastErrorCode,
              retryable: evaluation.retryable === 1,
            }
          : null,
      };
    },

    async readCutoverReadiness(connectorId): Promise<FinanceOperatorReadinessInputs> {
      const row = handles.sqlite.prepare(`
        SELECT id, type, enabled, settings
        FROM connector_configs
        WHERE id = ? AND deleted_at IS NULL
      `).get(connectorId) as
        | { id: string; type: string; enabled: number; settings: string | null }
        | undefined;
      if (!row) {
        throw new FinanceOperatorPersistenceError('finance_connector_not_found', 404);
      }
      const publication = handles.sqlite.prepare(`
        SELECT publications.id AS sourceGeneration,
               publications.source_sequence AS sourceSequence,
               publications.source_as_of AS sourceAsOf,
               delivery.last_successful_at AS completedAt
        FROM finance_insight_publications publications
        INNER JOIN finance_insight_publication_delivery delivery
          ON delivery.publication_id = publications.id
          AND delivery.connector_id = publications.connector_id
          AND delivery.source_sequence = publications.source_sequence
        INNER JOIN finance_insight_occurrence_cache_state cache
          ON cache.connector_id = publications.connector_id
          AND cache.source_generation = publications.id
          AND cache.source_sequence = publications.source_sequence
        WHERE publications.connector_id = ?
          AND delivery.evaluation_state = 'completed'
        ORDER BY publications.source_sequence DESC
        LIMIT 1
      `).get(connectorId) as
        | {
            sourceGeneration: string;
            sourceSequence: number;
            sourceAsOf: string;
            completedAt: string | null;
          }
        | undefined;
      const cutover = handles.sqlite.prepare(`
        SELECT source_generation AS sourceGeneration,
               source_sequence AS sourceSequence,
               delivery_enabled AS deliveryEnabled,
               legacy_disabled AS legacyDisabled,
               rolled_back_at AS rolledBackAt
        FROM finance_insight_cutovers
        WHERE connector_id = ?
      `).get(connectorId) as
        | {
            sourceGeneration: string;
            sourceSequence: number;
            deliveryEnabled: number;
            legacyDisabled: number;
            rolledBackAt: string | null;
          }
        | undefined;
      return {
        connector: {
          id: row.id,
          type: row.type,
          enabled: row.enabled === 1,
          settings: row.settings
            ? JSON.parse(row.settings) as Record<string, unknown>
            : {},
        },
        enabledFinanceConnectorCount: enabledFinanceConnectorIds(handles).length,
        publication: publication ?? null,
        cutover: cutover
          ? {
              sourceGeneration: cutover.sourceGeneration,
              sourceSequence: cutover.sourceSequence,
              deliveryEnabled: cutover.deliveryEnabled === 1,
              legacyDisabled: cutover.legacyDisabled === 1,
              rolledBackAt: cutover.rolledBackAt,
            }
          : null,
      };
    },

    async readCutoverGeneration(input) {
      const publication = handles.sqlite.prepare(`
        SELECT publication.source_sequence AS sourceSequence
        FROM finance_insight_publications publication
        INNER JOIN finance_insight_publication_delivery delivery
          ON delivery.publication_id = publication.id
          AND delivery.connector_id = publication.connector_id
          AND delivery.source_sequence = publication.source_sequence
        INNER JOIN finance_insight_occurrence_cache_state cache
          ON cache.connector_id = publication.connector_id
          AND cache.source_generation = publication.id
          AND cache.source_sequence = publication.source_sequence
        WHERE publication.connector_id = ? AND publication.id = ?
          AND delivery.evaluation_state = 'completed'
      `).get(input.connectorId, input.sourceGeneration) as
        | { sourceSequence: number }
        | undefined;
      if (!publication) return null;
      const rows = handles.sqlite.prepare(`
        SELECT summary_payload AS summaryPayload
        FROM finance_insight_occurrences
        WHERE connector_id = ?
          AND source_generation = ?
          AND source_sequence = ?
          AND is_tombstone = 0
          AND summary_payload IS NOT NULL
        ORDER BY source_updated_at DESC, occurrence_id
      `).all(
        input.connectorId,
        input.sourceGeneration,
        publication.sourceSequence,
      ) as Array<{ summaryPayload: string }>;
      return {
        sourceSequence: publication.sourceSequence,
        summaryPayloads: rows.map((row) => row.summaryPayload),
      };
    },

    async enableCutover(command): Promise<FinanceOperatorCutoverEnableOutcome> {
      return handles.db.transaction((transaction): FinanceOperatorCutoverEnableOutcome => {
        const replay = existingAudit(
          handles,
          command.connectorId,
          command.idempotencyKey,
          'enable',
          command.sourceGeneration,
        );
        if (replay) {
          const blockers = parseBlockerCodes(replay.blockerCodes);
          if (blockers.length > 0) return { outcome: 'blocked', blockers };
          return {
            outcome: 'enabled',
            legacyExpiredCount: replay.legacyExpiredCount,
            importedCount: replay.importedCount,
            suppressedDeliveryCount: replay.suppressedDeliveryCount,
            replayed: true,
            hasPendingDelivery: false,
          };
        }
        const singleConnectorFailure = singleFinanceConnectorFailure(handles, command);
        if (singleConnectorFailure) {
          insertAudit(handles, idFactory, {
            connectorId: command.connectorId,
            operation: 'enable',
            actorType: command.actorType,
            idempotencyKey: command.idempotencyKey,
            sourceGeneration: command.sourceGeneration,
            resultCode: 'finance_insight_cutover_failed',
            blockerCodes: [singleConnectorFailure],
            now: command.now,
          });
          return { outcome: 'blocked', blockers: [singleConnectorFailure] };
        }
        if (alreadyEnabled(handles, command)) {
          const current = handles.sqlite.prepare(`
            SELECT legacy_expired_count AS legacyExpiredCount,
                   imported_count AS importedCount
            FROM finance_insight_cutovers WHERE connector_id = ?
          `).get(command.connectorId) as {
            legacyExpiredCount: number;
            importedCount: number;
          };
          insertAudit(handles, idFactory, {
            connectorId: command.connectorId,
            operation: 'enable',
            actorType: command.actorType,
            idempotencyKey: command.idempotencyKey,
            sourceGeneration: command.sourceGeneration,
            resultCode: 'finance_insight_cutover_enabled',
            legacyExpiredCount: current.legacyExpiredCount,
            importedCount: current.importedCount,
            now: command.now,
          });
          return {
            outcome: 'enabled',
            legacyExpiredCount: current.legacyExpiredCount,
            importedCount: current.importedCount,
            suppressedDeliveryCount: 0,
            replayed: false,
            hasPendingDelivery: false,
          };
        }
        if (command.blockers.length > 0) {
          insertAudit(handles, idFactory, {
            connectorId: command.connectorId,
            operation: 'enable',
            actorType: command.actorType,
            idempotencyKey: command.idempotencyKey,
            sourceGeneration: command.sourceGeneration,
            resultCode: 'finance_insight_cutover_blocked',
            blockerCodes: command.blockers,
            now: command.now,
          });
          return { outcome: 'blocked', blockers: command.blockers };
        }
        const failure = cutoverGenerationFence(handles, command);
        if (failure) {
          insertAudit(handles, idFactory, {
            connectorId: command.connectorId,
            operation: 'enable',
            actorType: command.actorType,
            idempotencyKey: command.idempotencyKey,
            sourceGeneration: command.sourceGeneration,
            resultCode: 'finance_insight_cutover_failed',
            blockerCodes: [failure],
            now: command.now,
          });
          return { outcome: 'blocked', blockers: [failure] };
        }

        reconcileNotifications(
          transaction,
          command.connectorId,
          command.reconcile,
          command.now,
        );
        const legacyExpired = handles.sqlite.prepare(`
          UPDATE notifications
          SET source_state = 'resolved',
              source_resolved_at = COALESCE(source_resolved_at, ?),
              last_source_synced_at = ?,
              state = CASE
                WHEN disposition = 'dismissed' THEN 'dismissed'
                WHEN disposition = 'handled' THEN 'archived'
                ELSE 'resolved'
              END
          WHERE connector_type = 'finance'
            AND connector_instance_id = 'finance-alerts'
            AND template_key = 'anomaly'
            AND source_state = 'active'
        `).run(command.now, command.now);
        const created = createNotificationsInTransaction(
          transaction,
          command.ingest.map(toCreateNotificationInput),
          { now: new Date(command.now), wakeDispatcher: false },
        );
        syncFinanceProviderPresentation(transaction, created);
        const importedCount = created.filter((entry) => entry.created).length;
        const legacyExpiredCount = Number(legacyExpired.changes);
        handles.sqlite.prepare(`
          INSERT INTO finance_insight_cutovers (
            connector_id, cutover_at, source_generation, source_sequence,
            legacy_disabled, delivery_enabled, legacy_expired_count, imported_count,
            result, rolled_back_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(connector_id) DO UPDATE SET
            cutover_at = excluded.cutover_at,
            source_generation = excluded.source_generation,
            source_sequence = excluded.source_sequence,
            legacy_disabled = 1,
            delivery_enabled = 1,
            legacy_expired_count = excluded.legacy_expired_count,
            imported_count = excluded.imported_count,
            result = excluded.result,
            rolled_back_at = NULL,
            updated_at = excluded.updated_at
        `).run(
          command.connectorId,
          command.now,
          command.sourceGeneration,
          command.sourceSequence,
          legacyExpiredCount,
          importedCount,
          JSON.stringify({ status: 'enabled', legacyExpiredCount, importedCount }),
          command.now,
          command.now,
        );
        insertAudit(handles, idFactory, {
          connectorId: command.connectorId,
          operation: 'enable',
          actorType: command.actorType,
          idempotencyKey: command.idempotencyKey,
          sourceGeneration: command.sourceGeneration,
          resultCode: 'finance_insight_cutover_enabled',
          legacyExpiredCount,
          importedCount,
          now: command.now,
        });
        return {
          outcome: 'enabled',
          legacyExpiredCount,
          importedCount,
          suppressedDeliveryCount: 0,
          replayed: false,
          hasPendingDelivery: created.some((entry) => (
            entry.deliveryEvents.some((event) => event.status === 'pending')
          )),
        };
      }, { behavior: 'immediate' });
    },

    async rollbackCutover(command) {
      return handles.db.transaction(() => {
        const connectorRow = handles.sqlite.prepare(`
          SELECT type FROM connector_configs WHERE id = ? AND deleted_at IS NULL
        `).get(command.connectorId) as { type: string } | undefined;
        if (!connectorRow) {
          throw new FinanceOperatorPersistenceError('finance_connector_not_found', 404);
        }
        if (!FINANCE_PROVIDER_ALIASES.includes(
          connectorRow.type.trim().toLowerCase() as typeof FINANCE_PROVIDER_ALIASES[number],
        )) {
          throw new FinanceOperatorPersistenceError('invalid_finance_connector_type', 400);
        }
        const replay = existingAudit(
          handles,
          command.connectorId,
          command.idempotencyKey,
          'rollback',
          command.sourceGeneration,
        );
        if (replay) {
          const blockers = parseBlockerCodes(replay.blockerCodes);
          if (blockers.length > 0) {
            throw new FinanceOperatorPersistenceError(blockers[0]);
          }
          return {
            outcome: 'rolled-back' as const,
            legacyExpiredCount: replay.legacyExpiredCount,
            importedCount: replay.importedCount,
            suppressedDeliveryCount: replay.suppressedDeliveryCount,
            replayed: true,
          };
        }
        const cutover = handles.sqlite.prepare(`
          SELECT source_generation AS sourceGeneration
          FROM finance_insight_cutovers
          WHERE connector_id = ?
        `).get(command.connectorId) as { sourceGeneration: string } | undefined;
        if (!cutover) {
          throw new FinanceOperatorPersistenceError('finance_insight_cutover_unavailable', 404);
        }
        if (cutover.sourceGeneration !== command.sourceGeneration) {
          throw new FinanceOperatorPersistenceError(
            'finance_insight_cutover_generation_stale',
          );
        }
        const pending = (handles.sqlite.prepare(`
          SELECT COUNT(*) AS count
          FROM notification_delivery_events
          WHERE status IN ('pending', 'sending')
            AND notification_id IN (
              SELECT id FROM notifications
              WHERE connector_type = 'finance-manager'
                AND connector_instance_id = ?
                AND (
                  source_id LIKE 'finance-insight:%'
                  OR source_id LIKE 'finance-insight-digest:%'
                )
            )
        `).get(command.connectorId) as { count: number }).count;
        const updated = handles.sqlite.prepare(`
          UPDATE finance_insight_cutovers
          SET delivery_enabled = 0,
              rolled_back_at = ?,
              result = '{"status":"rolled-back"}',
              updated_at = ?
          WHERE connector_id = ?
        `).run(command.now, command.now, command.connectorId);
        if (updated.changes !== 1) {
          throw new FinanceOperatorPersistenceError('finance_insight_cutover_unavailable', 404);
        }
        handles.sqlite.prepare(`
          UPDATE notification_delivery_events
          SET status = 'suppressed',
              suppression_reason = 'finance_insight_cutover_rolled_back',
              next_attempt_at = NULL,
              lease_expires_at = NULL
          WHERE status IN ('pending', 'sending')
            AND notification_id IN (
              SELECT id FROM notifications
              WHERE connector_type = 'finance-manager'
                AND connector_instance_id = ?
                AND (
                  source_id LIKE 'finance-insight:%'
                  OR source_id LIKE 'finance-insight-digest:%'
                )
            )
        `).run(command.connectorId);
        insertAudit(handles, idFactory, {
          connectorId: command.connectorId,
          operation: 'rollback',
          actorType: command.actorType,
          idempotencyKey: command.idempotencyKey,
          sourceGeneration: command.sourceGeneration,
          resultCode: 'finance_insight_cutover_rolled_back',
          suppressedDeliveryCount: pending,
          now: command.now,
        });
        return {
          outcome: 'rolled-back' as const,
          legacyExpiredCount: 0,
          importedCount: 0,
          suppressedDeliveryCount: pending,
          replayed: false,
        };
      }, { behavior: 'immediate' });
    },
  };
}

/**
 * Re-validates, inside the write transaction, that this connector is still the
 * single enabled finance connector. Returns the blocker code, or `null`.
 */
function singleFinanceConnectorFailure(
  handles: SqliteFinanceOperatorHandles,
  command: { connectorId: string },
): string | null {
  const connectorIds = enabledFinanceConnectorIds(handles);
  return connectorIds.length !== 1 || connectorIds[0] !== command.connectorId
    ? 'finance_insight_connector_unavailable'
    : null;
}

/**
 * Re-validates, inside the write transaction, that the requested generation is
 * still a completed publication and is not older than the recorded cutover.
 */
function cutoverGenerationFence(
  handles: SqliteFinanceOperatorHandles,
  command: { connectorId: string; sourceGeneration: string },
): string | null {
  const publication = handles.sqlite.prepare(`
    SELECT publication.source_sequence AS sourceSequence
    FROM finance_insight_publications publication
    INNER JOIN finance_insight_publication_delivery delivery
      ON delivery.publication_id = publication.id
      AND delivery.connector_id = publication.connector_id
      AND delivery.source_sequence = publication.source_sequence
    INNER JOIN finance_insight_occurrence_cache_state cache
      ON cache.connector_id = publication.connector_id
      AND cache.source_generation = publication.id
      AND cache.source_sequence = publication.source_sequence
    WHERE publication.connector_id = ? AND publication.id = ?
      AND delivery.evaluation_state = 'completed'
  `).get(command.connectorId, command.sourceGeneration) as
    | { sourceSequence: number }
    | undefined;
  const existingCutover = handles.sqlite.prepare(`
    SELECT source_generation AS sourceGeneration, source_sequence AS sourceSequence,
           delivery_enabled AS deliveryEnabled
    FROM finance_insight_cutovers
    WHERE connector_id = ?
  `).get(command.connectorId) as
    | { sourceGeneration: string; sourceSequence: number; deliveryEnabled: number }
    | undefined;
  if (
    existingCutover
    && existingCutover.sourceGeneration === command.sourceGeneration
    && existingCutover.deliveryEnabled === 0
  ) {
    return 'finance_insight_cutover_generation_stale';
  }
  if (!publication) return 'finance_insight_cutover_generation_unavailable';
  if (!existingCutover) return null;
  return existingCutover.sourceSequence > publication.sourceSequence
    || (
      existingCutover.sourceSequence === publication.sourceSequence
      && existingCutover.sourceGeneration !== command.sourceGeneration
    )
    ? 'finance_insight_cutover_generation_stale'
    : null;
}

/** True when the requested generation is already the enabled cutover. */
function alreadyEnabled(
  handles: SqliteFinanceOperatorHandles,
  command: { connectorId: string; sourceGeneration: string },
): boolean {
  const row = handles.sqlite.prepare(`
    SELECT source_generation AS sourceGeneration, delivery_enabled AS deliveryEnabled
    FROM finance_insight_cutovers WHERE connector_id = ?
  `).get(command.connectorId) as
    | { sourceGeneration: string; deliveryEnabled: number }
    | undefined;
  return row?.sourceGeneration === command.sourceGeneration && row.deliveryEnabled === 1;
}
