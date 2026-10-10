import { z } from 'zod';
import {
  sourceGenerationCreateRequestSchema,
  transactionSourceFactSchema,
} from './contract';

const utcTimestamp = z.string().datetime({ offset: true });
const sourceReference = z.string().trim().min(1).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const signalId = z.string().regex(/^signal-v1_[A-Za-z0-9_-]{43}$/);
const deliveryKey = z.string().regex(/^finance-automation:signal-v1_[A-Za-z0-9_-]{43}$/);
const automationPolicySchema = z.strictObject({
  contractVersion: z.literal('1.0'),
  policyVersion: z.number().int().positive(),
  detectorSetVersion: z.literal('automation-detectors-v1'),
  duplicateTransactions: z.strictObject({
    enabled: z.boolean(),
    matchWindowDays: z.number().int().min(0).max(7),
    maxCandidates: z.number().int().positive().max(100),
    freshnessMaxAgeHours: z.number().int().positive().max(168),
  }),
  connectorHealth: z.strictObject({
    enabled: z.boolean(),
    staleAfterHours: z.number().int().positive().max(168),
    actionableAfterConsecutiveFailures: z.number().int().positive().max(100),
  }),
});
const insightPolicyTransportSchema = z.strictObject({
  contractVersion: z.literal('1.0'),
  policyModelVersion: z.literal('finance-policy-v1'),
  detectorSetVersion: z.literal('detectors-v1'),
  policyVersion: z.number().int().positive(),
  effectiveAt: utcTimestamp,
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  timezone: z.string().min(1).max(100),
  featureGates: z.record(z.string(), z.boolean()),
  sourceClassification: z.record(z.string(), z.unknown()),
  recurringAmount: z.record(z.string(), z.unknown()),
  largeTransaction: z.record(z.string(), z.unknown()),
  variance: z.record(z.string(), z.unknown()),
  freshness: z.record(z.string(), z.unknown()),
  delivery: z.record(z.string(), z.unknown()),
  suppression: z.record(z.string(), z.unknown()),
  materialChange: z.record(z.string(), z.unknown()),
});
const duplicateJobRequestSchema = z.strictObject({
  contractVersion: z.literal('1.0'),
  jobKind: z.literal('duplicateTransactions'),
  connectorRef: sourceReference,
  scheduledFor: utcTimestamp,
  evaluatedAt: utcTimestamp,
  sourceCompleteness: z.enum(['complete', 'partial', 'unavailable']),
  source: sourceGenerationCreateRequestSchema,
  transactions: z.array(transactionSourceFactSchema).max(50_000),
  suppressedPairs: z.array(z.strictObject({
    sourceRefs: z.tuple([sourceReference, sourceReference]),
    reason: z.enum(['expectedDuplicate', 'connectorRetry']),
  })).max(500),
  insightPolicy: insightPolicyTransportSchema,
  automationPolicy: automationPolicySchema,
}).superRefine((value, context) => {
  if (value.connectorRef !== value.source.connectorRef) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'connectorRef mismatch' });
  }
  if (Date.parse(value.scheduledFor) > Date.parse(value.evaluatedAt)) {
    context.addIssue({ code: 'custom', path: ['scheduledFor'], message: 'after evaluatedAt' });
  }
  if (value.insightPolicy.policyVersion !== value.automationPolicy.policyVersion) {
    context.addIssue({ code: 'custom', path: ['automationPolicy'], message: 'policy mismatch' });
  }
  const manifest = value.source.manifest.find((item) => item.kind === 'transaction');
  if (
    value.sourceCompleteness === 'complete'
    && manifest?.itemCount !== value.transactions.length
  ) {
    context.addIssue({ code: 'custom', path: ['transactions'], message: 'incomplete facts' });
  }
});
const healthJobRequestSchema = z.strictObject({
  contractVersion: z.literal('1.0'),
  jobKind: z.literal('connectorHealth'),
  connectorRef: sourceReference,
  scheduledFor: utcTimestamp,
  evaluatedAt: utcTimestamp,
  observation: z.strictObject({
    observedAt: utcTimestamp,
    state: z.enum(['connected', 'degraded', 'unavailable']),
    lastSuccessfulSyncAt: utcTimestamp.nullable(),
    consecutiveFailures: z.number().int().nonnegative().max(10_000),
    bridgeContractVersion: z.string().min(1).max(80),
  }),
  automationPolicy: automationPolicySchema,
}).superRefine((value, context) => {
  if (
    Date.parse(value.scheduledFor) > Date.parse(value.evaluatedAt)
    || Date.parse(value.observation.observedAt) > Date.parse(value.evaluatedAt)
  ) {
    context.addIssue({ code: 'custom', path: ['scheduledFor'], message: 'invalid ordering' });
  }
  if (
    value.observation.state === 'connected'
    && (
      value.observation.lastSuccessfulSyncAt === null
      || value.observation.consecutiveFailures !== 0
    )
  ) {
    context.addIssue({ code: 'custom', path: ['observation'], message: 'invalid healthy state' });
  }
});
export const financeAutomationJobRequestTransportSchema = z.discriminatedUnion(
  'jobKind',
  [duplicateJobRequestSchema, healthJobRequestSchema],
);
export const financeAutomationDeliveryAckRequestSchema = z.strictObject({
  contractVersion: z.literal('1.0'),
  acknowledgedAt: utcTimestamp,
  deliveries: z.array(z.strictObject({
    deliveryKey,
    expectedVersion: z.number().int().positive(),
  })).min(1).max(100).refine(
    (items) => new Set(items.map((item) => item.deliveryKey)).size === items.length,
    'must contain unique delivery keys',
  ),
});

