import { createHash } from 'node:crypto';
import {
  materializeNotificationActions,
  registerDefaultNotificationProviders,
  resolveNotificationProvider,
} from '@/lib/notifications/providers';
import type { InboundNotification, NotificationLevel } from '@/types';
import type { CreateNotificationInput } from '@/lib/notifications/service';
import type { FinanceActorType } from '@/lib/connectors/monarch-money/finance-request';
import {
  evaluateFinanceAttentionEnvelope,
  type FinanceAttentionEnvelope,
} from '@/lib/finance/attention-policy';
import {
  attributionAttentionAccountRef,
  currencyMinorUnitFactor,
  resolveAttributionAttentionThresholds,
  type AttributionAttentionPolicy,
} from '@/lib/finance/attribution-attention-policy';
import {
  TYRION_FINANCE_TASK_SOURCE_LABEL,
  TYRION_FINANCE_TASK_SOURCE_LIST_ID,
} from '@/lib/tasks/source-hierarchy';

/**
 * Backend-neutral persistence contract for finance attention routing
 * (attribution-review / write-back-failed signal reconciliation into
 * notifications, My Day-eligible tasks, and their settlement) and for the
 * idempotent finance attention projection repair operation. Both SQLite and
 * PostgreSQL adapters own their own transactions and table access; this
 * module holds only the driver-free decision logic and data shapes shared by
 * both backends so routing/repair semantics cannot drift between them.
 */

export const FINANCE_ATTENTION_CONTRACT_VERSION = '1.0';

export const FINANCE_ATTENTION_WRITE_BACK_EXHAUSTED_ATTEMPTS = 3;
export const FINANCE_ATTENTION_SOURCE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1_000;
export const FINANCE_ATTENTION_SOURCE_BATCH_SIZE = 500;
export const FINANCE_TASK_PROMOTION_DAILY_CAP = 25;
export const FINANCE_MY_DAY_DAILY_CAP = 8;
export const FINANCE_MY_DAY_DUE_SOON_DAYS = 2;
export const FINANCE_ATTENTION_TASK_CONNECTOR_TYPE = 'mission-control';
export const FINANCE_ATTENTION_TASK_CONNECTOR_INSTANCE_ID = 'mission-control';
export const FINANCE_ATTENTION_TASK_SOURCE_LIST_ID = TYRION_FINANCE_TASK_SOURCE_LIST_ID;
export const FINANCE_ATTENTION_TASK_SOURCE_LABEL = TYRION_FINANCE_TASK_SOURCE_LABEL;

const HUMAN_REVIEWABLE_ATTRIBUTION_REASONS = new Set([
  'attribution_ambiguous',
  'historical-attribution-tie',
  'low-confidence',
  'manual_decision_conflict',
  'merchant-rule-conflict',
  'review-required',
]);

export const FINANCE_ATTENTION_REPAIR_REASON = 'attribution_not_configured';
export const FINANCE_ATTENTION_REPAIR_CONFIRMATION =
  'repair-attribution-not-configured-projections';
export const FINANCE_ATTENTION_REPAIR_WINDOW_START = '2026-08-11T00:00:00.000Z';
export const FINANCE_ATTENTION_REPAIR_CUTOVER = '2026-08-13T00:00:00.000Z';
export const FINANCE_ATTENTION_MAX_REPAIR_SCOPE = 10_000;

export type FinanceAttentionSignalKind =
  | 'attributionReviewRequired'
  | 'attributionAccountReview'
  | 'duplicateTransactionCandidate'
  | 'connectorDegraded'
  | 'writeBackFailed'
  | 'receiptReconciliationUnmatched'
  | 'receiptReconciliationReview'
  | 'receiptReconciliationDurable';
export type FinanceAttentionRoute =
  | 'informationalNotification'
  | 'actionableNotification'
  | 'task'
  | 'statusOnly'
  | 'settled'
  | 'stale';

export interface FinanceAttentionSignal {
  connectorId: string;
  signalKind: FinanceAttentionSignalKind;
  sourceRef: string;
  sourceLifecycle: 'open' | 'resolved' | 'superseded';
  conditionSince: string;
  sourceAsOf: string;
  activityKey: string;
  actionable: boolean;
  attention?: 'informational' | 'actionable';
  freshness?: 'fresh' | 'stale' | 'unavailable';
  details?: Readonly<Record<string, unknown>>;
  settlementReason: string | null;
  accountSummary?: FinanceAttentionAccountSummary;
}

