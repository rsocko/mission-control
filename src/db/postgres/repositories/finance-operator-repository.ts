import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';
import {
  materializeNotificationActions,
  registerDefaultNotificationProviders,
  resolveNotificationProvider,
} from '@/lib/notifications/providers';
import type { InboundNotification } from '@/types';
import type {
  FinanceInsightNotificationIngestItem,
  FinanceInsightNotificationReconcileItem,
} from '@/db/persistence/finance-insights';
import {
  FinanceOperatorPersistenceError,
  type FinanceOperatorCutoverEnableOutcome,
  type FinanceOperatorHealthSnapshot,
  type FinanceOperatorPersistence,
  type FinanceOperatorReadinessInputs,
} from '@/db/persistence/finance-operator';
import { ingestPostgresConnectorNotificationInTransaction } from './connector-execution-repositories';

/**
 * PostgreSQL implementation of `FinanceWorkerPersistence.operator`.
 *
 * The health snapshot is a bounded read. Both cutover mutations run in a single
 * transaction under a connector-scoped advisory transaction lock, so the
 * readiness/generation fence, the idempotency audit, the notification
 * lifecycle, and the cutover state switch commit together. Dispatcher wake is
 * reported (`hasPendingDelivery`) rather than performed, so the caller wakes it
 * strictly after commit.
 */

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

async function lockCutoverScope(client: PoolClient, connectorId: string): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`finance-insight-cutover:${connectorId}`],
  );
}

interface CutoverAuditRow {
  operation: 'enable' | 'rollback';
  sourceGeneration: string | null;
  resultCode: string;
  blockerCodes: unknown;
  legacyExpiredCount: number;
  importedCount: number;
  suppressedDeliveryCount: number;
}

