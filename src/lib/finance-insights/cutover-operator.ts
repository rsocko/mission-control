import 'server-only';

import { randomUUID } from 'node:crypto';
import { sqlite } from '@/db';
import logger from '@/lib/logger';
import type { FinanceActorType } from '@/lib/connectors/monarch-money/finance-request';
import {
  getFinanceConnectorConfigurationState,
  isFinanceConnectorType,
} from '@/lib/connectors/monarch-money/config';
import { isFinanceInsightShadowIngestEnabled } from './orchestrator';
import {
  FINANCE_IMMEDIATE_NOTIFICATION_GATE,
  FINANCE_MONTHLY_DIGEST_GATE,
} from './notification-ingestion';
import {
  enableFinanceInsightCutover,
  rollbackFinanceInsightCutover,
} from './cutover';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/;

export type FinanceCutoverBlocker =
  | 'finance_connector_not_found'
  | 'invalid_finance_connector_type'
  | 'finance_insight_connector_unavailable'
  | 'finance_connector_disabled'
  | 'household_currency_unavailable'
  | 'insight_shadow_ingest_disabled'
  | 'finance_notification_gate_enabled'
  | 'finance_insight_cutover_generation_unavailable'
  | 'finance_insight_cutover_generation_stale';

export class FinanceCutoverOperatorError extends Error {
  constructor(
    readonly code:
      | FinanceCutoverBlocker
      | 'invalid_cutover_idempotency_key'
      | 'cutover_idempotency_conflict'
      | 'finance_insight_cutover_unavailable'
      | 'finance_insight_cutover_failed',
    readonly status = 409,
  ) {
    super(code);
    this.name = 'FinanceCutoverOperatorError';
  }
}

interface CutoverAuditRow {
  operation: 'enable' | 'rollback';
  sourceGeneration: string | null;
  resultCode: string;
  blockerCodes: string;
  legacyExpiredCount: number;
  importedCount: number;
  suppressedDeliveryCount: number;
}

function gateEnabled(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === 'true';
}

function requireIdempotencyKey(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new FinanceCutoverOperatorError('invalid_cutover_idempotency_key', 400);
  }
  return normalized;
}

function connector(connectorId: string) {
  const row = sqlite.prepare(`
    SELECT id, type, enabled, settings
    FROM connector_configs
    WHERE id = ? AND deleted_at IS NULL
  `).get(connectorId) as {
    id: string;
    type: string;
    enabled: number;
    settings: string;
  } | undefined;
  if (!row) throw new FinanceCutoverOperatorError('finance_connector_not_found', 404);
  if (!isFinanceConnectorType(row.type)) {
    throw new FinanceCutoverOperatorError('invalid_finance_connector_type', 400);
  }
  return row;
}

function latestCompletedPublication(connectorId: string) {
  return sqlite.prepare(`
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
  `).get(connectorId) as {
    sourceGeneration: string;
    sourceSequence: number;
    sourceAsOf: string;
    completedAt: string | null;
  } | undefined;
}

