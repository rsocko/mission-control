import { createHash } from 'node:crypto';
import { z } from 'zod';

export const FINANCE_ATTENTION_CONTRACT_VERSION = '1.0' as const;

export const FINANCE_ATTENTION_SIGNAL_KINDS = [
  'kidLimitApproaching',
  'kidLimitExceeded',
  'attributionLikely',
  'attributionReviewRequired',
  'largeTransactionDetected',
  'recurringAmountIncreaseDetected',
  'varianceMoverVisible',
  'monthlyVarianceDigestReady',
  'duplicateTransactionCandidate',
  'writeBackRetrying',
  'writeBackFailed',
  'reconciliationInformational',
  'reconciliationActionRequired',
  'reconciliationMismatch',
  'connectorTransientFailure',
  'connectorDegraded',
  'connectorAuthenticationExpired',
  'weeklyFinanceSummaryReady',
] as const;

export type FinanceAttentionEnvelopeSignalKind =
  typeof FINANCE_ATTENTION_SIGNAL_KINDS[number];

export type FinanceAttentionPolicyRoute =
  | 'informationalNotification'
  | 'actionableNotification'
  | 'task'
  | 'statusOnly'
  | 'suppressed'
  | 'settled'
  | 'stale';

const CAPABILITIES = [
  'openFinanceOverview',
  'openFinanceInsight',
  'openFinanceInsightGroup',
  'markFinanceInsightExpected',
  'markFinanceInsightNotUseful',
  'suppressFinanceInsight30Days',
  'suppressFinanceInsight90Days',
  'suppressFinanceInsight180Days',
  'undoFinanceInsightSuppression',
  'openFinanceReview',
  'explainAttribution',
  'assignAttributionKid',
  'markAttributionParentExpense',
  'unassignAttribution',
  'resolveAttributionException',
  'deferAttributionException',
  'resolveNonAttributionFinanceException',
  'openFinanceReconciliation',
  'resolveFinanceReconciliation',
  'openFinanceSettings',
  'createFinanceTask',
  'openFinanceTask',
  'openMonarch',
  'openTyrionConfiguration',
  'openMonarchConnectorOperations',
  'openSourceDocument',
] as const;

export type FinanceAttentionCapability = typeof CAPABILITIES[number];

const provenanceSchema = z.object({
  owningSystem: z.string().trim().min(1).max(64),
  producerVersion: z.string().trim().min(1).max(128),
  sourceGeneration: z.string().trim().min(1).max(128),
  connectorRef: z.string().trim().min(1).max(256).nullable(),
}).strict();

const targetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('internal'),
    target: z.enum([
      'financeOverview',
      'financeInsight',
      'financeInsightGroup',
      'financeReview',
      'financeReconciliation',
      'financeSettings',
      'financeTask',
    ]),
    opaqueRef: z.string().trim().min(1).max(512).nullable(),
  }).strict(),
  z.object({
    type: z.literal('monarch'),
    target: z.enum(['root', 'transaction', 'transactions', 'recurring', 'report']),
    opaqueRef: z.string().trim().min(1).max(512).nullable(),
  }).strict(),
  z.object({
    type: z.literal('tyrionConfiguration'),
    target: z.enum(['configuration', 'connectorOperations']),
  }).strict(),
  z.object({
    type: z.literal('sourceDocument'),
    system: z.string().trim().min(1).max(64),
    opaqueRef: z.string().trim().min(1).max(512),
  }).strict(),
]);

const envelopeSchema = z.object({
  contractVersion: z.literal(FINANCE_ATTENTION_CONTRACT_VERSION),
  signalFamily: z.enum([
    'threshold',
    'attribution',
    'anomaly',
    'writeBack',
    'reconciliation',
    'connectorHealth',
    'summary',
  ]),
  signalKind: z.enum(FINANCE_ATTENTION_SIGNAL_KINDS),
  signalId: z.string().trim().min(1).max(512),
  occurrenceId: z.string().trim().min(1).max(512),
  attentionKey: z.string().trim().min(1).max(512),
  revision: z.number().int().positive(),
  sourceLifecycle: z.enum(['open', 'resolved', 'superseded']),
  severity: z.enum(['info', 'medium', 'high', 'critical']),
  episodeSince: z.string().datetime({ offset: true }),
  conditionSince: z.string().datetime({ offset: true }),
  sourceAsOf: z.string().datetime({ offset: true }),
  evaluatedAt: z.string().datetime({ offset: true }),
  freshness: z.enum(['fresh', 'stale', 'partial', 'unavailable']),
  provenance: provenanceSchema,
  dueAt: z.string().datetime({ offset: true }).nullable(),
  capabilities: z.array(z.enum(CAPABILITIES)).max(12),
  targets: z.array(targetSchema).max(12),
  settlementReason: z.string().trim().min(1).max(128).nullable(),
}).strict();

