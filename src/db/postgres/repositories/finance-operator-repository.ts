import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';
import {
  financeConnectorScopedReference,
  financeIdentityNamespaceFromCredentials,
} from '@/lib/connectors/monarch-money/identity';
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
  financeCleanBootstrapConfirmationToken,
  financeCleanBootstrapScopeDigest,
  type FinanceCleanBootstrapApplyResult,
  type FinanceCleanBootstrapDryRunResult,
  type FinanceCleanBootstrapInventory,
  type FinanceOperatorCutoverEnableOutcome,
  type FinanceOperatorHealthSnapshot,
  type FinanceOperatorPersistence,
  type FinanceOperatorReadinessInputs,
  type FinanceOperatorAttributionAccountSummary,
  type FinanceOperatorAttributionPreviewProjection,
} from '@/db/persistence/finance-operator';
import { attributionAttentionAccountRef } from '@/lib/finance/attribution-attention-policy';
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

interface CleanBootstrapAuditRow {
  mode: 'dry-run' | 'apply';
  dryRunId: string;
  scopeDigest: string;
  confirmationToken: string;
  inventory: unknown;
  result: unknown;
}

async function cleanBootstrapInventory(
  client: Client,
  connectorId: string,
): Promise<FinanceCleanBootstrapInventory> {
  const [row] = await query<{
    manualAttributionDecisions: string;
    automatedAttributionExceptions: string;
    financeNotifications: string;
    financeTasks: string;
    accountProjections: string;
    transactionProjections: string;
    historyProjections: string;
    backfillPlans: string;
    backfillProofs: string;
    activeDeliveryWork: string;
    activeActionWork: string;
  }>(client, `
    SELECT
      (SELECT COUNT(*) FROM finance_transactions
        WHERE connector_instance_id = $1
          AND (
            manual_decision_action IS NOT NULL
            OR manual_decided_at IS NOT NULL
            OR kid_assignment_method = 'manual'
            OR attribution_decision_source = 'manual'
          )) AS "manualAttributionDecisions",
      (SELECT COUNT(*) FROM finance_attribution_exceptions
        WHERE connector_id = $1) AS "automatedAttributionExceptions",
      (SELECT COUNT(*) FROM notifications
        WHERE connector_instance_id = $1
          AND connector_type IN ('finance-manager', 'monarch-money', 'finance'))
        AS "financeNotifications",
      (SELECT COUNT(*) FROM tasks
        WHERE connector_instance_id = $1
          AND connector_type IN ('finance-manager', 'monarch-money', 'finance'))
        AS "financeTasks",
      (SELECT COUNT(*) FROM finance_accounts WHERE connector_id = $1)
        AS "accountProjections",
      (SELECT COUNT(*) FROM finance_transactions WHERE connector_instance_id = $1)
        AS "transactionProjections",
      (
        (SELECT COUNT(*) FROM finance_insight_transaction_projection_facts
          WHERE connector_id = $1)
        + (SELECT COUNT(*) FROM finance_insight_transaction_projection_windows
          WHERE connector_id = $1)
        + (SELECT COUNT(*) FROM finance_insight_publication_facts
          WHERE publication_id IN (
            SELECT id FROM finance_insight_publications WHERE connector_id = $1
          ))
        + (SELECT COUNT(*) FROM finance_insight_occurrences WHERE connector_id = $1)
      ) AS "historyProjections",
      (SELECT COUNT(*) FROM finance_insight_transaction_backfill_plans
        WHERE connector_id = $1) AS "backfillPlans",
      (SELECT COUNT(*) FROM finance_insight_transaction_window_proofs
        WHERE connector_id = $1) AS "backfillProofs",
      (SELECT COUNT(*)
        FROM notification_delivery_events delivery
        INNER JOIN notifications notification ON notification.id = delivery.notification_id
        WHERE notification.connector_instance_id = $1
          AND notification.connector_type IN ('finance-manager', 'monarch-money', 'finance')
          AND delivery.status IN ('pending', 'sending')) AS "activeDeliveryWork",
      (SELECT COUNT(*)
        FROM notification_actions action
        INNER JOIN notifications notification ON notification.id = action.notification_id
        WHERE notification.connector_instance_id = $1
          AND notification.connector_type IN ('finance-manager', 'monarch-money', 'finance')
          AND action.claimed_at IS NOT NULL
          AND action.completed_at IS NULL) AS "activeActionWork"
  `, [connectorId]);
  if (!row) throw new Error('Clean bootstrap inventory query returned no row');
  return {
    manualAttributionDecisions: Number(row.manualAttributionDecisions),
    automatedAttributionExceptions: Number(row.automatedAttributionExceptions),
    financeNotifications: Number(row.financeNotifications),
    financeTasks: Number(row.financeTasks),
    accountProjections: Number(row.accountProjections),
    transactionProjections: Number(row.transactionProjections),
    historyProjections: Number(row.historyProjections),
    backfillPlans: Number(row.backfillPlans),
    backfillProofs: Number(row.backfillProofs),
    activeDeliveryWork: Number(row.activeDeliveryWork),
    activeActionWork: Number(row.activeActionWork),
  };
}