export interface FinanceAttentionDelivery {
  deliveryKey: string;
  version: number;
  action: 'create' | 'update' | 'settle';
  signal: FinanceAttentionSignal;
}

export interface FinanceAttentionAccountSummary {
  accountRef: string;
  accountDisplayName: string;
  pendingCount: number;
  highestAmountMinor: number;
  highestMerchantName: string | null;
  currency: string;
  pendingCountThreshold: number;
  highAmountThresholdMinor: number;
  countQualified: boolean;
  highAmountQualified: boolean;
}

export interface FinanceAttentionAccountSummaryRow {
  accountId: string;
  accountDisplayName: string;
  pendingCount: number;
  highestAmount: number;
  highestMerchantName: string | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

export interface FinanceAttentionRoutingResult {
  evaluated: number;
  notificationsCreated: number;
  notificationsUpdated: number;
  tasksCreated: number;
  tasksUpdated: number;
  tasksSettled: number;
  taskPromoted: number;
  autoIncluded: number;
  deferred: number;
  settled: number;
  stalePreserved: number;
  statusOnly: number;
  deliveriesReceived: number;
  deliveriesApplied: number;
  deliveriesReplayed: number;
  deliveriesOutOfOrder: number;
}

export interface FinanceAttentionRoutingOutcome {
  summary: FinanceAttentionRoutingResult;
  hasPendingDelivery: boolean;
}

export function financeAttentionDeliveryDigest(
  delivery: FinanceAttentionDelivery,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      deliveryKey: delivery.deliveryKey,
      version: delivery.version,
      action: delivery.action,
      signal: delivery.signal,
    }))
    .digest('hex');
}

export function financeAttentionSettlementTaskStatus(
  signal: Pick<FinanceAttentionSignal, 'sourceLifecycle' | 'settlementReason'>,
): 'done' | 'cancelled' {
  if (signal.sourceLifecycle === 'superseded') return 'cancelled';
  return signal.settlementReason === 'authoritative_state_verified'
    || signal.settlementReason === 'connector_recovered'
    ? 'done'
    : 'cancelled';
}