export type FinanceAttentionEnvelope = z.infer<typeof envelopeSchema>;
export type FinanceAttentionTarget = FinanceAttentionEnvelope['targets'][number];

const FAMILY_BY_KIND: Record<FinanceAttentionEnvelopeSignalKind, FinanceAttentionEnvelope['signalFamily']> = {
  kidLimitApproaching: 'threshold',
  kidLimitExceeded: 'threshold',
  attributionLikely: 'attribution',
  attributionReviewRequired: 'attribution',
  largeTransactionDetected: 'anomaly',
  recurringAmountIncreaseDetected: 'anomaly',
  varianceMoverVisible: 'anomaly',
  monthlyVarianceDigestReady: 'anomaly',
  duplicateTransactionCandidate: 'anomaly',
  writeBackRetrying: 'writeBack',
  writeBackFailed: 'writeBack',
  reconciliationInformational: 'reconciliation',
  reconciliationActionRequired: 'reconciliation',
  reconciliationMismatch: 'reconciliation',
  connectorTransientFailure: 'connectorHealth',
  connectorDegraded: 'connectorHealth',
  connectorAuthenticationExpired: 'connectorHealth',
  weeklyFinanceSummaryReady: 'summary',
};

const MAXIMUM_AGE_MS: Record<FinanceAttentionEnvelope['signalFamily'], number> = {
  threshold: 60 * 60 * 1_000,
  attribution: 24 * 60 * 60 * 1_000,
  anomaly: 48 * 60 * 60 * 1_000,
  writeBack: 60 * 60 * 1_000,
  reconciliation: 24 * 60 * 60 * 1_000,
  connectorHealth: 15 * 60 * 1_000,
  summary: 24 * 60 * 60 * 1_000,
};

const TASK_AFTER_24_HOURS = new Set<FinanceAttentionEnvelopeSignalKind>([
  'kidLimitExceeded',
  'attributionReviewRequired',
  'duplicateTransactionCandidate',
]);

const NEVER_DUE = new Set<FinanceAttentionEnvelopeSignalKind>([
  'kidLimitApproaching',
  'kidLimitExceeded',
  'attributionLikely',
  'attributionReviewRequired',
  'largeTransactionDetected',
  'recurringAmountIncreaseDetected',
  'varianceMoverVisible',
  'monthlyVarianceDigestReady',
  'duplicateTransactionCandidate',
  'writeBackRetrying',
  'writeBackFailed',
  'reconciliationInformational',
  'connectorTransientFailure',
  'connectorDegraded',
  'connectorAuthenticationExpired',
  'weeklyFinanceSummaryReady',
]);