async function cleanBootstrapScopeIdentities(
  client: Client,
  connectorId: string,
): Promise<string[]> {
  const rows = await query<{ identity: string }>(client, `
    SELECT identity FROM (
      SELECT 'notification:' || id || ':' || state || ':' || source_state AS identity
      FROM notifications
      WHERE connector_instance_id = $1
        AND connector_type IN ('finance-manager', 'monarch-money', 'finance')
      UNION ALL
      SELECT 'notification-action:' || action.id || ':' || action.execution_state
        || ':' || COALESCE(action.claimed_at, '') || ':' || COALESCE(action.completed_at, '')
      FROM notification_actions action
      INNER JOIN notifications notification ON notification.id = action.notification_id
      WHERE notification.connector_instance_id = $1
        AND notification.connector_type IN ('finance-manager', 'monarch-money', 'finance')
      UNION ALL
      SELECT 'notification-delivery:' || delivery.id || ':' || delivery.status
      FROM notification_delivery_events delivery
      INNER JOIN notifications notification ON notification.id = delivery.notification_id
      WHERE notification.connector_instance_id = $1
        AND notification.connector_type IN ('finance-manager', 'monarch-money', 'finance')
      UNION ALL
      SELECT 'task:' || id || ':' || status || ':' || local_disposition || ':' || updated_at
      FROM tasks
      WHERE connector_instance_id = $1
        AND connector_type IN ('finance-manager', 'monarch-money', 'finance')
      UNION ALL
      SELECT 'transaction:' || id || ':' || source_fingerprint || ':'
        || COALESCE(attribution_updated_at, '') || ':' || COALESCE(manual_decision_action, '')
        || ':' || COALESCE(manual_decided_at, '')
      FROM finance_transactions WHERE connector_instance_id = $1
      UNION ALL
      SELECT 'account:' || id || ':' || last_seen_at
      FROM finance_accounts WHERE connector_id = $1
      UNION ALL
      SELECT 'attribution-exception:' || id || ':' || status || ':' || updated_at
      FROM finance_attribution_exceptions WHERE connector_id = $1
      UNION ALL
      SELECT 'attribution-audit:' || id FROM finance_attribution_audit
      WHERE connector_id = $1
      UNION ALL
      SELECT 'attribution-subject:' || id || ':' || last_seen_at
      FROM finance_attribution_subjects WHERE connector_id = $1
      UNION ALL
      SELECT 'attention-receipt:' || delivery_key || ':' || version
      FROM finance_attention_delivery_receipts WHERE connector_id = $1
      UNION ALL
      SELECT 'attention-repair:' || id FROM finance_attention_repair_audit
      WHERE connector_id = $1
      UNION ALL
      SELECT 'connection-outage:' || episode_id || ':' || updated_at
      FROM finance_connection_outages WHERE connector_id = $1
      UNION ALL
      SELECT 'occurrence-cache:' || source_generation || ':' || source_sequence || ':' || updated_at
      FROM finance_insight_occurrence_cache_state WHERE connector_id = $1
      UNION ALL
      SELECT 'occurrence:' || occurrence_id || ':' || revision_digest || ':' || source_updated_at
      FROM finance_insight_occurrences WHERE connector_id = $1
      UNION ALL
      SELECT 'cutover-audit:' || id FROM finance_insight_cutover_audit
      WHERE connector_id = $1
      UNION ALL
      SELECT 'cutover:' || source_generation || ':' || source_sequence || ':' || updated_at
      FROM finance_insight_cutovers WHERE connector_id = $1
      UNION ALL
      SELECT 'publication:' || id || ':' || manifest_digest
      FROM finance_insight_publications WHERE connector_id = $1
      UNION ALL
      SELECT 'publication-fact:' || fact.publication_id || ':' || fact.kind || ':' || fact.source_ref
      FROM finance_insight_publication_facts fact
      INNER JOIN finance_insight_publications publication ON publication.id = fact.publication_id
      WHERE publication.connector_id = $1
      UNION ALL
      SELECT 'publication-delivery:' || publication_id || ':' || stage || ':' || updated_at
      FROM finance_insight_publication_delivery WHERE connector_id = $1
      UNION ALL
      SELECT 'publication-state:' || COALESCE(latest_publication_id, '') || ':' || updated_at
      FROM finance_insight_publication_state WHERE connector_id = $1
      UNION ALL
      SELECT 'projection-fact:' || generation_id || ':' || source_ref
      FROM finance_insight_transaction_projection_facts WHERE connector_id = $1
      UNION ALL
      SELECT 'projection-window:' || generation_id || ':' || window_index || ':' || content_digest
      FROM finance_insight_transaction_projection_windows WHERE connector_id = $1
      UNION ALL
      SELECT 'projection-state:' || COALESCE(successful_generation_id, '') || ':'
        || COALESCE(content_digest, '') || ':' || COALESCE(windows_digest, '') || ':' || updated_at
      FROM finance_insight_transaction_projection_state WHERE connector_id = $1
      UNION ALL
      SELECT 'backfill-proof:' || plan_id || ':' || window_ordinal || ':' || content_digest
      FROM finance_insight_transaction_window_proofs WHERE connector_id = $1
      UNION ALL
      SELECT 'backfill-plan:' || id || ':' || status || ':' || updated_at
      FROM finance_insight_transaction_backfill_plans WHERE connector_id = $1
      UNION ALL
      SELECT 'sync-state:' || updated_at FROM finance_sync_state
      WHERE connector_id = $1
      UNION ALL
      SELECT 'dataset-state:' || dataset || ':' || updated_at FROM finance_dataset_sync_state
      WHERE connector_id = $1 AND dataset = 'accounts'
    ) scope
    ORDER BY identity
  `, [connectorId]);
  return rows.map((row) => row.identity);
}