function parseBlockerCodes(value: unknown): string[] {
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

async function existingAudit(
  client: PoolClient,
  connectorId: string,
  idempotencyKey: string | null,
  operation: 'enable' | 'rollback',
  sourceGeneration: string,
): Promise<CutoverAuditRow | undefined> {
  if (!idempotencyKey) return undefined;
  const [row] = await query<CutoverAuditRow>(client, `
    SELECT operation, source_generation AS "sourceGeneration",
           result_code AS "resultCode", blocker_codes AS "blockerCodes",
           legacy_expired_count AS "legacyExpiredCount",
           imported_count AS "importedCount",
           suppressed_delivery_count AS "suppressedDeliveryCount"
    FROM finance_insight_cutover_audit
    WHERE connector_id = $1 AND idempotency_key = $2
    FOR UPDATE
  `, [connectorId, idempotencyKey]);
  if (!row) return undefined;
  if (row.operation !== operation || row.sourceGeneration !== sourceGeneration) {
    throw new FinanceOperatorPersistenceError('cutover_idempotency_conflict');
  }
  return row;
}

async function insertAudit(
  client: PoolClient,
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
): Promise<void> {
  if (!input.idempotencyKey || !input.actorType) return;
  await client.query(`
    INSERT INTO finance_insight_cutover_audit (
      id, connector_id, operation, actor_type, idempotency_key, source_generation,
      result_code, blocker_codes, legacy_expired_count, imported_count,
      suppressed_delivery_count, created_at, completed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $12)
  `, [
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
  ]);
}

async function enabledFinanceConnectorIds(client: Client): Promise<string[]> {
  const rows = await query<{ id: string }>(client, `
    SELECT id FROM connector_configs
    WHERE enabled = true AND deleted_at IS NULL AND type = ANY($1::text[])
    ORDER BY id
  `, [[...FINANCE_PROVIDER_ALIASES]]);
  return rows.map((row) => row.id);
}

interface StoredNotificationRow {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  body: string | null;
  level: string;
  category: string;
  readState: string;
  isActionable: boolean;
  receivedAt: string;
  metadata: unknown;
  sourceState: string;
  presentation: unknown;
}

function providerNotification(row: StoredNotificationRow): InboundNotification {
  return {
    id: row.id,
    sourceId: row.sourceId,
    connectorType: row.connectorType,
    connectorInstanceId: row.connectorInstanceId,
    title: row.title,
    body: row.body ?? undefined,
    level: row.level as InboundNotification['level'],
    category: row.category,
    isRead: row.readState === 'read',
    isActionable: row.isActionable,
    receivedAt: row.receivedAt,
    sourceState: row.sourceState as InboundNotification['sourceState'],
    hubProjectIds: [],
    tags: [],
    metadata: row.metadata as Record<string, unknown>,
  };
}

async function syncPresentation(client: PoolClient, notificationId: string): Promise<void> {
  const [row] = await query<StoredNotificationRow>(client, `
    SELECT id, source_id AS "sourceId", connector_type AS "connectorType",
           connector_instance_id AS "connectorInstanceId", title, body, level, category,
           read_state AS "readState", is_actionable AS "isActionable",
           received_at AS "receivedAt", metadata, source_state AS "sourceState", presentation
    FROM notifications WHERE id = $1
  `, [notificationId]);
  if (!row) return;

  registerDefaultNotificationProviders();
  const resolved = resolveNotificationProvider(providerNotification(row));
  if (!resolved) return;

  const active = row.sourceState === 'active';
  const drafts = active
    ? (resolved.presentation.actions ?? []).filter((action) => action.actionType !== 'create_task')
    : [];
  let actionIndex = 0;
  const actionRecords = materializeNotificationActions(
    row.id,
    drafts,
    () => `${row.id}:finance-action:${actionIndex++}`,
  );
  await client.query(`
    DELETE FROM notification_actions WHERE notification_id = $1 AND created_by = 'connector'
  `, [row.id]);
  for (const action of actionRecords) {
    await client.query(`
      INSERT INTO notification_actions (
        id, notification_id, action_type, label, icon, variant, is_primary,
        sort_order, payload, opens_external, requires_confirmation, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
    `, [
      action.id,
      action.notificationId,
      action.actionType,
      action.label,
      action.icon ?? null,
      action.variant,
      action.isPrimary,
      action.sortOrder,
      JSON.stringify(action.payload),
      action.opensExternal,
      action.requiresConfirmation,
      action.createdBy,
    ]);
  }
  const existingPresentation = row.presentation !== null
    && typeof row.presentation === 'object'
    && !Array.isArray(row.presentation)
    ? row.presentation
    : {};
  await client.query(`
    UPDATE notifications
    SET title = $1, body = $2, presentation = $3::jsonb, is_actionable = $4, primary_action_id = $5
    WHERE id = $6
  `, [
    resolved.presentation.title ?? row.title,
    resolved.presentation.body ?? row.body,
    JSON.stringify({
      ...existingPresentation,
      ...(resolved.presentation.presentation ?? {}),
    }),
    active && (resolved.presentation.isActionable ?? actionRecords.length > 0),
    actionRecords.find((action) => action.isPrimary)?.id ?? null,
    row.id,
  ]);
}

async function reconcileOne(
  client: PoolClient,
  connectorId: string,
  item: FinanceInsightNotificationReconcileItem,
  nowIso: string,
): Promise<void> {
  const [existing] = await query<{
    id: string;
    disposition: string;
    sourceResolvedAt: string | null;
  }>(client, `
    SELECT id, disposition, source_resolved_at AS "sourceResolvedAt"
    FROM notifications
    WHERE source_id = $1 AND connector_type = 'finance-manager' AND connector_instance_id = $2
  `, [item.sourceId, connectorId]);
  if (!existing) return;

  const state = existing.disposition === 'dismissed'
    ? 'dismissed'
    : existing.disposition === 'handled'
      ? 'archived'
      : 'resolved';
  await client.query(`
    UPDATE notifications
    SET state = $1, source_state = 'resolved', source_resolved_at = $2,
        last_source_activity_at = $3, last_source_activity_key = $4,
        last_source_synced_at = $5, is_actionable = false, primary_action_id = NULL,
        metadata = $6::jsonb
    WHERE id = $7
  `, [
    state,
    existing.sourceResolvedAt ?? item.sourceResolvedAt ?? nowIso,
    item.lastSourceActivityAt,
    item.lastSourceActivityKey,
    nowIso,
    JSON.stringify(item.metadata),
    existing.id,
  ]);
  await client.query(`
    DELETE FROM notification_actions WHERE notification_id = $1 AND created_by = 'connector'
  `, [existing.id]);
}

async function ingestOne(
  client: PoolClient,
  item: FinanceInsightNotificationIngestItem,
): Promise<{ created: boolean; pendingDelivery: boolean }> {
  const result = await ingestPostgresConnectorNotificationInTransaction(client, {
    input: item.input,
    actions: [],
  });
  await client.query(`
    UPDATE notifications SET group_key = $1, dedupe_key = $2 WHERE id = $3
  `, [item.groupKey, item.dedupeKey, result.id]);
  await syncPresentation(client, result.id);
  return { created: result.created, pendingDelivery: result.pendingDelivery };
}

async function singleFinanceConnectorFailure(
  client: PoolClient,
  connectorId: string,
): Promise<string | null> {
  const connectorIds = await enabledFinanceConnectorIds(client);
  return connectorIds.length !== 1 || connectorIds[0] !== connectorId
    ? 'finance_insight_connector_unavailable'
    : null;
}

async function completedPublicationSequence(
  client: Client,
  connectorId: string,
  sourceGeneration: string,
): Promise<number | null> {
  const [row] = await query<{ sourceSequence: number }>(client, `
    SELECT publication.source_sequence AS "sourceSequence"
    FROM finance_insight_publications publication
    INNER JOIN finance_insight_publication_delivery delivery
      ON delivery.publication_id = publication.id
      AND delivery.connector_id = publication.connector_id
      AND delivery.source_sequence = publication.source_sequence
    INNER JOIN finance_insight_occurrence_cache_state cache
      ON cache.connector_id = publication.connector_id
      AND cache.source_generation = publication.id
      AND cache.source_sequence = publication.source_sequence
    WHERE publication.connector_id = $1 AND publication.id = $2
      AND delivery.evaluation_state = 'completed'
  `, [connectorId, sourceGeneration]);
  return row ? Number(row.sourceSequence) : null;
}

interface CutoverRow {
  sourceGeneration: string;
  sourceSequence: number;
  deliveryEnabled: boolean;
  legacyExpiredCount: number;
  importedCount: number;
}

async function readCutoverRow(
  client: Client,
  connectorId: string,
): Promise<CutoverRow | undefined> {
  const [row] = await query<CutoverRow>(client, `
    SELECT source_generation AS "sourceGeneration", source_sequence AS "sourceSequence",
           delivery_enabled AS "deliveryEnabled",
           legacy_expired_count AS "legacyExpiredCount",
           imported_count AS "importedCount"
    FROM finance_insight_cutovers WHERE connector_id = $1
  `, [connectorId]);
  return row;
}

function cutoverGenerationFence(
  cutover: CutoverRow | undefined,
  publicationSequence: number | null,
  sourceGeneration: string,
): string | null {
  if (
    cutover
    && cutover.sourceGeneration === sourceGeneration
    && cutover.deliveryEnabled === false
  ) {
    return 'finance_insight_cutover_generation_stale';
  }
  if (publicationSequence === null) return 'finance_insight_cutover_generation_unavailable';
  if (!cutover) return null;
  return Number(cutover.sourceSequence) > publicationSequence
    || (
      Number(cutover.sourceSequence) === publicationSequence
      && cutover.sourceGeneration !== sourceGeneration
    )
    ? 'finance_insight_cutover_generation_stale'
    : null;
}

async function countPendingInsightDeliveries(
  client: PoolClient,
  connectorId: string,
): Promise<number> {
  const [row] = await query<{ count: string }>(client, `
    SELECT COUNT(*) AS count
    FROM notification_delivery_events
    WHERE status IN ('pending', 'sending')
      AND notification_id IN (
        SELECT id FROM notifications
        WHERE connector_type = 'finance-manager'
          AND connector_instance_id = $1
          AND (
            source_id LIKE 'finance-insight:%'
            OR source_id LIKE 'finance-insight-digest:%'
          )
      )
  `, [connectorId]);
  return Number(row?.count ?? 0);
}

export function createPostgresFinanceOperatorPersistence(
  pool: Pool,
  options: { idFactory?: () => string } = {},
): FinanceOperatorPersistence {
  const idFactory = options.idFactory ?? randomUUID;

  return {
    async isLegacyAnomalyProductionEnabled(): Promise<boolean> {
      const [cutover] = await query<{ present: number }>(pool, `
        SELECT 1 AS present
        FROM finance_insight_cutovers
        WHERE legacy_disabled = true
        LIMIT 1
      `);
      return cutover === undefined;
    },

    async readHealthSnapshot(connectorId): Promise<FinanceOperatorHealthSnapshot> {
      const [state] = await query<{
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
      }>(pool, `
        SELECT status, last_attempt_at AS "lastAttemptAt",
               last_successful_sync_at AS "lastSuccessfulSyncAt",
               last_successful_window_start AS "lastSuccessfulWindowStart",
               last_successful_window_end AS "lastSuccessfulWindowEnd",
               last_error_code AS "lastErrorCode",
               attribution_status AS "attributionStatus",
               attribution_last_attempt_at AS "attributionLastAttemptAt",
               attribution_last_successful_at AS "attributionLastSuccessfulAt",
               attribution_last_error_code AS "attributionLastErrorCode",
               attribution_policy_version AS "attributionPolicyVersion",
               attribution_engine_version AS "attributionEngineVersion"
        FROM finance_sync_state WHERE connector_id = $1 LIMIT 1
      `, [connectorId]);
      const [activeJob] = await query<{
        id: string;
        status: string;
        attempt: number;
        maxAttempts: number;
        availableAt: string | null;
        startedAt: string | null;
      }>(pool, `
        SELECT id, status, attempt, max_attempts AS "maxAttempts",
               available_at AS "availableAt", started_at AS "startedAt"
        FROM sync_jobs
        WHERE connector_id = $1 AND status IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1
      `, [connectorId]);
      const [capture] = await query<{
        status: string | null;
        lastAttemptAt: string | null;
        lastErrorCode: string | null;
      }>(pool, `
        SELECT last_capture_outcome AS status,
               last_capture_attempt_at AS "lastAttemptAt",
               last_error_code AS "lastErrorCode"
        FROM finance_insight_publication_state
        WHERE connector_id = $1 LIMIT 1
      `, [connectorId]);
      const [evaluation] = await query<{
        status: string | null;
        stage: string | null;
        lastAttemptAt: string | null;
        lastSuccessfulAt: string | null;
        lastErrorCode: string | null;
        retryable: boolean | null;
      }>(pool, `
        SELECT evaluation_state AS status, stage,
               last_attempt_at AS "lastAttemptAt",
               last_successful_at AS "lastSuccessfulAt",
               last_error_code AS "lastErrorCode",
               last_error_retryable AS retryable
        FROM finance_insight_publication_delivery
        WHERE connector_id = $1
        ORDER BY updated_at DESC
        LIMIT 1
      `, [connectorId]);
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
        activeJob: activeJob
          ? {
              id: activeJob.id,
              status: activeJob.status,
              attempt: Number(activeJob.attempt),
              maxAttempts: Number(activeJob.maxAttempts),
              availableAt: activeJob.availableAt,
              startedAt: activeJob.startedAt,
            }
          : null,
        capture: capture ?? null,
        evaluation: evaluation
          ? {
              status: evaluation.status,
              stage: evaluation.stage,
              lastAttemptAt: evaluation.lastAttemptAt,
              lastSuccessfulAt: evaluation.lastSuccessfulAt,
              lastErrorCode: evaluation.lastErrorCode,
              retryable: evaluation.retryable === true,
            }
          : null,
      };
    },

    async readCutoverReadiness(connectorId): Promise<FinanceOperatorReadinessInputs> {
      const [row] = await query<{
        id: string;
        type: string;
        enabled: boolean;
        settings: unknown;
      }>(pool, `
        SELECT id, type, enabled, settings
        FROM connector_configs WHERE id = $1 AND deleted_at IS NULL
      `, [connectorId]);
      if (!row) {
        throw new FinanceOperatorPersistenceError('finance_connector_not_found', 404);
      }
      const [publication] = await query<{
        sourceGeneration: string;
        sourceSequence: number;
        sourceAsOf: string;
        completedAt: string | null;
      }>(pool, `
        SELECT publications.id AS "sourceGeneration",
               publications.source_sequence AS "sourceSequence",
               publications.source_as_of AS "sourceAsOf",
               delivery.last_successful_at AS "completedAt"
        FROM finance_insight_publications publications
        INNER JOIN finance_insight_publication_delivery delivery
          ON delivery.publication_id = publications.id
          AND delivery.connector_id = publications.connector_id
          AND delivery.source_sequence = publications.source_sequence
        INNER JOIN finance_insight_occurrence_cache_state cache
          ON cache.connector_id = publications.connector_id
          AND cache.source_generation = publications.id
          AND cache.source_sequence = publications.source_sequence
        WHERE publications.connector_id = $1
          AND delivery.evaluation_state = 'completed'
        ORDER BY publications.source_sequence DESC
        LIMIT 1
      `, [connectorId]);
      const [cutover] = await query<{
        sourceGeneration: string;
        sourceSequence: number;
        deliveryEnabled: boolean;
        legacyDisabled: boolean;
        rolledBackAt: string | null;
      }>(pool, `
        SELECT source_generation AS "sourceGeneration",
               source_sequence AS "sourceSequence",
               delivery_enabled AS "deliveryEnabled",
               legacy_disabled AS "legacyDisabled",
               rolled_back_at AS "rolledBackAt"
        FROM finance_insight_cutovers WHERE connector_id = $1
      `, [connectorId]);
      const settings = row.settings;
      return {
        connector: {
          id: row.id,
          type: row.type,
          enabled: row.enabled === true,
          settings: settings && typeof settings === 'object' && !Array.isArray(settings)
            ? settings as Record<string, unknown>
            : {},
        },
        enabledFinanceConnectorCount: (await enabledFinanceConnectorIds(pool)).length,
        publication: publication
          ? {
              sourceGeneration: publication.sourceGeneration,
              sourceSequence: Number(publication.sourceSequence),
              sourceAsOf: publication.sourceAsOf,
              completedAt: publication.completedAt,
            }
          : null,
        cutover: cutover
          ? {
              sourceGeneration: cutover.sourceGeneration,
              sourceSequence: Number(cutover.sourceSequence),
              deliveryEnabled: cutover.deliveryEnabled === true,
              legacyDisabled: cutover.legacyDisabled === true,
              rolledBackAt: cutover.rolledBackAt,
            }
          : null,
      };
    },

    async readCutoverGeneration(input) {
      const sourceSequence = await completedPublicationSequence(
        pool,
        input.connectorId,
        input.sourceGeneration,
      );
      if (sourceSequence === null) return null;
      const rows = await query<{ summaryPayload: string }>(pool, `
        SELECT summary_payload AS "summaryPayload"
        FROM finance_insight_occurrences
        WHERE connector_id = $1
          AND source_generation = $2
          AND source_sequence = $3
          AND is_tombstone = false
          AND summary_payload IS NOT NULL
        ORDER BY source_updated_at DESC, occurrence_id
      `, [input.connectorId, input.sourceGeneration, sourceSequence]);
      return {
        sourceSequence,
        summaryPayloads: rows.map((row) => (
          typeof row.summaryPayload === 'string'
            ? row.summaryPayload
            : JSON.stringify(row.summaryPayload)
        )),
      };
    },

    async enableCutover(command): Promise<FinanceOperatorCutoverEnableOutcome> {
      return transaction(pool, async (client): Promise<FinanceOperatorCutoverEnableOutcome> => {
        await lockCutoverScope(client, command.connectorId);
        const replay = await existingAudit(
          client,
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
            legacyExpiredCount: Number(replay.legacyExpiredCount),
            importedCount: Number(replay.importedCount),
            suppressedDeliveryCount: Number(replay.suppressedDeliveryCount),
            replayed: true,
            hasPendingDelivery: false,
          };
        }
        const connectorFailure = await singleFinanceConnectorFailure(
          client,
          command.connectorId,
        );
        if (connectorFailure) {
          await insertAudit(client, idFactory, {
            connectorId: command.connectorId,
            operation: 'enable',
            actorType: command.actorType,
            idempotencyKey: command.idempotencyKey,
            sourceGeneration: command.sourceGeneration,
            resultCode: 'finance_insight_cutover_failed',
            blockerCodes: [connectorFailure],
            now: command.now,
          });
          return { outcome: 'blocked', blockers: [connectorFailure] };
        }
        const cutover = await readCutoverRow(client, command.connectorId);
        if (
          cutover
          && cutover.sourceGeneration === command.sourceGeneration
          && cutover.deliveryEnabled === true
        ) {
          await insertAudit(client, idFactory, {
            connectorId: command.connectorId,
            operation: 'enable',
            actorType: command.actorType,
            idempotencyKey: command.idempotencyKey,
            sourceGeneration: command.sourceGeneration,
            resultCode: 'finance_insight_cutover_enabled',
            legacyExpiredCount: Number(cutover.legacyExpiredCount),
            importedCount: Number(cutover.importedCount),
            now: command.now,
          });
          return {
            outcome: 'enabled',
            legacyExpiredCount: Number(cutover.legacyExpiredCount),
            importedCount: Number(cutover.importedCount),
            suppressedDeliveryCount: 0,
            replayed: false,
            hasPendingDelivery: false,
          };
        }
        if (command.blockers.length > 0) {
          await insertAudit(client, idFactory, {
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
        const failure = cutoverGenerationFence(
          cutover,
          await completedPublicationSequence(
            client,
            command.connectorId,
            command.sourceGeneration,
          ),
          command.sourceGeneration,
        );
        if (failure) {
          await insertAudit(client, idFactory, {
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

        for (const item of command.reconcile) {
          await reconcileOne(client, command.connectorId, item, command.now);
        }
        const legacyExpired = await client.query(`
          UPDATE notifications
          SET source_state = 'resolved',
              source_resolved_at = COALESCE(source_resolved_at, $1),
              last_source_synced_at = $1,
              state = CASE
                WHEN disposition = 'dismissed' THEN 'dismissed'
                WHEN disposition = 'handled' THEN 'archived'
                ELSE 'resolved'
              END
          WHERE connector_type = 'finance'
            AND connector_instance_id = 'finance-alerts'
            AND template_key = 'anomaly'
            AND source_state = 'active'
        `, [command.now]);
        let importedCount = 0;
        let hasPendingDelivery = false;
        for (const item of command.ingest) {
          const result = await ingestOne(client, item);
          if (result.created) importedCount += 1;
          if (result.pendingDelivery) hasPendingDelivery = true;
        }
        const legacyExpiredCount = Number(legacyExpired.rowCount ?? 0);
        await client.query(`
          INSERT INTO finance_insight_cutovers (
            connector_id, cutover_at, source_generation, source_sequence,
            legacy_disabled, delivery_enabled, legacy_expired_count, imported_count,
            result, rolled_back_at, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, true, true, $5, $6, $7::jsonb, NULL, $2, $2)
          ON CONFLICT (connector_id) DO UPDATE SET
            cutover_at = EXCLUDED.cutover_at,
            source_generation = EXCLUDED.source_generation,
            source_sequence = EXCLUDED.source_sequence,
            legacy_disabled = true,
            delivery_enabled = true,
            legacy_expired_count = EXCLUDED.legacy_expired_count,
            imported_count = EXCLUDED.imported_count,
            result = EXCLUDED.result,
            rolled_back_at = NULL,
            updated_at = EXCLUDED.updated_at
        `, [
          command.connectorId,
          command.now,
          command.sourceGeneration,
          command.sourceSequence,
          legacyExpiredCount,
          importedCount,
          JSON.stringify({ status: 'enabled', legacyExpiredCount, importedCount }),
        ]);
        await insertAudit(client, idFactory, {
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
          hasPendingDelivery,
        };
      });
    },

    async rollbackCutover(command) {
      return transaction(pool, async (client) => {
        await lockCutoverScope(client, command.connectorId);
        const [connectorRow] = await query<{ type: string }>(client, `
          SELECT type FROM connector_configs WHERE id = $1 AND deleted_at IS NULL
        `, [command.connectorId]);
        if (!connectorRow) {
          throw new FinanceOperatorPersistenceError('finance_connector_not_found', 404);
        }
        if (!(FINANCE_PROVIDER_ALIASES as readonly string[]).includes(
          connectorRow.type.trim().toLowerCase(),
        )) {
          throw new FinanceOperatorPersistenceError('invalid_finance_connector_type', 400);
        }
        const replay = await existingAudit(
          client,
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
            legacyExpiredCount: Number(replay.legacyExpiredCount),
            importedCount: Number(replay.importedCount),
            suppressedDeliveryCount: Number(replay.suppressedDeliveryCount),
            replayed: true,
          };
        }
        const cutover = await readCutoverRow(client, command.connectorId);
        if (!cutover) {
          throw new FinanceOperatorPersistenceError('finance_insight_cutover_unavailable', 404);
        }
        if (cutover.sourceGeneration !== command.sourceGeneration) {
          throw new FinanceOperatorPersistenceError(
            'finance_insight_cutover_generation_stale',
          );
        }
        const pending = await countPendingInsightDeliveries(client, command.connectorId);
        const updated = await client.query(`
          UPDATE finance_insight_cutovers
          SET delivery_enabled = false,
              rolled_back_at = $1,
              result = '{"status":"rolled-back"}'::jsonb,
              updated_at = $1
          WHERE connector_id = $2
        `, [command.now, command.connectorId]);
        if (updated.rowCount !== 1) {
          throw new FinanceOperatorPersistenceError('finance_insight_cutover_unavailable', 404);
        }
        await client.query(`
          UPDATE notification_delivery_events
          SET status = 'suppressed',
              suppression_reason = 'finance_insight_cutover_rolled_back',
              next_attempt_at = NULL,
              lease_expires_at = NULL
          WHERE status IN ('pending', 'sending')
            AND notification_id IN (
              SELECT id FROM notifications
              WHERE connector_type = 'finance-manager'
                AND connector_instance_id = $1
                AND (
                  source_id LIKE 'finance-insight:%'
                  OR source_id LIKE 'finance-insight-digest:%'
                )
            )
        `, [command.connectorId]);
        await insertAudit(client, idFactory, {
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
      });
    },
  };
}
