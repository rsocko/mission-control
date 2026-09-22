import { createHash } from 'node:crypto';
import {
  materializeNotificationActions,
  registerDefaultNotificationProviders,
  resolveNotificationProvider,
} from '@/lib/notifications/providers';
import type { InboundNotification, NotificationLevel } from '@/types';
import type { CreateNotificationInput } from '@/lib/notifications/service';
import type { FinanceActorType } from '@/lib/connectors/monarch-money/finance-request';

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

const ATTRIBUTION_ESCALATION_MS = 24 * 60 * 60 * 1_000;
const ATTRIBUTION_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
const WRITE_BACK_FRESHNESS_MS = 60 * 60 * 1_000;
export const FINANCE_ATTENTION_WRITE_BACK_EXHAUSTED_ATTEMPTS = 3;
export const FINANCE_ATTENTION_SOURCE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1_000;
export const FINANCE_ATTENTION_SOURCE_BATCH_SIZE = 500;
export const FINANCE_TASK_PROMOTION_DAILY_CAP = 25;
export const FINANCE_MY_DAY_DAILY_CAP = 8;
export const FINANCE_MY_DAY_DUE_SOON_DAYS = 2;
export const FINANCE_ATTENTION_TASK_CONNECTOR_TYPE = 'mission-control';
export const FINANCE_ATTENTION_TASK_CONNECTOR_INSTANCE_ID = 'mission-control';

const HUMAN_REVIEWABLE_ATTRIBUTION_REASONS = new Set([
  'attribution_ambiguous',
  'account-rule-conflict',
  'historical-attribution-tie',
  'low-confidence',
  'manual_decision_conflict',
  'merchant-rule-conflict',
  'no-match',
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
  | 'writeBackFailed';
export type FinanceAttentionRoute =
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
  settlementReason: string | null;
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
}

export interface FinanceAttentionRoutingOutcome {
  summary: FinanceAttentionRoutingResult;
  hasPendingDelivery: boolean;
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
  if (!signal.actionable) return 'statusOnly';

  const sourceAsOf = financeAttentionValidTimestamp(signal.sourceAsOf);
  const conditionSince = financeAttentionValidTimestamp(signal.conditionSince);
  if (
    sourceAsOf === null
    || conditionSince === null
    || sourceAsOf > decisionAt.getTime()
    || conditionSince > sourceAsOf
  ) {
    return 'stale';
  }
  const maximumAge = signal.signalKind === 'attributionReviewRequired'
    ? ATTRIBUTION_FRESHNESS_MS
    : WRITE_BACK_FRESHNESS_MS;
  if (decisionAt.getTime() - sourceAsOf > maximumAge) return 'stale';
  if (signal.signalKind === 'writeBackFailed') return 'task';
  return decisionAt.getTime() - conditionSince >= ATTRIBUTION_ESCALATION_MS
    ? 'task'
    : 'actionableNotification';
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
      signalFamily: signal.signalKind === 'writeBackFailed' ? 'writeBack' : 'attribution',
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
    },
  };
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
    ?? (signalKind === 'writeBackFailed' ? 2 : task.priority === 'critical' ? 3 : null);
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
  return {
    id: financeAttentionNotificationId(signal),
    sourceId,
    connectorType: 'finance-manager',
    connectorInstanceId: signal.connectorId,
    title: 'Review a finance attribution exception',
    body: 'An attribution decision needs review in Finance.',
    level: 'heads_up',
    category: 'finance',
    templateKey: 'finance-attribution-review',
    readState: 'unread',
    sourceState: 'active',
    sourceActivityAt: signal.sourceAsOf,
    sourceActivityKey: signal.activityKey,
    reopenPolicy: 'handled_and_dismissed',
    receivedAt: signal.conditionSince,
    sortAt: signal.sourceAsOf,
    groupKey: `finance-attribution:${signal.connectorId}`,
    dedupeKey: sourceId,
    relatedEntityType: 'finance-attribution-exception',
    relatedEntityId: signal.sourceRef,
    navigationTarget: '/finance/review',
    isActionable: true,
    occurrenceKey: signal.activityKey,
    metadata: {
      notificationType: 'financeAttributionReview',
      ...financeAttentionMetadata(signal, 'actionableNotification', decisionAt),
    },
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