async function assertCleanBootstrapFence(
  client: PoolClient,
  connectorId: string,
  leaseOwner: string,
  now: string,
): Promise<void> {
  const [connector] = await query<{ type: string; enabled: boolean }>(client, `
    SELECT type, enabled FROM connector_configs
    WHERE id = $1 AND deleted_at IS NULL
    FOR UPDATE
  `, [connectorId]);
  if (!connector) {
    throw new FinanceOperatorPersistenceError('finance_connector_not_found', 404);
  }
  if (!FINANCE_PROVIDER_ALIASES.includes(
    connector.type.trim().toLowerCase() as typeof FINANCE_PROVIDER_ALIASES[number],
  )) {
    throw new FinanceOperatorPersistenceError('invalid_finance_connector_type', 400);
  }
  if (connector.enabled) {
    throw new FinanceOperatorPersistenceError('finance_insight_repair_connector_enabled');
  }
  const [quarantine] = await query<{ present: number }>(client, `
    SELECT 1 AS present FROM connector_sync_controls
    WHERE connector_id = $1 AND scheduler_state = 'quarantined'
      AND released_at IS NULL
  `, [connectorId]);
  if (!quarantine) {
    throw new FinanceOperatorPersistenceError('finance_insight_repair_quarantine_required');
  }
  const [activeJob] = await query<{ present: number }>(client, `
    SELECT 1 AS present FROM sync_jobs
    WHERE connector_id = $1 AND status IN ('queued', 'running')
    LIMIT 1
  `, [connectorId]);
  if (activeJob) {
    throw new FinanceOperatorPersistenceError('finance_insight_repair_active_work');
  }
  const [lease] = await query<{ present: number }>(client, `
    SELECT 1 AS present FROM connector_operation_leases
    WHERE connector_id = $1 AND operation_type = 'retention'
      AND owner = $2 AND lease_expires_at > $3
    FOR UPDATE
  `, [connectorId, leaseOwner, now]);
  if (!lease) {
    throw new FinanceOperatorPersistenceError('finance_clean_bootstrap_lease_lost');
  }
}