export function getFinanceInsightCutoverReadiness(
  connectorId: string,
  sourceGeneration?: string,
) {
  const row = connector(connectorId);
  const enabledFinanceCount = (sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM connector_configs
    WHERE enabled = 1 AND deleted_at IS NULL
      AND type IN ('finance', 'finance-manager', 'monarch-money')
  `).get() as { count: number }).count;
  const publication = latestCompletedPublication(connectorId);
  const cutover = sqlite.prepare(`
    SELECT source_generation AS sourceGeneration,
           source_sequence AS sourceSequence,
           delivery_enabled AS deliveryEnabled,
           legacy_disabled AS legacyDisabled,
           rolled_back_at AS rolledBackAt
    FROM finance_insight_cutovers
    WHERE connector_id = ?
  `).get(connectorId) as {
    sourceGeneration: string;
    sourceSequence: number;
    deliveryEnabled: number;
    legacyDisabled: number;
    rolledBackAt: string | null;
  } | undefined;
  const settings = JSON.parse(row.settings) as Record<string, unknown>;
  const configurationState = getFinanceConnectorConfigurationState(settings);
  const immediateNotificationsEnabled = gateEnabled(FINANCE_IMMEDIATE_NOTIFICATION_GATE);
  const monthlyDigestEnabled = gateEnabled(FINANCE_MONTHLY_DIGEST_GATE);
  const blockers: FinanceCutoverBlocker[] = [];
  if (enabledFinanceCount !== 1) blockers.push('finance_insight_connector_unavailable');
  if (row.enabled !== 1) blockers.push('finance_connector_disabled');
  if (configurationState.status !== 'configured') {
    blockers.push('household_currency_unavailable');
  }
  if (!isFinanceInsightShadowIngestEnabled()) {
    blockers.push('insight_shadow_ingest_disabled');
  }
  if (immediateNotificationsEnabled || monthlyDigestEnabled) {
    blockers.push('finance_notification_gate_enabled');
  }
  if (!publication) {
    blockers.push('finance_insight_cutover_generation_unavailable');
  } else if (sourceGeneration && publication.sourceGeneration !== sourceGeneration) {
    blockers.push('finance_insight_cutover_generation_stale');
  }

  return {
    connector: {
      id: row.id,
      enabled: row.enabled === 1,
      configurationState,
    },
    publication: publication ?? null,
    gates: {
      shadowIngestEnabled: isFinanceInsightShadowIngestEnabled(),
      immediateNotificationsEnabled,
      monthlyDigestEnabled,
      deliveryEnabled: cutover?.deliveryEnabled === 1,
    },
    cutover: cutover
      ? {
          sourceGeneration: cutover.sourceGeneration,
          sourceSequence: cutover.sourceSequence,
          state: cutover.deliveryEnabled === 1 ? 'enabled' : 'rolled-back',
          legacyDisabled: cutover.legacyDisabled === 1,
          rolledBackAt: cutover.rolledBackAt,
        }
      : null,
    readiness: {
      ready: blockers.length === 0,
      blockers,
    },
  };
}

function existingAudit(
  connectorId: string,
  idempotencyKey: string,
  operation: 'enable' | 'rollback',
  sourceGeneration: string,
): CutoverAuditRow | undefined {
  const row = sqlite.prepare(`
    SELECT operation, source_generation AS sourceGeneration, result_code AS resultCode,
           blocker_codes AS blockerCodes, legacy_expired_count AS legacyExpiredCount,
           imported_count AS importedCount,
           suppressed_delivery_count AS suppressedDeliveryCount
    FROM finance_insight_cutover_audit
    WHERE connector_id = ? AND idempotency_key = ?
  `).get(connectorId, idempotencyKey) as CutoverAuditRow | undefined;
  if (!row) return undefined;
  if (row.operation !== operation || row.sourceGeneration !== sourceGeneration) {
    throw new FinanceCutoverOperatorError('cutover_idempotency_conflict');
  }
  return row;
}

function insertAudit(input: {
  connectorId: string;
  operation: 'enable' | 'rollback';
  actorType: FinanceActorType;
  idempotencyKey: string;
  sourceGeneration: string;
  resultCode: string;
  blockerCodes?: readonly string[];
  legacyExpiredCount?: number;
  importedCount?: number;
  suppressedDeliveryCount?: number;
  now: string;
}) {
  sqlite.prepare(`
    INSERT INTO finance_insight_cutover_audit (
      id, connector_id, operation, actor_type, idempotency_key, source_generation,
      result_code, blocker_codes, legacy_expired_count, imported_count,
      suppressed_delivery_count, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
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

function replayResult(audit: CutoverAuditRow) {
  const blockers = JSON.parse(audit.blockerCodes) as string[];
  if (blockers.length > 0) {
    throw new FinanceCutoverOperatorError(
      blockers[0] as FinanceCutoverBlocker,
    );
  }
  return {
    status: audit.resultCode === 'finance_insight_cutover_enabled'
      ? 'enabled' as const
      : 'rolled-back' as const,
    legacyExpiredCount: audit.legacyExpiredCount,
    importedCount: audit.importedCount,
    suppressedDeliveryCount: audit.suppressedDeliveryCount,
    replayed: true,
  };
}

export function enableFinanceInsightCutoverForOperator(input: {
  connectorId: string;
  sourceGeneration: string;
  actorType: FinanceActorType;
  idempotencyKey: string | null;
  now?: Date;
}) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const outcome = sqlite.transaction(() => {
    const replay = existingAudit(
      input.connectorId,
      idempotencyKey,
      'enable',
      input.sourceGeneration,
    );
    if (replay) return replayResult(replay);
    const now = (input.now ?? new Date()).toISOString();
    const readiness = getFinanceInsightCutoverReadiness(
      input.connectorId,
      input.sourceGeneration,
    );
    if (!readiness.readiness.ready) {
      insertAudit({
        connectorId: input.connectorId,
        operation: 'enable',
        actorType: input.actorType,
        idempotencyKey,
        sourceGeneration: input.sourceGeneration,
        resultCode: 'finance_insight_cutover_blocked',
        blockerCodes: readiness.readiness.blockers,
        now,
      });
      logger.warn({
        connectorId: input.connectorId,
        sourceGeneration: input.sourceGeneration,
        blockerCodes: readiness.readiness.blockers,
        operation: 'financeInsightCutoverEnable',
      }, 'Finance Insight cutover blocked');
      return { blocked: readiness.readiness.blockers[0] } as const;
    }
    let result: ReturnType<typeof enableFinanceInsightCutover>;
    try {
      result = enableFinanceInsightCutover({
        connectorId: input.connectorId,
        sourceGeneration: input.sourceGeneration,
        now: input.now,
      });
    } catch (error) {
      const candidate = error instanceof Error ? error.message : '';
      const code: FinanceCutoverBlocker
        | 'finance_insight_cutover_unavailable'
        | 'finance_insight_cutover_failed' = [
          'finance_insight_connector_unavailable',
          'finance_insight_cutover_generation_stale',
          'finance_insight_cutover_generation_unavailable',
          'finance_insight_cutover_unavailable',
        ].includes(candidate)
          ? candidate as FinanceCutoverBlocker | 'finance_insight_cutover_unavailable'
          : 'finance_insight_cutover_failed';
      insertAudit({
        connectorId: input.connectorId,
        operation: 'enable',
        actorType: input.actorType,
        idempotencyKey,
        sourceGeneration: input.sourceGeneration,
        resultCode: 'finance_insight_cutover_failed',
        blockerCodes: [code],
        now,
      });
      return { blocked: code } as const;
    }
    insertAudit({
      connectorId: input.connectorId,
      operation: 'enable',
      actorType: input.actorType,
      idempotencyKey,
      sourceGeneration: input.sourceGeneration,
      resultCode: 'finance_insight_cutover_enabled',
      legacyExpiredCount: result.legacyExpiredCount,
      importedCount: result.importedCount,
      now,
    });
    logger.info({
      connectorId: input.connectorId,
      sourceGeneration: input.sourceGeneration,
      legacyExpiredCount: result.legacyExpiredCount,
      importedCount: result.importedCount,
      operation: 'financeInsightCutoverEnable',
    }, 'Finance Insight cutover enabled');
    return { ...result, suppressedDeliveryCount: 0, replayed: false };
  }).immediate();
  if ('blocked' in outcome) {
    throw new FinanceCutoverOperatorError(outcome.blocked);
  }
  return outcome;
}

export function rollbackFinanceInsightCutoverForOperator(input: {
  connectorId: string;
  sourceGeneration: string;
  actorType: FinanceActorType;
  idempotencyKey: string | null;
  now?: Date;
}) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  return sqlite.transaction(() => {
    connector(input.connectorId);
    const replay = existingAudit(
      input.connectorId,
      idempotencyKey,
      'rollback',
      input.sourceGeneration,
    );
    if (replay) return replayResult(replay);
    const cutover = sqlite.prepare(`
      SELECT source_generation AS sourceGeneration
      FROM finance_insight_cutovers
      WHERE connector_id = ?
    `).get(input.connectorId) as { sourceGeneration: string } | undefined;
    if (!cutover) {
      throw new FinanceCutoverOperatorError('finance_insight_cutover_unavailable', 404);
    }
    if (cutover.sourceGeneration !== input.sourceGeneration) {
      throw new FinanceCutoverOperatorError('finance_insight_cutover_generation_stale');
    }
    const pending = (sqlite.prepare(`
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
    `).get(input.connectorId) as { count: number }).count;
    const now = (input.now ?? new Date()).toISOString();
    rollbackFinanceInsightCutover(input.connectorId, input.now);
    insertAudit({
      connectorId: input.connectorId,
      operation: 'rollback',
      actorType: input.actorType,
      idempotencyKey,
      sourceGeneration: input.sourceGeneration,
      resultCode: 'finance_insight_cutover_rolled_back',
      suppressedDeliveryCount: pending,
      now,
    });
    logger.warn({
      connectorId: input.connectorId,
      sourceGeneration: input.sourceGeneration,
      suppressedDeliveryCount: pending,
      operation: 'financeInsightCutoverRollback',
    }, 'Finance Insight cutover rolled back');
    return {
      status: 'rolled-back' as const,
      legacyExpiredCount: 0,
      importedCount: 0,
      suppressedDeliveryCount: pending,
      replayed: false,
    };
  }).immediate();
}
