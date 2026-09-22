/**
 * Backend-neutral persistence contract for the finance connector/operator web
 * surface: the bounded health snapshot behind `GET /api/connectors/:id/health`
 * and the insight-cutover readiness/enable/rollback operations behind
 * `GET|POST /api/connectors/:id/finance-operations`.
 *
 * This port is composed as `FinanceWorkerPersistence.finance.operator`. It is
 * not a runtime slot, exposes no raw handle, and owns no generic connector
 * state: the connection-test badge stays on `ConnectorRepository.recordTestResult`
 * because `POST /api/connectors/:id/test` is a generic connector route and both
 * backends already own connector configuration.
 *
 * Every operation is a domain operation. There is no SQL, query builder, or
 * schema type here, and no operation returns persistence metadata (publication
 * identifiers excepted where the existing public readiness response already
 * exposes them), transaction identifiers, raw provider output, or credentials.
 */

import type {
  FinanceInsightNotificationIngestItem,
  FinanceInsightNotificationReconcileItem,
} from './finance-insights';

export type FinanceOperatorActorType = 'parent-admin' | 'service';

// ─── Health snapshot ────────────────────────────────────────────────────────

export interface FinanceOperatorSyncSnapshot {
  status: string;
  lastAttemptAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastSuccessfulWindowStart: string | null;
  lastSuccessfulWindowEnd: string | null;
  lastErrorCode: string | null;
}

export interface FinanceOperatorAttributionSnapshot {
  status: string;
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  lastErrorCode: string | null;
  policyVersion: number | null;
  engineVersion: string | null;
}

export interface FinanceOperatorActiveJobSnapshot {
  id: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  availableAt: string | null;
  startedAt: string | null;
}

export interface FinanceOperatorCaptureSnapshot {
  status: string | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
}

export interface FinanceOperatorEvaluationSnapshot {
  status: string | null;
  stage: string | null;
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  lastErrorCode: string | null;
  retryable: boolean;
}

/**
 * A bounded read. It claims no work, takes no lease, and mutates nothing.
 */
export interface FinanceOperatorHealthSnapshot {
  sync: FinanceOperatorSyncSnapshot | null;
  attribution: FinanceOperatorAttributionSnapshot | null;
  activeJob: FinanceOperatorActiveJobSnapshot | null;
  capture: FinanceOperatorCaptureSnapshot | null;
  evaluation: FinanceOperatorEvaluationSnapshot | null;
}

// ─── Cutover readiness ──────────────────────────────────────────────────────

export interface FinanceOperatorConnectorState {
  id: string;
  type: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

export interface FinanceOperatorPublicationState {
  sourceGeneration: string;
  sourceSequence: number;
  sourceAsOf: string;
  completedAt: string | null;
}

export interface FinanceOperatorCutoverState {
  sourceGeneration: string;
  sourceSequence: number;
  deliveryEnabled: boolean;
  legacyDisabled: boolean;
  rolledBackAt: string | null;
}

export interface FinanceOperatorReadinessInputs {
  connector: FinanceOperatorConnectorState;
  enabledFinanceConnectorCount: number;
  publication: FinanceOperatorPublicationState | null;
  cutover: FinanceOperatorCutoverState | null;
}

/**
 * The already-delivered occurrence summaries for one publication generation,
 * newest revision per occurrence, used to build the cutover's notification
 * lifecycle inputs. Payloads stay opaque here; the caller parses them with the
 * existing insight contract schema.
 */
export interface FinanceOperatorCutoverGeneration {
  sourceSequence: number;
  summaryPayloads: readonly string[];
}

// ─── Cutover enable / rollback ──────────────────────────────────────────────

export interface FinanceOperatorCutoverAudit {
  /**
   * Operator identity. `null` for a direct cutover with no operator audit row;
   * an audit row (and therefore an idempotency replay/conflict check) is only
   * recorded when `idempotencyKey` is present.
   */
  actorType: FinanceOperatorActorType | null;
  idempotencyKey: string | null;
  sourceGeneration: string;
}

export interface FinanceOperatorCutoverEnableCommand extends FinanceOperatorCutoverAudit {
  connectorId: string;
  sourceSequence: number;
  now: string;
  /**
   * Non-empty when the caller's readiness evaluation already failed. The
   * adapter then records only the blocked audit row (still under the
   * idempotency key) and reports `outcome: 'blocked'`.
   */
  blockers: readonly string[];
  reconcile: readonly FinanceInsightNotificationReconcileItem[];
  ingest: readonly FinanceInsightNotificationIngestItem[];
}

export interface FinanceOperatorCutoverEnableSuccess {
  outcome: 'enabled';
  legacyExpiredCount: number;
  importedCount: number;
  suppressedDeliveryCount: number;
  replayed: boolean;
  /** Wake the notification dispatcher only when true, and only after commit. */
  hasPendingDelivery: boolean;
}

export interface FinanceOperatorCutoverBlocked {
  outcome: 'blocked';
  blockers: readonly string[];
}

export type FinanceOperatorCutoverEnableOutcome =
  | FinanceOperatorCutoverEnableSuccess
  | FinanceOperatorCutoverBlocked;

export interface FinanceOperatorCutoverRollbackCommand extends FinanceOperatorCutoverAudit {
  connectorId: string;
  now: string;
}

export interface FinanceOperatorCutoverRollbackResult {
  outcome: 'rolled-back';
  legacyExpiredCount: number;
  importedCount: number;
  suppressedDeliveryCount: number;
  replayed: boolean;
}

/**
 * Stable operator-domain error. Adapters raise it for idempotency conflicts and
 * for the cutover states the API already reports as `404`/`409`; the route's
 * existing code/status mapping is unchanged.
 */
export class FinanceOperatorPersistenceError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
    this.name = 'FinanceOperatorPersistenceError';
  }
}

export interface FinanceOperatorPersistence {
  /**
   * Global legacy-production gate. Once any connector has completed cutover,
   * enabling or adding another connector must not resurrect legacy anomalies.
   */
  isLegacyAnomalyProductionEnabled(): Promise<boolean>;
  /** Bounded health/operator read for the existing redacted health response. */
  readHealthSnapshot(connectorId: string): Promise<FinanceOperatorHealthSnapshot>;
  /**
   * Reads the cutover readiness inputs. Raises
   * `finance_connector_not_found` (404) when the connector is absent or
   * soft-deleted.
   */
  readCutoverReadiness(connectorId: string): Promise<FinanceOperatorReadinessInputs>;
  /**
   * Reads the delivered occurrence payloads for one candidate generation.
   * Resolves `null` when the generation has no completed delivery, which the
   * caller maps to `finance_insight_cutover_generation_unavailable`.
   */
  readCutoverGeneration(input: {
    connectorId: string;
    sourceGeneration: string;
  }): Promise<FinanceOperatorCutoverGeneration | null>;
  /**
   * One transaction: idempotency replay/conflict check, generation fence,
   * cutover audit, legacy anomaly expiry, insight notification lifecycle plus
   * creation, and the cutover state switch.
   */
  enableCutover(
    command: FinanceOperatorCutoverEnableCommand,
  ): Promise<FinanceOperatorCutoverEnableOutcome>;
  /**
   * One transaction: idempotency replay/conflict check, expected-generation
   * fence, rollback audit, cutover disable, and pending-delivery suppression.
   */
  rollbackCutover(
    command: FinanceOperatorCutoverRollbackCommand,
  ): Promise<FinanceOperatorCutoverRollbackResult>;
}