export interface FinanceAttentionAttributionExceptionRow {
  id: string;
  status: 'open' | 'retry_requested' | 'resolved' | 'dismissed';
  reviewState: 'pending' | 'resolved';
  reasonCode: string;
  retryable: number;
  sourceFingerprint: string;
  policyVersion: number | null;
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface FinanceAttentionWriteBackRow {
  id: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface FinanceAttentionSourceCursor {
  updatedAt: string;
  id: string;
}

export interface FinanceAttentionTaskSnapshot {
  status: string;
  metadata: unknown;
}

export interface FinanceAttentionMyDayTaskCandidate {
  id: string;
  status: string;
  localDisposition: string;
  metadata: unknown;
  dueDate: string | null;
  priority: string;
  createdAt: string;
}

export function financeAttentionStableDigest(
  signal: Pick<FinanceAttentionSignal, 'connectorId' | 'signalKind' | 'sourceRef'>,
): string {
  return createHash('sha256')
    .update(`${signal.connectorId}\0${signal.signalKind}\0${signal.sourceRef}`)
    .digest('hex');
}

export function financeAttentionSourceId(
  signal: Pick<FinanceAttentionSignal, 'connectorId' | 'signalKind' | 'sourceRef'>,
): string {
  return `finance-attention:${financeAttentionStableDigest(signal)}`;
}

export function financeAttentionTaskId(
  signal: Pick<FinanceAttentionSignal, 'connectorId' | 'signalKind' | 'sourceRef'>,
): string {
  return `finance-task-${financeAttentionStableDigest(signal).slice(0, 32)}`;
}

export function financeAttentionNotificationId(
  signal: Pick<FinanceAttentionSignal, 'connectorId' | 'signalKind' | 'sourceRef'>,
): string {
  return `finance-notification-${financeAttentionStableDigest(signal).slice(0, 32)}`;
}

export function financeAttentionValidTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function selectFinanceAttentionRoute(
  signal: FinanceAttentionSignal,
  decisionAt: Date,
): FinanceAttentionRoute {
  if (signal.sourceLifecycle !== 'open') return 'settled';
  if (signal.signalKind === 'receiptReconciliationUnmatched') {
    return signal.attention === 'informational'
      ? 'informationalNotification'
      : 'statusOnly';
  }
  if (signal.signalKind === 'receiptReconciliationReview') {
    return signal.actionable ? 'actionableNotification' : 'statusOnly';
  }
  if (signal.signalKind === 'receiptReconciliationDurable') {
    return signal.actionable ? 'task' : 'statusOnly';
  }
  if (!signal.actionable && signal.attention !== 'informational') return 'statusOnly';
  if (signal.signalKind === 'attributionAccountReview') {
    return 'actionableNotification';
  }

  const sourceAsOf = financeAttentionValidTimestamp(signal.sourceAsOf);
  const conditionSince = financeAttentionValidTimestamp(signal.conditionSince);
  if (sourceAsOf === null || conditionSince === null) return 'stale';
  if (
    signal.signalKind === 'duplicateTransactionCandidate'
    || signal.signalKind === 'connectorDegraded'
  ) {
    if (
      sourceAsOf > decisionAt.getTime()
      || conditionSince > sourceAsOf
      || (signal.freshness && signal.freshness !== 'fresh')
    ) {
      return 'stale';
    }
    const maximumAge = signal.signalKind === 'duplicateTransactionCandidate'
      ? 24 * 60 * 60 * 1_000
      : 15 * 60 * 1_000;
    if (decisionAt.getTime() - sourceAsOf > maximumAge) return 'stale';
    if (signal.attention === 'informational') return 'informationalNotification';
    if (!signal.actionable) return 'statusOnly';
    const promotionAge = signal.signalKind === 'duplicateTransactionCandidate'
      ? 24 * 60 * 60 * 1_000
      : 4 * 60 * 60 * 1_000;
    return decisionAt.getTime() - conditionSince >= promotionAge
      ? 'task'
      : 'actionableNotification';
  }
  const envelope: FinanceAttentionEnvelope = {
    contractVersion: FINANCE_ATTENTION_CONTRACT_VERSION,
    signalFamily: signal.signalKind === 'writeBackFailed' ? 'writeBack' : 'attribution',
    signalKind: signal.signalKind,
    signalId: signal.sourceRef,
    occurrenceId: signal.sourceRef,
    attentionKey: signal.sourceRef,
    revision: 1,
    sourceLifecycle: signal.sourceLifecycle,
    severity: signal.signalKind === 'writeBackFailed' ? 'high' : 'medium',
    episodeSince: signal.conditionSince,
    conditionSince: signal.conditionSince,
    sourceAsOf: signal.sourceAsOf,
    evaluatedAt: signal.sourceAsOf,
    freshness: 'fresh',
    provenance: {
      owningSystem: 'mission-control',
      producerVersion: 'finance-attention-v1',
      sourceGeneration: signal.activityKey,
      connectorRef: signal.connectorId,
    },
    dueAt: null,
    capabilities: signal.signalKind === 'writeBackFailed'
      ? ['openFinanceReview', 'openFinanceTask']
      : ['openFinanceReview', 'createFinanceTask', 'openFinanceTask'],
    targets: [{
      type: 'internal',
      target: 'financeReview',
      opaqueRef: signal.sourceRef,
    }],
    settlementReason: signal.settlementReason,
  };
  const route = evaluateFinanceAttentionEnvelope({
    connectorId: signal.connectorId,
    envelope,
    decisionAt,
  }).route;
  return route === 'informationalNotification' || route === 'suppressed'
    ? 'statusOnly'
    : route;
}

export function isHumanReviewableAttributionReason(reasonCode: string): boolean {
  return HUMAN_REVIEWABLE_ATTRIBUTION_REASONS.has(reasonCode);
}

export function financeAttentionAttributionSignal(
  connectorId: string,
  row: FinanceAttentionAttributionExceptionRow,
): FinanceAttentionSignal {
  const open = (row.status === 'open' || row.status === 'retry_requested')
    && row.reviewState === 'pending';
  return {
    connectorId,
    signalKind: 'attributionReviewRequired',
    sourceRef: row.id,
    sourceLifecycle: open
      ? 'open'
      : row.status === 'dismissed'
        ? 'superseded'
        : 'resolved',
    conditionSince: row.firstObservedAt,
    sourceAsOf: row.lastObservedAt,
    activityKey: [
      'attribution-v1',
      row.id,
      row.reasonCode,
      row.sourceFingerprint,
      row.policyVersion ?? 'none',
    ].join(':'),
    actionable: open
      && row.retryable === 0
      && isHumanReviewableAttributionReason(row.reasonCode),
    settlementReason: open
      ? null
      : row.status === 'dismissed'
        ? 'source_superseded'
        : 'authoritative_state_verified',
  };
}

export function financeAttentionAccountSignal(
  connectorId: string,
  row: FinanceAttentionAccountSummaryRow,
  policy: AttributionAttentionPolicy,
  currency: string,
  decisionAt: Date,
): FinanceAttentionSignal {
  const accountRef = attributionAttentionAccountRef(connectorId, row.accountId);
  const thresholds = resolveAttributionAttentionThresholds(policy, accountRef);
  const highestAmountMinor = Math.round(
    Math.abs(row.highestAmount) * currencyMinorUnitFactor(currency),
  );
  const countQualified = thresholds.pendingCountThreshold > 0
    && row.pendingCount >= thresholds.pendingCountThreshold;
  const highAmountQualified = thresholds.highAmountThresholdMinor > 0
    && highestAmountMinor >= thresholds.highAmountThresholdMinor;
  const actionable = countQualified || highAmountQualified;
  const summary: FinanceAttentionAccountSummary = {
    accountRef,
    accountDisplayName: row.accountDisplayName,
    pendingCount: row.pendingCount,
    highestAmountMinor,
    highestMerchantName: row.highestMerchantName,
    currency,
    ...thresholds,
    countQualified,
    highAmountQualified,
  };
  const sourceAsOf = row.lastObservedAt ?? decisionAt.toISOString();
  return {
    connectorId,
    signalKind: 'attributionAccountReview',
    sourceRef: accountRef,
    sourceLifecycle: actionable ? 'open' : 'resolved',
    conditionSince: row.firstObservedAt ?? sourceAsOf,
    sourceAsOf,
    activityKey: [
      'attribution-account-v1',
      row.pendingCount,
      highestAmountMinor,
      countQualified ? 1 : 0,
      highAmountQualified ? 1 : 0,
    ].join(':'),
    actionable,
    settlementReason: actionable ? null : 'threshold_cleared',
    accountSummary: summary,
  };
}

export function financeAttentionWriteBackSignal(
  connectorId: string,
  row: FinanceAttentionWriteBackRow,
): FinanceAttentionSignal {
  return {
    connectorId,
    signalKind: 'writeBackFailed',
    sourceRef: row.id,
    sourceLifecycle: row.status === 'succeeded' ? 'resolved' : 'open',
    conditionSince: row.updatedAt,
    sourceAsOf: row.updatedAt,
    activityKey: `write-back-v1:${row.id}:${row.status}:${row.attemptCount}`,
    actionable: row.status === 'failed'
      && row.attemptCount >= FINANCE_ATTENTION_WRITE_BACK_EXHAUSTED_ATTEMPTS,
    settlementReason: row.status === 'succeeded'
      ? 'authoritative_state_verified'
      : null,
  };
}

export function financeAttentionRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function financeAttentionMetadata(
  signal: FinanceAttentionSignal,
  route: FinanceAttentionRoute,
  decisionAt: Date,
  existing: unknown = {},
): Record<string, unknown> {
  return {
    ...financeAttentionRecord(existing),
    financeAttention: {
      ...financeAttentionRecord(financeAttentionRecord(existing).financeAttention),
      contractVersion: FINANCE_ATTENTION_CONTRACT_VERSION,
      signalFamily: signal.signalKind === 'writeBackFailed'
        ? 'writeBack'
        : signal.signalKind.startsWith('receiptReconciliation')
          ? 'reconciliation'
        : signal.signalKind === 'duplicateTransactionCandidate'
          ? 'anomaly'
          : signal.signalKind === 'connectorDegraded'
            ? 'connectorHealth'
            : 'attribution',
      signalKind: signal.signalKind,
      connectorRef: signal.connectorId,
      sourceRef: signal.sourceRef,
      activityKey: signal.activityKey,
      sourceLifecycle: signal.sourceLifecycle,
      conditionSince: signal.conditionSince,
      sourceAsOf: signal.sourceAsOf,
      decisionAt: decisionAt.toISOString(),
      route,
      freshness: route === 'stale' ? 'stale' : 'fresh',
      settlementReason: signal.settlementReason,
      details: signal.details ?? {},
      ...(signal.accountSummary ? { accountSummary: signal.accountSummary } : {}),
    },
  };
}

export function financeAttentionAccountMateriallyWorsened(
  signal: FinanceAttentionSignal,
  existingMetadata: unknown,
): boolean {
  const summary = signal.accountSummary;
  if (!summary) return false;
  const existingAttention = financeAttentionRecord(
    financeAttentionRecord(existingMetadata).financeAttention,
  );
  const previous = financeAttentionRecord(existingAttention.accountSummary);
  if (existingAttention.sourceLifecycle !== 'open') return true;
  const previousCountQualified = previous.countQualified === true;
  const previousHighAmountQualified = previous.highAmountQualified === true;
  return (!previousCountQualified && summary.countQualified)
    || (!previousHighAmountQualified && summary.highAmountQualified)
    || summary.pendingCount > Number(previous.pendingCount ?? 0)
    || summary.highestAmountMinor > Number(previous.highestAmountMinor ?? 0);
}

/**
 * True when an existing (or absent) task must be (re)claimed against today's
 * daily promotion cap: a brand-new task, or a previously completed task whose
 * prior route/lifecycle means the current open signal is resurfacing it
 * rather than merely re-syncing routine metadata.
 */
export function financeAttentionRequiresTaskPromotion(
  task: FinanceAttentionTaskSnapshot | undefined,
  signal: FinanceAttentionSignal,
): boolean {
  if (!task) return true;
  if (task.status !== 'done' && task.status !== 'cancelled') return false;
  const previousAttention = financeAttentionRecord(
    financeAttentionRecord(task.metadata).financeAttention,
  );
  return previousAttention.route === 'settled'
    || previousAttention.route === 'statusOnly'
    || previousAttention.sourceLifecycle !== 'open'
    || signal.sourceLifecycle !== 'open';
}

/**
 * Deterministic ordering for a batch of signals awaiting routing: exhausted
 * write-backs first, then aging attribution promotions, then everything
 * else, tied by condition age and then source reference so replays are
 * stable.
 */
export function compareFinanceAttentionSignalsForRouting(
  left: FinanceAttentionSignal,
  right: FinanceAttentionSignal,
  decisionAt: Date,
): number {
  const leftRoute = selectFinanceAttentionRoute(left, decisionAt);
  const rightRoute = selectFinanceAttentionRoute(right, decisionAt);
  const leftRank = leftRoute === 'task'
    ? left.signalKind === 'writeBackFailed' ? 0 : 1
    : 2;
  const rightRank = rightRoute === 'task'
    ? right.signalKind === 'writeBackFailed' ? 0 : 1
    : 2;
  return leftRank - rightRank
    || left.conditionSince.localeCompare(right.conditionSince)
    || left.sourceRef.localeCompare(right.sourceRef);
}

function taskDueRank(dueDate: string | null, today: string): number | null {
  if (!dueDate) return null;
  const trimmedDueDate = dueDate.slice(0, 10);
  const dueSoon = new Date(`${today}T12:00:00`);
  dueSoon.setDate(dueSoon.getDate() + FINANCE_MY_DAY_DUE_SOON_DAYS);
  if (trimmedDueDate <= today) return 0;
  return trimmedDueDate <= dueSoon.toISOString().slice(0, 10) ? 1 : null;
}

/**
 * Pure My Day candidacy/ranking for a finance-attention task: excludes
 * completed/dismissed/manually-placed/excluded tasks, then ranks the
 * remainder by due-soon status, signal kind, and priority so both backends
 * select and order the same auto-included set for a given day.
 */
export function financeAttentionMyDayCandidateRank(
  task: FinanceAttentionMyDayTaskCandidate,
  today: string,
): { policyRank: number; conditionSince: string } | null {
  if (
    task.status === 'done'
    || task.status === 'cancelled'
    || task.localDisposition !== 'active'
  ) {
    return null;
  }
  const attention = financeAttentionRecord(
    financeAttentionRecord(task.metadata).financeAttention,
  );
  const signalKind = typeof attention.signalKind === 'string' ? attention.signalKind : '';
  const dueRank = taskDueRank(task.dueDate, today);
  const policyRank = dueRank
    ?? (
      signalKind === 'writeBackFailed'
      || signalKind === 'duplicateTransactionCandidate'
      || signalKind === 'connectorDegraded'
      || signalKind === 'receiptReconciliationDurable'
        ? 2
        : task.priority === 'critical' ? 3 : null
    );
  if (policyRank === null) return null;
  const conditionSince = typeof attention.conditionSince === 'string'
    ? attention.conditionSince
    : task.createdAt;
  return { policyRank, conditionSince };
}

export function compareFinanceAttentionMyDayCandidates(
  left: { task: { id: string }; policyRank: number; conditionSince: string },
  right: { task: { id: string }; policyRank: number; conditionSince: string },
): number {
  return left.policyRank - right.policyRank
    || left.conditionSince.localeCompare(right.conditionSince)
    || left.task.id.localeCompare(right.task.id);
}

/**
 * Builds the notification create-input for a fresh attribution-review
 * signal. Only `attributionReviewRequired` signals ever reach the
 * `actionableNotification` route, so this input is not parameterized by
 * signal kind beyond the source linkage.
 */
export function financeAttentionNotificationInput(
  signal: FinanceAttentionSignal,
  decisionAt: Date,
  existing?: {
    metadata: unknown;
    lastSourceActivityAt: string | null;
    lastSourceActivityKey: string | null;
  },
): CreateNotificationInput & Required<Pick<
  CreateNotificationInput,
  | 'id'
  | 'sourceId'
  | 'connectorType'
  | 'connectorInstanceId'
  | 'title'
  | 'level'
  | 'category'
  | 'readState'
  | 'sourceState'
  | 'sourceActivityAt'
  | 'sourceActivityKey'
  | 'reopenPolicy'
  | 'receivedAt'
  | 'sortAt'
  | 'isActionable'
  | 'occurrenceKey'
  | 'metadata'
>> & { level: NotificationLevel } {
  const sourceId = financeAttentionSourceId(signal);
  if (signal.signalKind === 'attributionAccountReview' && signal.accountSummary) {
    const summary = signal.accountSummary;
    const worsened = !existing
      || financeAttentionAccountMateriallyWorsened(signal, existing.metadata);
    const activityKey = worsened
      ? signal.activityKey
      : existing.lastSourceActivityKey ?? signal.activityKey;
    const sourceActivityAt = worsened
      ? signal.sourceAsOf
      : existing.lastSourceActivityAt ?? signal.sourceAsOf;
    const amount = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: summary.currency,
    }).format(summary.highestAmountMinor / currencyMinorUnitFactor(summary.currency));
    const highAmountCopy = summary.highAmountQualified
      ? ` Highest pending amount: ${amount}${summary.highestMerchantName
          ? ` at ${summary.highestMerchantName}`
          : ''}.`
      : '';
    const level: NotificationLevel = summary.highAmountQualified
      ? 'action_needed'
      : 'heads_up';
    return {
      id: financeAttentionNotificationId(signal),
      sourceId,
      connectorType: 'finance-manager',
      connectorInstanceId: signal.connectorId,
      title: `Review unattributed activity for ${summary.accountDisplayName}`,
      body: `${summary.pendingCount} transaction${
        summary.pendingCount === 1 ? '' : 's'
      } await attribution.${highAmountCopy}`,
      level,
      category: 'finance',
      templateKey: 'finance-attribution-review',
      readState: 'unread',
      sourceState: 'active',
      sourceActivityAt,
      sourceActivityKey: activityKey,
      reopenPolicy: 'handled_and_dismissed',
      receivedAt: signal.conditionSince,
      sortAt: sourceActivityAt,
      groupKey: `finance-attribution:${signal.connectorId}`,
      dedupeKey: sourceId,
      relatedEntityType: 'finance-attribution-account-review',
      relatedEntityId: summary.accountRef,
      navigationTarget: '/finance/review',
      isActionable: true,
      occurrenceKey: activityKey,
      metadata: {
        notificationType: 'financeAttributionReview',
        ...financeAttentionMetadata(signal, 'actionableNotification', decisionAt),
      },
    };
  }
  const presentation = signal.signalKind.startsWith('receiptReconciliation')
    ? {
        title: signal.signalKind === 'receiptReconciliationUnmatched'
          ? 'Receipt still needs a payment match'
          : 'Review a receipt reconciliation exception',
        body: signal.signalKind === 'receiptReconciliationUnmatched'
          ? 'OWL could not match this receipt after the grace period.'
          : 'OWL found ambiguous or conflicting payment evidence that needs a decision.',
        level: signal.signalKind === 'receiptReconciliationUnmatched'
          ? 'heads_up' as const
          : 'action_needed' as const,
        templateKey: 'finance-receipt-reconciliation',
        groupKey: `finance-receipt-reconciliation:${signal.connectorId}`,
        relatedEntityType: 'finance-receipt-reconciliation-review',
        navigationTarget: `/finance/review?filter=receipt-reconciliation&review=${encodeURIComponent(signal.sourceRef)}`,
        notificationType: 'financeReceiptReconciliation',
      }
    : signal.signalKind === 'duplicateTransactionCandidate'
    ? {
        title: 'Review a possible duplicate transaction',
        body: signal.attention === 'informational'
          ? 'Two nearby transactions may be related. Review them in Finance.'
          : 'Two transactions appear to be duplicates and need review.',
        level: signal.attention === 'informational' ? 'fyi' as const : 'action_needed' as const,
        templateKey: 'finance-duplicate-transaction',
        groupKey: `finance-duplicates:${signal.connectorId}`,
        relatedEntityType: 'finance-duplicate-candidate',
        navigationTarget: '/finance/review',
        notificationType: 'duplicateTransactionCandidate',
      }
    : signal.signalKind === 'connectorDegraded'
      ? {
          title: 'Monarch connection needs attention',
          body: 'Finance data may be stale. Review the Tyrion connector health and sync status.',
          level: signal.attention === 'informational' ? 'heads_up' as const : 'action_needed' as const,
          templateKey: 'finance-connector-health',
          groupKey: `finance-connector-health:${signal.connectorId}`,
          relatedEntityType: 'finance-connector-health',
          navigationTarget: '/settings/connectors',
          notificationType: 'connectorDegraded',
        }
      : {
          title: 'Review a finance attribution exception',
          body: 'An attribution decision needs review in Finance.',
          level: 'heads_up' as const,
          templateKey: 'finance-attribution-review',
          groupKey: `finance-attribution:${signal.connectorId}`,
          relatedEntityType: 'finance-attribution-exception',
          navigationTarget: '/finance/review',
          notificationType: 'financeAttributionReview',
        };
  return {
    id: financeAttentionNotificationId(signal),
    sourceId,
    connectorType: 'finance-manager',
    connectorInstanceId: signal.connectorId,
    title: presentation.title,
    body: presentation.body,
    level: presentation.level,
    category: 'finance',
    templateKey: presentation.templateKey,
    readState: 'unread',
    sourceState: 'active',
    sourceActivityAt: signal.sourceAsOf,
    sourceActivityKey: signal.activityKey,
    reopenPolicy: 'handled_and_dismissed',
    receivedAt: signal.conditionSince,
    sortAt: signal.sourceAsOf,
    groupKey: presentation.groupKey,
    dedupeKey: sourceId,
    relatedEntityType: presentation.relatedEntityType,
    relatedEntityId: signal.sourceRef,
    navigationTarget: presentation.navigationTarget,
    isActionable: signal.attention !== 'informational',
    occurrenceKey: signal.activityKey,
    metadata: {
      notificationType: presentation.notificationType,
      ...financeAttentionMetadata(
        signal,
        signal.attention === 'informational'
          ? 'informationalNotification'
          : 'actionableNotification',
        decisionAt,
      ),
    },
  };
}