const ALLOWED_CAPABILITIES: Record<FinanceAttentionEnvelopeSignalKind, ReadonlySet<FinanceAttentionCapability>> = {
  kidLimitApproaching: new Set(['openFinanceOverview', 'openTyrionConfiguration']),
  kidLimitExceeded: new Set(['openFinanceOverview', 'createFinanceTask', 'openFinanceTask', 'openTyrionConfiguration']),
  attributionLikely: new Set(['openFinanceOverview']),
  attributionReviewRequired: new Set([
    'openFinanceReview', 'explainAttribution', 'assignAttributionKid',
    'markAttributionParentExpense', 'unassignAttribution', 'resolveAttributionException',
    'deferAttributionException', 'createFinanceTask', 'openFinanceTask', 'openMonarch',
  ]),
  largeTransactionDetected: new Set([
    'openFinanceInsight', 'openMonarch', 'markFinanceInsightExpected',
    'markFinanceInsightNotUseful', 'suppressFinanceInsight30Days',
    'suppressFinanceInsight90Days', 'suppressFinanceInsight180Days',
    'undoFinanceInsightSuppression',
  ]),
  recurringAmountIncreaseDetected: new Set([
    'openFinanceInsight', 'openMonarch', 'openSourceDocument',
    'markFinanceInsightExpected', 'markFinanceInsightNotUseful',
    'suppressFinanceInsight30Days', 'suppressFinanceInsight90Days',
    'suppressFinanceInsight180Days', 'undoFinanceInsightSuppression',
  ]),
  varianceMoverVisible: new Set(['openFinanceInsightGroup', 'openMonarch']),
  monthlyVarianceDigestReady: new Set(['openFinanceInsightGroup', 'openMonarch']),
  duplicateTransactionCandidate: new Set([
    'openFinanceReview', 'resolveNonAttributionFinanceException', 'openMonarch',
    'createFinanceTask', 'openFinanceTask',
  ]),
  writeBackRetrying: new Set(['openFinanceReview']),
  writeBackFailed: new Set([
    'openFinanceReview', 'resolveNonAttributionFinanceException', 'openFinanceTask', 'openMonarch',
  ]),
  reconciliationInformational: new Set([
    'openFinanceReconciliation', 'openMonarch', 'openSourceDocument',
  ]),
  reconciliationActionRequired: new Set([
    'openFinanceReconciliation', 'resolveFinanceReconciliation', 'createFinanceTask',
    'openFinanceTask', 'openMonarch', 'openSourceDocument',
  ]),
  reconciliationMismatch: new Set([
    'openFinanceReconciliation', 'resolveFinanceReconciliation', 'openFinanceTask',
    'openMonarch', 'openSourceDocument',
  ]),
  connectorTransientFailure: new Set(),
  connectorDegraded: new Set([
    'openFinanceSettings', 'openMonarchConnectorOperations', 'createFinanceTask', 'openFinanceTask',
  ]),
  connectorAuthenticationExpired: new Set([
    'openFinanceSettings', 'openMonarchConnectorOperations', 'createFinanceTask', 'openFinanceTask',
  ]),
  weeklyFinanceSummaryReady: new Set(['openFinanceOverview']),
};

const ALLOWED_SEVERITIES: Record<
  FinanceAttentionEnvelopeSignalKind,
  ReadonlySet<FinanceAttentionEnvelope['severity']>
> = {
  kidLimitApproaching: new Set(['info']),
  kidLimitExceeded: new Set(['medium', 'high']),
  attributionLikely: new Set(['info']),
  attributionReviewRequired: new Set(['medium']),
  largeTransactionDetected: new Set(['info', 'medium', 'high', 'critical']),
  recurringAmountIncreaseDetected: new Set(['info', 'medium', 'high', 'critical']),
  varianceMoverVisible: new Set(['info', 'medium', 'high', 'critical']),
  monthlyVarianceDigestReady: new Set(['info', 'medium']),
  duplicateTransactionCandidate: new Set(['high']),
  writeBackRetrying: new Set(['medium']),
  writeBackFailed: new Set(['high']),
  reconciliationInformational: new Set(['info']),
  reconciliationActionRequired: new Set(['medium', 'high']),
  reconciliationMismatch: new Set(['critical']),
  connectorTransientFailure: new Set(['info']),
  connectorDegraded: new Set(['high']),
  connectorAuthenticationExpired: new Set(['critical']),
  weeklyFinanceSummaryReady: new Set(['info']),
};

export class FinanceAttentionEnvelopeError extends Error {
  constructor(readonly code: string) {
    super(`Invalid finance attention envelope (${code})`);
    this.name = 'FinanceAttentionEnvelopeError';
  }
}

function milliseconds(value: string): number {
  return new Date(value).getTime();
}