const provenanceSchema = z.strictObject({
  connectorRef: sourceReference,
  providerClass: z.literal('monarchBridgeNormalized'),
  bridgeContractVersion: z.string().min(1).max(80),
  sourceGeneration: sourceReference.nullable(),
  sourceAsOf: utcTimestamp.nullable(),
  observedAt: utcTimestamp,
  evaluatedAt: utcTimestamp,
  detectorSetVersion: z.literal('automation-detectors-v1'),
  detectorVersion: z.enum([
    'duplicate-transaction-detector-v1',
    'connector-health-detector-v1',
  ]),
  policyVersion: z.number().int().positive(),
});

const evidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('duplicateTransaction'),
    sameAmount: z.literal(true),
    sameMerchant: z.literal(true),
    sameAccount: z.literal(true),
    dateGapDays: z.number().int().min(0).max(7),
    observedDates: z.tuple([z.string().date(), z.string().date()]),
  }),
  z.strictObject({
    kind: z.literal('connectorHealth'),
    reportedState: z.enum(['connected', 'degraded', 'unavailable']),
    consecutiveFailures: z.number().int().nonnegative().max(10_000),
    sourceAgeHours: z.number().int().nonnegative().nullable(),
  }),
]);

export const financeAutomationSignalSchema = z.strictObject({
  contractVersion: z.literal('1.0'),
  signalId,
  kind: z.enum(['duplicateTransaction', 'connectorHealth']),
  connectorRef: sourceReference,
  state: z.enum(['open', 'settled']),
  severity: z.enum(['medium', 'high']),
  confidence: z.enum(['medium', 'high']),
  attention: z.enum(['informational', 'actionable']),
  reasonCodes: z.array(z.enum([
    'duplicate_exact_match',
    'duplicate_adjacent_date_match',
    'connector_reported_degraded',
    'connector_reported_unavailable',
    'connector_sync_stale',
    'connector_repeated_failures',
    'condition_recovered',
  ])).max(7),
  relatedSourceRefs: z.array(sourceReference).max(2),
  evidence: evidenceSchema,
  freshness: z.enum(['fresh', 'stale', 'unavailable']),
  provenance: provenanceSchema,
  openedAt: utcTimestamp,
  updatedAt: utcTimestamp,
  settledAt: utcTimestamp.nullable(),
});