export function financeAttentionTaskCopy(signal: FinanceAttentionSignal): {
  title: string;
  description: string;
  priority: 'medium' | 'high';
} {
  if (signal.signalKind === 'writeBackFailed') {
    return {
      title: 'Resolve a failed finance write-back',
      description: 'A confirmed Finance change could not be verified. Review it in Finance.',
      priority: 'high',
    };
  }
  if (signal.signalKind === 'duplicateTransactionCandidate') {
    return {
      title: 'Review a possible duplicate transaction',
      description: 'A high-confidence duplicate candidate remains unresolved. Review it in Finance.',
      priority: 'high',
    };
  }
  if (signal.signalKind === 'connectorDegraded') {
    return {
      title: 'Restore the Monarch connection',
      description: 'The Tyrion connector remains unavailable or stale. Restore and verify a healthy sync.',
      priority: 'high',
    };
  }
  if (signal.signalKind === 'receiptReconciliationDurable') {
    return {
      title: 'Resolve a durable receipt reconciliation exception',
      description: 'OWL reports durable work or an exhausted repair. Review the bounded evidence in Finance.',
      priority: 'high',
    };
  }
  return {
    title: 'Review a finance attribution exception',
    description: 'An unresolved attribution decision requires review in Finance.',
    priority: 'medium',
  };
}