export function parseFinanceAttentionEnvelope(input: unknown): FinanceAttentionEnvelope {
  const result = envelopeSchema.safeParse(input);
  if (!result.success) throw new FinanceAttentionEnvelopeError('schema');
  const envelope = result.data;
  if (FAMILY_BY_KIND[envelope.signalKind] !== envelope.signalFamily) {
    throw new FinanceAttentionEnvelopeError('signal_family');
  }
  if (new Set(envelope.capabilities).size !== envelope.capabilities.length) {
    throw new FinanceAttentionEnvelopeError('duplicate_capability');
  }
  if (envelope.capabilities.some(
    capability => !ALLOWED_CAPABILITIES[envelope.signalKind].has(capability),
  )) {
    throw new FinanceAttentionEnvelopeError('unauthorized_capability');
  }
  if (!ALLOWED_SEVERITIES[envelope.signalKind].has(envelope.severity)) {
    throw new FinanceAttentionEnvelopeError('severity');
  }
  if (NEVER_DUE.has(envelope.signalKind) && envelope.dueAt !== null) {
    throw new FinanceAttentionEnvelopeError('unexpected_due_at');
  }
  if (
    envelope.signalKind === 'reconciliationActionRequired'
    && envelope.sourceLifecycle === 'open'
    && envelope.dueAt === null
  ) {
    throw new FinanceAttentionEnvelopeError('missing_due_at');
  }
  if (
    envelope.sourceLifecycle === 'open'
      ? envelope.settlementReason !== null
      : envelope.settlementReason === null
  ) {
    throw new FinanceAttentionEnvelopeError('settlement_reason');
  }
  return envelope;
}

