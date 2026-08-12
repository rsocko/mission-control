import 'server-only';

import { sqlite, runTransaction } from '@/db';
import { createNotificationsInTransaction, wakeNotificationDeliveryDispatcher } from '@/lib/notifications/service';
import { insightOccurrenceSummarySchema, type InsightOccurrenceSummaryV1 } from './contract';
import { FINANCE_PROVIDER_ALIASES } from './provider';
import {
  reconcileFinanceInsightNotificationLifecycle,
  selectFinanceInsightNotificationInputs,
  syncFinanceProviderPresentation,
} from './notification-ingestion';

const financeTypePlaceholders = FINANCE_PROVIDER_ALIASES.map(() => '?').join(', ');

function enabledFinanceConnectorIds(): string[] {
  return (sqlite.prepare(`
    SELECT id FROM connector_configs
    WHERE enabled = 1 AND deleted_at IS NULL
      AND type IN (${financeTypePlaceholders})
    ORDER BY id
  `).all(...FINANCE_PROVIDER_ALIASES) as Array<{ id: string }>).map((row) => row.id);
}

export function resolveSingleFinanceConnectorId(): string {
  const connectorIds = enabledFinanceConnectorIds();
  if (connectorIds.length !== 1) {
    throw new Error('finance_insight_connector_unavailable');
  }
  return connectorIds[0];
}

export function isFinanceInsightDeliveryEnabled(connectorId: string): boolean {
  const row = sqlite.prepare(`
    SELECT delivery_enabled AS deliveryEnabled
    FROM finance_insight_cutovers WHERE connector_id = ?
  `).get(connectorId) as { deliveryEnabled: number } | undefined;
  return row?.deliveryEnabled === 1;
}

export function isLegacyFinanceAnomalyProductionEnabled(): boolean {
  const row = sqlite.prepare(`
    SELECT 1 AS disabled
    FROM finance_insight_cutovers
    WHERE legacy_disabled = 1
    LIMIT 1
  `).get() as { disabled: number } | undefined;
  return row === undefined;
}

export function enableFinanceInsightCutover(input: {
  connectorId: string;
  sourceGeneration: string;
  now?: Date;
}): {
  status: 'enabled';
  legacyExpiredCount: number;
  importedCount: number;
} {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const result = runTransaction((transaction) => {
    if (resolveSingleFinanceConnectorId() !== input.connectorId) {
      throw new Error('finance_insight_connector_unavailable');
    }
    const existingCutover = sqlite.prepare(`
      SELECT source_generation AS sourceGeneration, source_sequence AS sourceSequence,
             delivery_enabled AS deliveryEnabled,
             legacy_expired_count AS legacyExpiredCount, imported_count AS importedCount
      FROM finance_insight_cutovers
      WHERE connector_id = ?
    `).get(input.connectorId) as {
      sourceGeneration: string;
      sourceSequence: number;
      deliveryEnabled: number;
      legacyExpiredCount: number;
      importedCount: number;
    } | undefined;
    if (existingCutover) {
      if (
        existingCutover.sourceGeneration === input.sourceGeneration
        && existingCutover.deliveryEnabled === 1
      ) {
        return {
          status: 'enabled' as const,
          legacyExpiredCount: existingCutover.legacyExpiredCount,
          importedCount: existingCutover.importedCount,
          hasPendingDelivery: false,
        };
      }
      if (
        existingCutover.sourceGeneration === input.sourceGeneration
        && existingCutover.deliveryEnabled === 0
      ) {
        throw new Error('finance_insight_cutover_generation_stale');
      }
    }
    const publication = sqlite.prepare(`
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
    `).get(input.connectorId, input.sourceGeneration) as { sourceSequence: number } | undefined;
    if (!publication) throw new Error('finance_insight_cutover_generation_unavailable');
    if (
      existingCutover
      && (
        existingCutover.sourceSequence > publication.sourceSequence
        || (
          existingCutover.sourceSequence === publication.sourceSequence
          && existingCutover.sourceGeneration !== input.sourceGeneration
        )
      )
    ) {
      throw new Error('finance_insight_cutover_generation_stale');
    }
    const rows = sqlite.prepare(`
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
    const items = rows.map((row) => (
      insightOccurrenceSummarySchema.parse(JSON.parse(row.summaryPayload))
    ));
    const latestByOccurrence = new Map<string, InsightOccurrenceSummaryV1>();
    for (const item of items) {
      const current = latestByOccurrence.get(item.occurrenceId);
      if (!current || item.deliveryRevision > current.deliveryRevision) {
        latestByOccurrence.set(item.occurrenceId, item);
      }
    }
    const lifecycleItems = [...latestByOccurrence.values()];
    const notificationInputs = selectFinanceInsightNotificationInputs(
      input.connectorId,
      lifecycleItems.filter((item) => item.sourceLifecycle === 'open'),
      now,
    );
    reconcileFinanceInsightNotificationLifecycle(
      transaction,
      input.connectorId,
      lifecycleItems,
      now,
    );

    const legacyExpired = sqlite.prepare(`
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
    `).run(nowIso, nowIso);
    const created = createNotificationsInTransaction(transaction, notificationInputs, {
      now,
      wakeDispatcher: false,
    });
    syncFinanceProviderPresentation(transaction, created);
    const importedCount = created.filter((entry) => entry.created).length;
    const legacyExpiredCount = Number(legacyExpired.changes);
    const metadataOnlyResult = JSON.stringify({
      status: 'enabled',
      legacyExpiredCount,
      importedCount,
    });
    sqlite.prepare(`
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
      input.connectorId,
      nowIso,
      input.sourceGeneration,
      publication.sourceSequence,
      legacyExpiredCount,
      importedCount,
      metadataOnlyResult,
      nowIso,
      nowIso,
    );
    return {
      status: 'enabled' as const,
      legacyExpiredCount,
      importedCount,
      hasPendingDelivery: created.some((entry) => (
        entry.deliveryEvents.some((event) => event.status === 'pending')
      )),
    };
  });
  if (result.hasPendingDelivery) wakeNotificationDeliveryDispatcher();
  return {
    status: result.status,
    legacyExpiredCount: result.legacyExpiredCount,
    importedCount: result.importedCount,
  };
}

export function rollbackFinanceInsightCutover(
  connectorId: string,
  now = new Date(),
): void {
  const timestamp = now.toISOString();
  runTransaction(() => {
    const updated = sqlite.prepare(`
      UPDATE finance_insight_cutovers
      SET delivery_enabled = 0,
          rolled_back_at = ?,
          result = '{"status":"rolled-back"}',
          updated_at = ?
      WHERE connector_id = ?
    `).run(timestamp, timestamp, connectorId);
    if (updated.changes !== 1) throw new Error('finance_insight_cutover_unavailable');
    sqlite.prepare(`
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
    `).run(connectorId);
  });
}