export const financeAutomationJobResultSchema = z.strictObject({
  contractVersion: z.literal('1.0'),
  runId: z.string().regex(/^run-v1_[A-Za-z0-9_-]{43}$/),
  jobKind: z.enum(['duplicateTransactions', 'connectorHealth']),
  connectorRef: sourceReference,
  scheduledFor: utcTimestamp,
  status: z.enum(['completed', 'skipped', 'ignored']),
  skipReason: z.enum([
    'disabled',
    'source_stale',
    'source_partial',
    'source_unavailable',
    'out_of_order_observation',
    'out_of_order_source_generation',
  ]).nullable(),
  sourceAsOf: utcTimestamp.nullable(),
  candidateCount: z.number().int().nonnegative().max(100),
  exclusionSummary: z.record(z.string().min(1).max(80), z.number().int().nonnegative()),
  signals: z.array(financeAutomationSignalSchema).max(200),
  deliveries: z.array(z.strictObject({
    deliveryKey,
    version: z.number().int().positive(),
    signalId,
    target: z.literal('notification'),
    action: z.enum(['create', 'update', 'settle']),
    signal: financeAutomationSignalSchema,
  })).max(100),
  replayed: z.boolean(),
  completedAt: utcTimestamp,
}).superRefine((value, context) => {
  const deliveryKeys = value.deliveries.map((delivery) => delivery.deliveryKey);
  const signalIds = value.signals.map((signal) => signal.signalId);
  if (new Set(deliveryKeys).size !== deliveryKeys.length) {
    context.addIssue({ code: 'custom', path: ['deliveries'], message: 'duplicate keys' });
  }
  if (new Set(signalIds).size !== signalIds.length) {
    context.addIssue({ code: 'custom', path: ['signals'], message: 'duplicate signal ids' });
  }
  const expectedSignalKind = value.jobKind === 'duplicateTransactions'
    ? 'duplicateTransaction'
    : 'connectorHealth';
  for (const [index, signal] of value.signals.entries()) {
    if (signal.connectorRef !== value.connectorRef || signal.kind !== expectedSignalKind) {
      context.addIssue({ code: 'custom', path: ['signals', index], message: 'scope mismatch' });
    }
  }
  for (const [index, delivery] of value.deliveries.entries()) {
    if (
      delivery.signalId !== delivery.signal.signalId
      || delivery.deliveryKey !== `finance-automation:${delivery.signalId}`
      || delivery.signal.connectorRef !== value.connectorRef
      || delivery.signal.kind !== expectedSignalKind
    ) {
      context.addIssue({ code: 'custom', path: ['deliveries', index], message: 'snapshot mismatch' });
    }
  }
});

export const financeAutomationDeliveryAckResultSchema = z.strictObject({
  contractVersion: z.literal('1.0'),
  acknowledged: z.array(deliveryKey).max(100),
  conflicts: z.array(deliveryKey).max(100),
}).superRefine((value, context) => {
  const acknowledged = new Set(value.acknowledged);
  const conflicts = new Set(value.conflicts);
  if (
    acknowledged.size !== value.acknowledged.length
    || conflicts.size !== value.conflicts.length
    || value.acknowledged.some((key) => conflicts.has(key))
  ) {
    context.addIssue({ code: 'custom', message: 'acknowledgement sets must be unique and disjoint' });
  }
});

export type FinanceAutomationSignal = z.infer<typeof financeAutomationSignalSchema>;
export type FinanceAutomationJobResult = z.infer<typeof financeAutomationJobResultSchema>;
export type FinanceAutomationDeliveryAckResult = z.infer<
  typeof financeAutomationDeliveryAckResultSchema
>;