export interface FinanceAttentionResolvedNotificationPresentation {
  title: string;
  body: string | null;
  presentation: Record<string, unknown>;
  isActionable: boolean;
  primaryActionId: string | null;
  actions: ReturnType<typeof materializeNotificationActions>;
}

/**
 * Resolves the same generic notification-provider presentation (title,
 * body, actions) used by every other connector, so a finance-manager
 * notification's actions/presentation never diverge from the shared
 * registry in `@/lib/notifications/providers`. Callers persist the result
 * with their own backend's notification/notification_actions writes.
 */
export function resolveFinanceAttentionNotificationPresentation(input: {
  notification: InboundNotification;
  existingPresentation: unknown;
}): FinanceAttentionResolvedNotificationPresentation {
  registerDefaultNotificationProviders();
  const resolved = resolveNotificationProvider(input.notification);
  if (!resolved) {
    return {
      title: input.notification.title,
      body: input.notification.body ?? null,
      presentation: financeAttentionRecord(input.existingPresentation),
      isActionable: input.notification.isActionable,
      primaryActionId: null,
      actions: [],
    };
  }
  const active = input.notification.sourceState === 'active';
  const drafts = active
    ? (resolved.presentation.actions ?? []).filter((action) => action.actionType !== 'create_task')
    : [];
  let actionIndex = 0;
  const actions = materializeNotificationActions(
    input.notification.id,
    drafts,
    () => `${input.notification.id}:finance-action:${actionIndex++}`,
  );
  return {
    title: resolved.presentation.title ?? input.notification.title,
    body: resolved.presentation.body ?? input.notification.body ?? null,
    presentation: {
      ...financeAttentionRecord(input.existingPresentation),
      ...(resolved.presentation.presentation ?? {}),
    },
    isActionable: active && (resolved.presentation.isActionable ?? actions.length > 0),
    primaryActionId: actions.find((action) => action.isPrimary)?.id ?? null,
    actions,
  };
}

