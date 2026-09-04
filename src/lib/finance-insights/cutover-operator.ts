import 'server-only';

import logger from '@/lib/logger';
import type { FinanceActorType } from '@/lib/connectors/monarch-money/finance-request';
import {
  getFinanceConnectorConfigurationState,
  isFinanceConnectorType,
} from '@/lib/connectors/monarch-money/config';
import {
  FinanceOperatorPersistenceError,
  type FinanceOperatorPersistence,
  type FinanceOperatorReadinessInputs,
} from '@/db/persistence/finance-operator';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
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

async function operatorPersistence(): Promise<FinanceOperatorPersistence> {
  return (await getWorkerPersistenceRepositories()).finance.operator;
}

/**
 * Maps the adapter's stable persistence error onto the operator API's existing
 * code/status contract, so no route behavior changes.
 */
function toOperatorError(error: unknown): FinanceCutoverOperatorError {
  if (error instanceof FinanceCutoverOperatorError) return error;
  if (error instanceof FinanceOperatorPersistenceError) {
    return new FinanceCutoverOperatorError(
      error.code as FinanceCutoverOperatorError['code'],
      error.status,
    );
  }
  return new FinanceCutoverOperatorError('finance_insight_cutover_failed');
}

async function readinessInputs(connectorId: string): Promise<FinanceOperatorReadinessInputs> {
  try {
    return await (await operatorPersistence()).readCutoverReadiness(connectorId);
  } catch (error) {
    throw toOperatorError(error);
  }
}

export async function getFinanceInsightCutoverReadiness(
  connectorId: string,
  sourceGeneration?: string,
) {
  const inputs = await readinessInputs(connectorId);
  if (!isFinanceConnectorType(inputs.connector.type)) {
    throw new FinanceCutoverOperatorError('invalid_finance_connector_type', 400);
  }
  const configurationState = getFinanceConnectorConfigurationState(inputs.connector.settings);
  const immediateNotificationsEnabled = gateEnabled(FINANCE_IMMEDIATE_NOTIFICATION_GATE);
  const monthlyDigestEnabled = gateEnabled(FINANCE_MONTHLY_DIGEST_GATE);
  const blockers: FinanceCutoverBlocker[] = [];
  if (inputs.enabledFinanceConnectorCount !== 1) {
    blockers.push('finance_insight_connector_unavailable');
  }
  if (!inputs.connector.enabled) blockers.push('finance_connector_disabled');
  if (configurationState.status !== 'configured') {
    blockers.push('household_currency_unavailable');
  }
  if (!isFinanceInsightShadowIngestEnabled()) {
    blockers.push('insight_shadow_ingest_disabled');
  }
  if (immediateNotificationsEnabled || monthlyDigestEnabled) {
    blockers.push('finance_notification_gate_enabled');
  }
  if (!inputs.publication) {
    blockers.push('finance_insight_cutover_generation_unavailable');
  } else if (sourceGeneration && inputs.publication.sourceGeneration !== sourceGeneration) {
    blockers.push('finance_insight_cutover_generation_stale');
  }

  return {
    connector: {
      id: inputs.connector.id,
      enabled: inputs.connector.enabled,
      configurationState,
    },
    publication: inputs.publication,
    gates: {
      shadowIngestEnabled: isFinanceInsightShadowIngestEnabled(),
      immediateNotificationsEnabled,
      monthlyDigestEnabled,
      deliveryEnabled: inputs.cutover?.deliveryEnabled === true,
    },
    cutover: inputs.cutover
      ? {
          sourceGeneration: inputs.cutover.sourceGeneration,
          sourceSequence: inputs.cutover.sourceSequence,
          state: inputs.cutover.deliveryEnabled ? 'enabled' : 'rolled-back',
          legacyDisabled: inputs.cutover.legacyDisabled,
          rolledBackAt: inputs.cutover.rolledBackAt,
        }
      : null,
    readiness: {
      ready: blockers.length === 0,
      blockers,
    },
  };
}

export async function enableFinanceInsightCutoverForOperator(input: {
  connectorId: string;
  sourceGeneration: string;
  actorType: FinanceActorType;
  idempotencyKey: string | null;
  now?: Date;
}) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const readiness = await getFinanceInsightCutoverReadiness(
    input.connectorId,
    input.sourceGeneration,
  );
  try {
    const result = await enableFinanceInsightCutover({
      connectorId: input.connectorId,
      sourceGeneration: input.sourceGeneration,
      actorType: input.actorType,
      idempotencyKey,
      blockers: readiness.readiness.blockers,
      now: input.now,
    });
    // A replay re-reports the first committed outcome; only a fresh enable is
    // a new operational event worth recording.
    if (!result.replayed) {
      logger.info({
        connectorId: input.connectorId,
        sourceGeneration: input.sourceGeneration,
        legacyExpiredCount: result.legacyExpiredCount,
        importedCount: result.importedCount,
        operation: 'financeInsightCutoverEnable',
      }, 'Finance Insight cutover enabled');
    }
    return result;
  } catch (error) {
    const operatorError = toOperatorError(error);
    logger.warn({
      connectorId: input.connectorId,
      sourceGeneration: input.sourceGeneration,
      blockerCodes: [operatorError.code],
      operation: 'financeInsightCutoverEnable',
    }, 'Finance Insight cutover blocked');
    throw operatorError;
  }
}

export async function rollbackFinanceInsightCutoverForOperator(input: {
  connectorId: string;
  sourceGeneration: string;
  actorType: FinanceActorType;
  idempotencyKey: string | null;
  now?: Date;
}) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  try {
    const result = await rollbackFinanceInsightCutover({
      connectorId: input.connectorId,
      sourceGeneration: input.sourceGeneration,
      actorType: input.actorType,
      idempotencyKey,
      now: input.now,
    });
    if (!result.replayed) {
      logger.warn({
        connectorId: input.connectorId,
        sourceGeneration: input.sourceGeneration,
        suppressedDeliveryCount: result.suppressedDeliveryCount,
        operation: 'financeInsightCutoverRollback',
      }, 'Finance Insight cutover rolled back');
    }
    return result;
  } catch (error) {
    throw toOperatorError(error);
  }
}