async function existingCleanBootstrapAudit(
  client: PoolClient,
  connectorId: string,
  idempotencyKey: string,
): Promise<CleanBootstrapAuditRow | undefined> {
  const [row] = await query<CleanBootstrapAuditRow>(client, `
    SELECT mode, dry_run_id AS "dryRunId", scope_digest AS "scopeDigest",
           confirmation_token AS "confirmationToken", inventory, result
    FROM finance_clean_bootstrap_audit
    WHERE connector_id = $1 AND idempotency_key = $2
    FOR UPDATE
  `, [connectorId, idempotencyKey]);
  return row;
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

async function financeIdentityNamespace(
  client: Client,
  connectorId: string,
): Promise<string> {
  const [row] = await query<{ credentials: unknown }>(client, `
    SELECT credentials
    FROM connector_configs
    WHERE id = $1 AND deleted_at IS NULL
  `, [connectorId]);
  if (!row) {
    throw new FinanceOperatorPersistenceError('finance_connector_not_found', 404);
  }
  const namespace = financeIdentityNamespaceFromCredentials(row.credentials);
  if (!namespace) {
    throw new FinanceOperatorPersistenceError('finance_identity_state_unavailable');
  }
  return namespace;
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
    async inventoryCleanBootstrap(command): Promise<FinanceCleanBootstrapDryRunResult> {
      return transaction(pool, async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`finance-clean-bootstrap:${command.connectorId}`],
        );
        const replay = await existingCleanBootstrapAudit(
          client,
          command.connectorId,
          command.idempotencyKey,
        );
        if (replay) {
          if (replay.mode !== 'dry-run') {
            throw new FinanceOperatorPersistenceError(
              'finance_clean_bootstrap_idempotency_conflict',
            );
          }
          return {
            mode: 'dry-run',
            dryRunId: replay.dryRunId,
            connectorId: command.connectorId,
            inventory: replay.inventory as FinanceCleanBootstrapInventory,
            scopeDigest: replay.scopeDigest,
            confirmationToken: replay.confirmationToken,
            replayed: true,
          };
        }
        await assertCleanBootstrapFence(
          client,
          command.connectorId,
          command.leaseOwner,
          command.now,
        );
        const inventory = await cleanBootstrapInventory(client, command.connectorId);
        const dryRunId = idFactory();
        const scopeDigest = financeCleanBootstrapScopeDigest(
          command.connectorId,
          inventory,
          await cleanBootstrapScopeIdentities(client, command.connectorId),
        );
        const confirmationToken = financeCleanBootstrapConfirmationToken(
          command.connectorId,
          dryRunId,
          scopeDigest,
        );
        const result: FinanceCleanBootstrapDryRunResult = {
          mode: 'dry-run',
          dryRunId,
          connectorId: command.connectorId,
          inventory,
          scopeDigest,
          confirmationToken,
          replayed: false,
        };
        await client.query(`
          INSERT INTO finance_clean_bootstrap_audit (
            id, connector_id, mode, actor_type, idempotency_key, dry_run_id,
            scope_digest, confirmation_token, inventory, result, created_at, completed_at
          ) VALUES ($1, $2, 'dry-run', $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $10)
        `, [
          idFactory(),
          command.connectorId,
          command.actorType,
          command.idempotencyKey,
          dryRunId,
          scopeDigest,
          confirmationToken,
          JSON.stringify(inventory),
          JSON.stringify(result),
          command.now,
        ]);
        return result;
      });
    },

    async applyCleanBootstrap(command): Promise<FinanceCleanBootstrapApplyResult> {
      return transaction(pool, async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`finance-clean-bootstrap:${command.connectorId}`],
        );
        const replay = await existingCleanBootstrapAudit(
          client,
          command.connectorId,
          command.idempotencyKey,
        );
        if (replay) {
          if (
            replay.mode !== 'apply'
            || replay.dryRunId !== command.dryRunId
            || replay.scopeDigest !== command.scopeDigest
            || replay.confirmationToken !== command.confirmationToken
          ) {
            throw new FinanceOperatorPersistenceError(
              'finance_clean_bootstrap_idempotency_conflict',
            );
          }
          return {
            ...(replay.result as FinanceCleanBootstrapApplyResult),
            replayed: true,
          };
        }
        await assertCleanBootstrapFence(
          client,
          command.connectorId,
          command.leaseOwner,
          command.now,
        );
        const [dryRun] = await query<{
          scopeDigest: string;
          confirmationToken: string;
          inventory: unknown;
        }>(client, `
          SELECT scope_digest AS "scopeDigest",
                 confirmation_token AS "confirmationToken", inventory
          FROM finance_clean_bootstrap_audit
          WHERE connector_id = $1 AND dry_run_id = $2 AND mode = 'dry-run'
          FOR UPDATE
        `, [command.connectorId, command.dryRunId]);
        if (!dryRun) {
          throw new FinanceOperatorPersistenceError(
            'finance_clean_bootstrap_dry_run_not_found',
            404,
          );
        }
        if (
          dryRun.scopeDigest !== command.scopeDigest
          || dryRun.confirmationToken !== command.confirmationToken
        ) {
          throw new FinanceOperatorPersistenceError(
            'finance_clean_bootstrap_confirmation_mismatch',
          );
        }
        const inventory = await cleanBootstrapInventory(client, command.connectorId);
        const currentDigest = financeCleanBootstrapScopeDigest(
          command.connectorId,
          inventory,
          await cleanBootstrapScopeIdentities(client, command.connectorId),
        );
        if (currentDigest !== command.scopeDigest) {
          throw new FinanceOperatorPersistenceError(
            'finance_clean_bootstrap_scope_drift',
          );
        }
        if (inventory.manualAttributionDecisions > 0) {
          throw new FinanceOperatorPersistenceError(
            'finance_clean_bootstrap_manual_decisions_present',
          );
        }
        if (inventory.activeDeliveryWork > 0 || inventory.activeActionWork > 0) {
          throw new FinanceOperatorPersistenceError(
            'finance_clean_bootstrap_in_flight_work',
          );
        }

        await client.query(`
          UPDATE notifications
          SET source_state = 'resolved',
              source_resolved_at = COALESCE(source_resolved_at, $1),
              last_source_synced_at = $1,
              state = CASE
                WHEN disposition = 'dismissed' THEN 'dismissed'
                WHEN disposition = 'handled' THEN 'archived'
                ELSE 'resolved'
              END,
              is_actionable = false,
              primary_action_id = NULL,
              ai_suggested_action_id = NULL,
              auto_resolve_reason = 'finance_clean_bootstrap'
          WHERE connector_instance_id = $2
            AND connector_type IN ('finance-manager', 'monarch-money', 'finance')
        `, [command.now, command.connectorId]);
        await client.query(`
          DELETE FROM notification_actions
          WHERE notification_id IN (
            SELECT id FROM notifications
            WHERE connector_instance_id = $1
              AND connector_type IN ('finance-manager', 'monarch-money', 'finance')
          )
        `, [command.connectorId]);
        await client.query(`
          UPDATE tasks
          SET status = CASE
                WHEN status IN ('done', 'cancelled') THEN status
                ELSE 'cancelled'
              END,
              local_disposition = CASE
                WHEN local_disposition = 'dismissed' THEN 'dismissed'
                ELSE 'handled'
              END,
              status_reason = CASE
                WHEN status IN ('done', 'cancelled') THEN status_reason
                ELSE 'not_planned'
              END,
              updated_at = $1
          WHERE connector_instance_id = $2
            AND connector_type IN ('finance-manager', 'monarch-money', 'finance')
        `, [command.now, command.connectorId]);

        await client.query(
          'DELETE FROM finance_attribution_audit WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_attribution_exceptions WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_attribution_subjects WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_attention_delivery_receipts WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_attention_repair_audit WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_connection_outages WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_insight_occurrence_cache_state WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_insight_occurrences WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_insight_cutover_audit WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_insight_cutovers WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(`
          DELETE FROM finance_insight_publication_facts
          WHERE publication_id IN (
            SELECT id FROM finance_insight_publications WHERE connector_id = $1
          )
        `, [command.connectorId]);
        await client.query(
          'DELETE FROM finance_insight_publication_delivery WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_insight_publications WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_insight_publication_state WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_insight_transaction_projection_facts WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_insight_transaction_projection_windows WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_insight_transaction_projection_state WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_insight_transaction_window_proofs WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_insight_transaction_backfill_plans WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_transactions WHERE connector_instance_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_accounts WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(
          'DELETE FROM finance_sync_state WHERE connector_id = $1',
          [command.connectorId],
        );
        await client.query(`
          DELETE FROM finance_dataset_sync_state
          WHERE connector_id = $1 AND dataset = 'accounts'
        `, [command.connectorId]);

        const retired = {
          automatedAttributionExceptions: inventory.automatedAttributionExceptions,
          financeNotifications: inventory.financeNotifications,
          financeTasks: inventory.financeTasks,
          accountProjections: inventory.accountProjections,
          transactionProjections: inventory.transactionProjections,
          historyProjections: inventory.historyProjections,
          backfillPlans: inventory.backfillPlans,
          backfillProofs: inventory.backfillProofs,
        };
        const result: FinanceCleanBootstrapApplyResult = {
          mode: 'apply',
          dryRunId: command.dryRunId,
          connectorId: command.connectorId,
          scopeDigest: command.scopeDigest,
          retired,
          replayed: false,
        };
        await client.query(`
          INSERT INTO finance_clean_bootstrap_audit (
            id, connector_id, mode, actor_type, idempotency_key, dry_run_id,
            scope_digest, confirmation_token, inventory, result, created_at, completed_at
          ) VALUES ($1, $2, 'apply', $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $10)
        `, [
          idFactory(),
          command.connectorId,
          command.actorType,
          command.idempotencyKey,
          command.dryRunId,
          command.scopeDigest,
          command.confirmationToken,
          JSON.stringify(inventory),
          JSON.stringify(result),
          command.now,
        ]);
        return result;
      });
    },

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
      const [projection] = await query<
        NonNullable<FinanceOperatorHealthSnapshot['projection']>
      >(pool, `
        SELECT status, successful_generation_id AS "generationId",
               last_successful_at AS "lastSuccessfulAt", source_as_of AS "sourceAsOf",
               item_count AS "itemCount", coverage_start AS "coverageStart",
               coverage_end AS "coverageEnd", window_count AS "windowCount",
               bridge_contract_version AS "bridgeContractVersion",
               last_error_code AS "lastErrorCode", updated_at AS "updatedAt"
        FROM finance_insight_transaction_projection_state
        WHERE connector_id = $1
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
        projection: projection
            ? {
                ...projection,
                itemCount: projection.itemCount === null
                  ? null
                  : Number(projection.itemCount),
                windowCount: projection.windowCount === null
                  ? null
                  : Number(projection.windowCount),
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

    async readAttributionAccountSummary(connectorId): Promise<FinanceOperatorAttributionAccountSummary> {
      const rows = await query<{
        accountId: string;
        displayName: string;
        active: boolean;
      }>(pool, `
        SELECT upstream_account_id AS "accountId", display_name AS "displayName",
               is_active AS active
        FROM finance_accounts
        WHERE connector_id = $1
          AND (
            is_active = true
            OR EXISTS (
              SELECT 1
              FROM finance_transactions transactions
              WHERE transactions.connector_instance_id = finance_accounts.connector_id
                AND transactions.account_id = finance_accounts.upstream_account_id
                AND transactions.lifecycle_status = 'active'
            )
          )
        ORDER BY display_name, upstream_account_id
      `, [connectorId]);
      return {
        total: rows.length,
        active: rows.filter((row) => row.active).length,
        accounts: rows.map((row) => ({
          accountRef: attributionAttentionAccountRef(connectorId, row.accountId),
          displayName: row.displayName,
          active: row.active,
        })),
      };
    },

    async readAttributionPreview({ connectorId, limit }): Promise<FinanceOperatorAttributionPreviewProjection> {
      const namespace = await financeIdentityNamespace(pool, connectorId);
      const [countRow] = await query<{ count: string }>(pool, `
        SELECT COUNT(*) AS count
        FROM finance_transactions
        WHERE connector_instance_id = $1 AND lifecycle_status = 'active'
      `, [connectorId]);
      const rows = await query<{
        upstreamTransactionId: string;
        occurredOn: string;
        merchantName: string | null;
        accountId: string | null;
        observedAt: string;
        assignedKidId: string | null;
        kidAssignmentMethod: string | null;
        manualDecisionAction: string | null;
        manualDecidedAt: string | null;
        firstSeenAt: string;
      }>(pool, `
        SELECT upstream_transaction_id AS "upstreamTransactionId",
               date AS "occurredOn", merchant_name AS "merchantName",
               account_id AS "accountId", last_seen_at AS "observedAt",
               assigned_kid_id AS "assignedKidId",
               kid_assignment_method AS "kidAssignmentMethod",
               manual_decision_action AS "manualDecisionAction",
               manual_decided_at AS "manualDecidedAt",
               first_seen_at AS "firstSeenAt"
        FROM finance_transactions
        WHERE connector_instance_id = $1 AND lifecycle_status = 'active'
        ORDER BY date DESC, upstream_transaction_id
        LIMIT $2
      `, [connectorId, limit]);
      const total = Number(countRow?.count ?? 0);
      return {
        items: rows.map((row) => {
          if (!row.accountId) {
            throw new FinanceOperatorPersistenceError(
              'finance_attribution_projection_unavailable',
            );
          }
          const decidedAt = row.manualDecidedAt ?? row.firstSeenAt;
          const existingManualDecision = row.kidAssignmentMethod !== 'manual'
            ? null
            : row.manualDecisionAction === 'assign-kid' && row.assignedKidId
              ? {
                  action: 'assign-kid' as const,
                  kidId: row.assignedKidId,
                  decidedAt,
                }
              : {
                  action: 'parent-expense' as const,
                  kidId: null,
                  decidedAt,
                };
          return {
            sourceRef: financeConnectorScopedReference(
              namespace,
              'source',
              row.upstreamTransactionId,
            ),
            occurredOn: row.occurredOn,
            merchantName: row.merchantName ?? 'Unknown merchant',
            accountRef: row.accountId,
            observedAt: row.observedAt,
            existingManualDecision,
          };
        }),
        total,
        truncated: total > rows.length,
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