export class FinanceAttentionRoutingError extends Error {
  constructor(readonly code = 'finance_attention_routing_failed') {
    super(`Finance attention routing failed (${code})`);
    this.name = 'FinanceAttentionRoutingError';
  }
}

/**
 * Adapter-owned finance attention routing: scans both signal sources in
 * bounded keyset batches, decides and applies every route (settle, stale,
 * status-only, notify, promote-to-task), rebuilds the finance slice of My
 * Day, and reports whether any created/updated notification left a pending
 * delivery for the caller to wake post-commit. The whole operation is one
 * atomic adapter transaction.
 */
export interface FinanceAttentionRoutingPersistence {
  reconcile(input: {
    connectorId: string;
    decisionAt: Date;
    currency?: string;
    sourceSignals?: readonly FinanceAttentionSignal[];
    deliveries?: readonly FinanceAttentionDelivery[];
  }): Promise<FinanceAttentionRoutingOutcome>;
}

export type FinanceAttentionRepairMode = 'dry-run' | 'apply';

export interface FinanceAttentionRepairConnector {
  enabled: boolean;
  type: string;
}

export interface FinanceAttentionRepairCounts {
  occurrences: number;
  notifications: number;
  connectorActions: number;
  pendingDeliveries: number;
  tasks: number;
  myDayItems: number;
}