export interface FinanceAttentionPolicyDecision {
  route: FinanceAttentionPolicyRoute;
  severity: FinanceAttentionEnvelope['severity'];
  myDayEligible: boolean;
  logicalKey: string;
  activityKey: string;
  transitionKey: string | null;
  authorizedCapabilities: FinanceAttentionCapability[];
  accepted: boolean;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function validateTimestampOrder(
  envelope: FinanceAttentionEnvelope,
  decisionAtMs: number,
): void {
  if (
    milliseconds(envelope.episodeSince) > milliseconds(envelope.conditionSince)
    || milliseconds(envelope.conditionSince) > milliseconds(envelope.evaluatedAt)
    || milliseconds(envelope.sourceAsOf) > milliseconds(envelope.evaluatedAt)
    || milliseconds(envelope.evaluatedAt) > decisionAtMs
  ) {
    throw new FinanceAttentionEnvelopeError('timestamp_order');
  }
}

function isStale(envelope: FinanceAttentionEnvelope, decisionAtMs: number): boolean {
  return envelope.freshness !== 'fresh'
    || decisionAtMs - milliseconds(envelope.sourceAsOf) > (
      envelope.signalKind === 'duplicateTransactionCandidate'
        ? 24 * 60 * 60 * 1_000
        : MAXIMUM_AGE_MS[envelope.signalFamily]
    );
}

function baseRoute(envelope: FinanceAttentionEnvelope, decisionAtMs: number): FinanceAttentionPolicyRoute {
  const conditionAge = decisionAtMs - milliseconds(envelope.conditionSince);
  const episodeAge = decisionAtMs - milliseconds(envelope.episodeSince);
  switch (envelope.signalKind) {
    case 'kidLimitExceeded':
    case 'attributionReviewRequired':
    case 'duplicateTransactionCandidate':
      return conditionAge >= 24 * 60 * 60 * 1_000 ? 'task' : 'actionableNotification';
    case 'kidLimitApproaching':
    case 'largeTransactionDetected':
    case 'recurringAmountIncreaseDetected':
    case 'monthlyVarianceDigestReady':
    case 'weeklyFinanceSummaryReady':
      return 'informationalNotification';
    case 'attributionLikely':
    case 'varianceMoverVisible':
    case 'writeBackRetrying':
    case 'reconciliationInformational':
      return 'statusOnly';
    case 'writeBackFailed':
    case 'reconciliationMismatch':
      return 'task';
    case 'reconciliationActionRequired':
      return milliseconds(envelope.dueAt!) - decisionAtMs <= 72 * 60 * 60 * 1_000
        ? 'task'
        : 'actionableNotification';
    case 'connectorTransientFailure':
      return 'suppressed';
    case 'connectorDegraded':
      return episodeAge >= 4 * 60 * 60 * 1_000 ? 'task' : 'actionableNotification';
    case 'connectorAuthenticationExpired':
      return conditionAge >= 4 * 60 * 60 * 1_000 ? 'task' : 'actionableNotification';
    default: {
      const exhaustive: never = envelope.signalKind;
      throw new FinanceAttentionEnvelopeError(`unsupported_signal_kind:${exhaustive}`);
    }
  }
}

function hasTargetForCapability(
  capability: FinanceAttentionCapability,
  targets: FinanceAttentionTarget[],
): boolean {
  const internal = (
    target: Extract<FinanceAttentionTarget, { type: 'internal' }>['target'],
    requiresOpaqueRef = false,
  ) => targets.some(candidate => (
    candidate.type === 'internal'
    && candidate.target === target
    && (!requiresOpaqueRef || candidate.opaqueRef !== null)
  ));
  if (capability === 'openFinanceOverview') return internal('financeOverview');
  if (
    capability === 'openFinanceInsight'
    || capability === 'markFinanceInsightExpected'
    || capability === 'markFinanceInsightNotUseful'
    || capability === 'suppressFinanceInsight30Days'
    || capability === 'suppressFinanceInsight90Days'
    || capability === 'suppressFinanceInsight180Days'
    || capability === 'undoFinanceInsightSuppression'
  ) {
    return internal('financeInsight', true);
  }
  if (capability === 'openFinanceInsightGroup') {
    return internal('financeInsightGroup', true);
  }
  if (
    capability === 'openFinanceReview'
    || capability === 'explainAttribution'
    || capability === 'assignAttributionKid'
    || capability === 'markAttributionParentExpense'
    || capability === 'unassignAttribution'
    || capability === 'resolveAttributionException'
    || capability === 'deferAttributionException'
    || capability === 'resolveNonAttributionFinanceException'
  ) {
    return internal('financeReview', true);
  }
  if (
    capability === 'openFinanceReconciliation'
    || capability === 'resolveFinanceReconciliation'
  ) {
    return internal('financeReconciliation', true);
  }
  if (capability === 'openFinanceSettings') return internal('financeSettings');
  if (capability === 'createFinanceTask' || capability === 'openFinanceTask') {
    return internal('financeTask', true);
  }
  if (capability === 'openMonarch') return targets.some(target => target.type === 'monarch');
  if (capability === 'openSourceDocument') {
    return targets.some(target => target.type === 'sourceDocument');
  }
  if (capability === 'openTyrionConfiguration') {
    return targets.some(target => (
      target.type === 'tyrionConfiguration' && target.target === 'configuration'
    ));
  }
  if (capability === 'openMonarchConnectorOperations') {
    return targets.some(target => (
      target.type === 'tyrionConfiguration' && target.target === 'connectorOperations'
    ));
  }
  return false;
}

export function evaluateFinanceAttentionEnvelope(input: {
  connectorId: string;
  envelope: unknown;
  decisionAt: Date;
  current?: {
    envelope: unknown;
    hasOpenTask: boolean;
  };
}): FinanceAttentionPolicyDecision {
  if (!input.connectorId.trim()) throw new FinanceAttentionEnvelopeError('connector_id');
  const envelope = parseFinanceAttentionEnvelope(input.envelope);
  const decisionAtMs = input.decisionAt.getTime();
  if (!Number.isFinite(decisionAtMs)) throw new FinanceAttentionEnvelopeError('decision_at');
  const episodeSince = milliseconds(envelope.episodeSince);
  validateTimestampOrder(envelope, decisionAtMs);

  const logicalKey = digest([
    input.connectorId,
    envelope.signalFamily,
    envelope.attentionKey,
    envelope.occurrenceId,
  ]);
  const activityKey = digest([
    logicalKey,
    envelope.signalKind,
    String(envelope.revision),
  ]);
  if (envelope.sourceLifecycle !== 'open') {
    return {
      route: 'settled',
      severity: envelope.severity,
      myDayEligible: false,
      logicalKey,
      activityKey,
      transitionKey: null,
      authorizedCapabilities: [],
      accepted: true,
    };
  }

  let stale = isStale(envelope, decisionAtMs);
  let route = stale ? 'stale' : baseRoute(envelope, decisionAtMs);
  let accepted = true;
  if (
    envelope.signalKind === 'connectorTransientFailure'
    && decisionAtMs - episodeSince >= 15 * 60 * 1_000
  ) {
    accepted = false;
  }
  let effectiveEnvelope = envelope;
  if (input.current) {
    const current = parseFinanceAttentionEnvelope(input.current.envelope);
    validateTimestampOrder(current, decisionAtMs);
    const currentLogicalKey = digest([
      input.connectorId,
      current.signalFamily,
      current.attentionKey,
      current.occurrenceId,
    ]);
    if (currentLogicalKey !== logicalKey) {
      throw new FinanceAttentionEnvelopeError('current_logical_key');
    }
    if (
      current.sourceLifecycle === 'open'
      && compareFinanceAttentionTransitionPrecedence(current, envelope) > 0
    ) {
      stale = isStale(current, decisionAtMs);
      route = stale ? 'stale' : baseRoute(current, decisionAtMs);
      accepted = false;
      effectiveEnvelope = current;
    } else if (
      input.current.hasOpenTask
      && route !== 'settled'
      && route !== 'stale'
    ) {
      route = 'task';
    }
  }
  const dueAt = effectiveEnvelope.dueAt === null
    ? null
    : milliseconds(effectiveEnvelope.dueAt);
  const myDayEligible = route === 'task' && (
    effectiveEnvelope.signalKind === 'kidLimitExceeded'
    || effectiveEnvelope.signalKind === 'attributionReviewRequired'
    || effectiveEnvelope.signalKind === 'duplicateTransactionCandidate'
    || effectiveEnvelope.signalKind === 'writeBackFailed'
    || effectiveEnvelope.signalKind === 'reconciliationMismatch'
    || effectiveEnvelope.signalKind === 'connectorDegraded'
    || effectiveEnvelope.signalKind === 'connectorAuthenticationExpired'
    || (
      effectiveEnvelope.signalKind === 'reconciliationActionRequired'
      && dueAt !== null
      && dueAt <= decisionAtMs
    )
  );
  const transitionBoundaryAt = route === 'task'
    ? effectiveEnvelope.signalKind === 'reconciliationActionRequired' && dueAt !== null
      ? dueAt - 72 * 60 * 60 * 1_000
      : effectiveEnvelope.signalKind === 'connectorDegraded'
      || effectiveEnvelope.signalKind === 'connectorAuthenticationExpired'
      ? milliseconds(
          effectiveEnvelope.signalKind === 'connectorDegraded'
            ? effectiveEnvelope.episodeSince
            : effectiveEnvelope.conditionSince,
        ) + 4 * 60 * 60 * 1_000
      : TASK_AFTER_24_HOURS.has(effectiveEnvelope.signalKind)
        ? milliseconds(effectiveEnvelope.conditionSince) + 24 * 60 * 60 * 1_000
        : null
    : null;
  const transitionKey = transitionBoundaryAt === null
    ? null
    : digest([
        logicalKey,
        route,
        new Date(transitionBoundaryAt).toISOString(),
      ]);
  return {
    route,
    severity: effectiveEnvelope.signalKind === 'reconciliationActionRequired'
      && dueAt !== null
      && dueAt - decisionAtMs <= 72 * 60 * 60 * 1_000
      ? 'high'
      : effectiveEnvelope.severity,
    myDayEligible,
    logicalKey,
    activityKey,
    transitionKey,
    authorizedCapabilities: stale
      ? []
      : effectiveEnvelope.capabilities.filter(capability => (
          hasTargetForCapability(capability, effectiveEnvelope.targets)
        )),
    accepted,
  };
}

const TRANSITION_PRECEDENCE: Partial<Record<
  FinanceAttentionEnvelopeSignalKind,
  number
>> = {
  kidLimitApproaching: 1,
  kidLimitExceeded: 2,
  writeBackRetrying: 1,
  writeBackFailed: 2,
  connectorTransientFailure: 1,
  connectorDegraded: 2,
  connectorAuthenticationExpired: 3,
  reconciliationInformational: 1,
  reconciliationActionRequired: 2,
  reconciliationMismatch: 3,
};

export function compareFinanceAttentionTransitionPrecedence(
  left: FinanceAttentionEnvelope,
  right: FinanceAttentionEnvelope,
): number {
  if (
    left.attentionKey !== right.attentionKey
    || left.occurrenceId !== right.occurrenceId
    || left.signalFamily !== right.signalFamily
  ) {
    throw new FinanceAttentionEnvelopeError('transition_group');
  }
  const leftRank = TRANSITION_PRECEDENCE[left.signalKind] ?? 0;
  const rightRank = TRANSITION_PRECEDENCE[right.signalKind] ?? 0;
  if (
    left.signalKind === 'kidLimitExceeded'
    && right.signalKind === 'kidLimitExceeded'
    && left.severity !== right.severity
  ) {
    return left.severity === 'high' ? 1 : -1;
  }
  return leftRank - rightRank || left.revision - right.revision;
}