export interface FinanceAttentionRepairResult {
  runId: string;
  mode: FinanceAttentionRepairMode;
  connectorId: string;
  connectorEnabled: boolean;
  reasonCode: typeof FINANCE_ATTENTION_REPAIR_REASON;
  targetDigest: string;
  counts: FinanceAttentionRepairCounts;
  dryRunId: string | null;
  applied: boolean;
  replayed: boolean;
  completedAt: string;
}

export class FinanceAttentionRepairError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'FinanceAttentionRepairError';
  }
}

export function financeAttentionRepairParseMetadata(value: string): Record<string, unknown> {
  try {
    return financeAttentionRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

export function financeAttentionRepairedMetadata(
  value: string,
  repairedAt: string,
  runId: string,
): string {
  const metadata = financeAttentionRepairParseMetadata(value);
  const attention = financeAttentionRecord(metadata.financeAttention);
  metadata.financeAttention = {
    ...attention,
    route: 'statusOnly',
    decisionAt: repairedAt,
    freshness: 'fresh',
    repair: {
      contractVersion: FINANCE_ATTENTION_CONTRACT_VERSION,
      reasonCode: FINANCE_ATTENTION_REPAIR_REASON,
      runId,
      repairedAt,
    },
  };
  return JSON.stringify(metadata);
}

/**
 * Adapter-owned idempotent projection repair for the `attribution_not_configured`
 * incident window: loads the bounded target set, computes its digest and
 * counts, replays a prior run for the same idempotency key, enforces the
 * dry-run/apply scope fence and the in-flight delivery fence, applies the
 * repair when requested, and records one audit row. The whole operation is
 * one atomic adapter transaction; validation (idempotency key shape,
 * confirmation phrase) that needs no data read happens before this call.
 */
export interface FinanceAttentionRepairPersistence {
  repair(input: {
    connectorId: string;
    mode: FinanceAttentionRepairMode;
    actorType: FinanceActorType;
    idempotencyKey: string;
    dryRunId: string | null;
    now: string;
    runId: string;
  }): Promise<FinanceAttentionRepairResult>;
}

export interface FinanceAttentionPersistence {
  readonly routing: FinanceAttentionRoutingPersistence;
  readonly repair: FinanceAttentionRepairPersistence;
}
