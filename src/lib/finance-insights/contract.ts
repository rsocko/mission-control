import 'server-only';

import { z } from 'zod';

export const FINANCE_INSIGHTS_CONTRACT_VERSION = '1.0' as const;
export const FINANCE_INSIGHT_FACT_KINDS = [
  'transaction',
  'recurring',
  'category',
  'account',
  'tag',
] as const;
export const FINANCE_INSIGHT_BATCH_SIZE = 250;
export const FINANCE_INSIGHT_MAX_REQUEST_BYTES = 256 * 1024;
export const FINANCE_INSIGHT_OCCURRENCE_SNAPSHOT_PAGE_LIMIT = 10;
export const FINANCE_INSIGHT_ITEM_LIMITS = {
  transaction: 50_000,
  recurring: 5_000,
  category: 2_000,
  account: 1_000,
  tag: 1_000,
} as const;

const reservedIdentifiers = new Set(['__proto__', 'constructor', 'prototype']);
const supportedCurrencies = new Set(Intl.supportedValuesOf('currency'));
const utcTimestampPattern =
  /^(?:\d{4})-(?:\d{2})-(?:\d{2})T(?:\d{2}):(?:\d{2}):(?:\d{2})(?:\.\d{1,3})?Z$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const noControlCharacters = /^[^\u0000-\u001f\u007f-\u009f]+$/;

function validCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validUtcTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    && utcTimestampPattern.test(value)
    && parsed.toISOString() === (
      value.includes('.')
        ? value.replace(/\.(\d{1,3})Z$/, (_match, fraction: string) => `.${fraction.padEnd(3, '0')}Z`)
        : value.replace(/Z$/, '.000Z')
    );
}

export const sourceReferenceSchema = z.string()
  .trim()
  .min(1)
  .max(160)
  .regex(identifierPattern)
  .refine((value) => !reservedIdentifiers.has(value));
export const idempotencyKeySchema = sourceReferenceSchema.min(16);
export const canonicalDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const calendarDateSchema = z.string()
  .length(10)
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(validCalendarDate);
export const utcTimestampSchema = z.string()
  .min(20)
  .max(30)
  .regex(utcTimestampPattern)
  .refine(validUtcTimestamp);
export const currencySchema = z.string()
  .length(3)
  .regex(/^[A-Z]{3}$/)
  .refine((value) => supportedCurrencies.has(value));
export const insightIdSchema = z.string().regex(/^insight-v1_[A-Za-z0-9_-]{43}$/);
export const occurrenceIdSchema = z.string().regex(/^occurrence-v1_[A-Za-z0-9_-]{43}$/);
const positiveSequenceSchema = z.number().int().safe().positive();
export const normalizedDisplayNameSchema = z.string()
  .trim()
  .min(1)
  .max(120)
  .regex(noControlCharacters);
export const normalizedMerchantNameSchema = z.string()
  .trim()
  .min(1)
  .max(160)
  .regex(noControlCharacters);
export const sourceFactKindSchema = z.enum(FINANCE_INSIGHT_FACT_KINDS);

const amountMinorSchema = z.number().int().safe().min(-9_000_000_000_000).max(9_000_000_000_000);
const nullableSourceRefSchema = sourceReferenceSchema.nullable();

export const transactionSourceFactSchema = z.strictObject({
  sourceRef: sourceReferenceSchema,
  occurredOn: calendarDateSchema,
  amountMinor: amountMinorSchema,
  merchantName: normalizedMerchantNameSchema,
  categoryRef: nullableSourceRefSchema,
  accountRef: nullableSourceRefSchema,
  isPending: z.boolean(),
  recurringRef: nullableSourceRefSchema,
  tagRefs: z.array(sourceReferenceSchema).max(50)
    .refine((values) => new Set(values).size === values.length),
});
export const recurringSourceFactSchema = z.strictObject({
  sourceRef: sourceReferenceSchema,
  displayName: normalizedDisplayNameSchema,
  amountMinor: amountMinorSchema.nullable(),
  cadence: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual', 'unknown']),
  nextDate: calendarDateSchema.nullable(),
  categoryRef: nullableSourceRefSchema,
  accountRef: nullableSourceRefSchema,
  active: z.boolean(),
});
export const categorySourceFactSchema = z.strictObject({
  sourceRef: sourceReferenceSchema,
  displayName: normalizedDisplayNameSchema,
  groupRef: nullableSourceRefSchema,
  active: z.boolean(),
});
export const accountSourceFactSchema = z.strictObject({
  sourceRef: sourceReferenceSchema,
  accountType: z.enum(['checking', 'savings', 'credit', 'cash', 'loan', 'investment', 'other']),
  active: z.boolean(),
});
export const tagSourceFactSchema = z.strictObject({
  sourceRef: sourceReferenceSchema,
  displayName: normalizedDisplayNameSchema,
  active: z.boolean(),
});

const factSchemas = {
  transaction: transactionSourceFactSchema,
  recurring: recurringSourceFactSchema,
  category: categorySourceFactSchema,
  account: accountSourceFactSchema,
  tag: tagSourceFactSchema,
} as const;

function batchSchema<K extends keyof typeof factSchemas>(kind: K) {
  return z.strictObject({
    contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
    sourceGeneration: sourceReferenceSchema,
    kind: z.literal(kind),
    batchIndex: z.number().int().safe().nonnegative(),
    facts: z.array(factSchemas[kind]).min(1).max(FINANCE_INSIGHT_BATCH_SIZE),
    digest: canonicalDigestSchema,
    idempotencyKey: idempotencyKeySchema,
  }).superRefine((value, context) => {
    const refs = value.facts.map((fact) => fact.sourceRef);
    if (new Set(refs).size !== refs.length) {
      context.addIssue({ code: 'custom', path: ['facts'], message: 'sourceRef values must be unique' });
    }
  });
}

export const sourceFactBatchSchema = z.discriminatedUnion('kind', [
  batchSchema('transaction'),
  batchSchema('recurring'),
  batchSchema('category'),
  batchSchema('account'),
  batchSchema('tag'),
]);

export const publicationConstituentSchema = z.strictObject({
  kind: sourceFactKindSchema,
  generationRef: sourceReferenceSchema,
  sourceAsOf: utcTimestampSchema,
  itemCount: z.number().int().safe().nonnegative(),
  digest: canonicalDigestSchema,
});
export const sourceManifestEntrySchema = z.strictObject({
  kind: sourceFactKindSchema,
  batchCount: z.number().int().safe().nonnegative(),
  itemCount: z.number().int().safe().nonnegative(),
  digest: canonicalDigestSchema,
});

function containsEveryFactKind(values: readonly string[]): boolean {
  return new Set(values).size === FINANCE_INSIGHT_FACT_KINDS.length
    && FINANCE_INSIGHT_FACT_KINDS.every((kind) => values.includes(kind));
}

export const sourceGenerationCreateRequestSchema = z.strictObject({
  contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
  connectorRef: sourceReferenceSchema,
  sourceGeneration: sourceReferenceSchema,
  sourceSequence: z.number().int().safe().positive(),
  sourceAsOf: utcTimestampSchema,
  coverageStart: calendarDateSchema,
  coverageEnd: calendarDateSchema,
  currency: currencySchema,
  bridgeContractVersion: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  capturedConstituents: z.array(publicationConstituentSchema).length(5),
  manifest: z.array(sourceManifestEntrySchema).length(5),
  idempotencyKey: idempotencyKeySchema,
}).superRefine((value, context) => {
  if (value.coverageEnd < value.coverageStart) {
    context.addIssue({ code: 'custom', path: ['coverageEnd'], message: 'must follow coverageStart' });
  }
  if (!containsEveryFactKind(value.capturedConstituents.map((item) => item.kind))) {
    context.addIssue({ code: 'custom', path: ['capturedConstituents'], message: 'must contain every fact kind' });
  }
  if (!containsEveryFactKind(value.manifest.map((item) => item.kind))) {
    context.addIssue({ code: 'custom', path: ['manifest'], message: 'must contain every fact kind' });
  }
  const earliest = [...value.capturedConstituents]
    .sort((left, right) => Date.parse(left.sourceAsOf) - Date.parse(right.sourceAsOf))[0]?.sourceAsOf;
  if (!earliest || Date.parse(earliest) !== Date.parse(value.sourceAsOf)) {
    context.addIssue({ code: 'custom', path: ['sourceAsOf'], message: 'must equal earliest constituent sourceAsOf' });
  }
  const counts = new Map(value.capturedConstituents.map((item) => [item.kind, item.itemCount]));
  value.manifest.forEach((entry, index) => {
    if (counts.get(entry.kind) !== entry.itemCount) {
      context.addIssue({ code: 'custom', path: ['manifest', index, 'itemCount'], message: 'must match constituent' });
    }
    if (entry.itemCount > FINANCE_INSIGHT_ITEM_LIMITS[entry.kind]) {
      context.addIssue({ code: 'custom', path: ['manifest', index, 'itemCount'], message: 'exceeds generation limit' });
    }
    if (
      (entry.itemCount === 0 && entry.batchCount !== 0)
      || (entry.itemCount > 0 && entry.batchCount < 1)
      || entry.batchCount > entry.itemCount
      || entry.batchCount < Math.ceil(entry.itemCount / FINANCE_INSIGHT_BATCH_SIZE)
    ) {
      context.addIssue({ code: 'custom', path: ['manifest', index, 'batchCount'], message: 'is inconsistent with itemCount' });
    }
  });
});

export const sourceGenerationCommitRequestSchema = z.strictObject({
  contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
  sourceGeneration: sourceReferenceSchema,
  expectedSourceSequence: z.number().int().safe().positive(),
  manifestDigest: canonicalDigestSchema,
  idempotencyKey: idempotencyKeySchema,
});
export const evaluationRequestSchema = z.strictObject({
  contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
  connectorRef: sourceReferenceSchema,
  sourceGeneration: sourceReferenceSchema,
  detectorSetVersion: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  expectedPolicyVersion: z.number().int().safe().positive(),
  idempotencyKey: idempotencyKeySchema,
});
const evaluationIdentitySchema = z.strictObject({
  householdScope: sourceReferenceSchema,
  connectorRef: sourceReferenceSchema,
  sourceGeneration: sourceReferenceSchema,
  detectorSetVersion: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  policyVersion: z.number().int().safe().positive(),
});
const evaluationResultIdentityShape = {
  contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
  identity: evaluationIdentitySchema,
  sourceSequence: z.number().int().safe().positive(),
  evaluationSequence: z.number().int().safe().positive(),
  acceptedAt: utcTimestampSchema,
} as const;
export const evaluationResultSchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...evaluationResultIdentityShape,
    state: z.enum(['queued', 'evaluating']),
    completedAt: z.null(),
  }),
  z.strictObject({
    ...evaluationResultIdentityShape,
    state: z.enum(['completed', 'unavailable', 'failed']),
    completedAt: utcTimestampSchema,
  }).superRefine((value, context) => {
    if (Date.parse(value.completedAt) < Date.parse(value.acceptedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'must be on or after acceptedAt',
      });
    }
  }),
]);
export const sourceGenerationResultSchema = z.discriminatedUnion('state', [
  z.strictObject({
    contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
    connectorRef: sourceReferenceSchema,
    sourceGeneration: sourceReferenceSchema,
    sourceSequence: z.number().int().safe().positive(),
    state: z.literal('staging'),
    detectorSetVersion: z.null(),
    policyVersion: z.null(),
  }),
  z.strictObject({
    contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
    connectorRef: sourceReferenceSchema,
    sourceGeneration: sourceReferenceSchema,
    sourceSequence: z.number().int().safe().positive(),
    state: z.enum(['promoted', 'historical']),
    detectorSetVersion: z.string().trim().min(1).max(80),
    policyVersion: z.number().int().safe().positive(),
  }),
]);
export const sourceBatchReceiptSchema = z.strictObject({
  contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
  sourceGeneration: sourceReferenceSchema,
  kind: sourceFactKindSchema,
  batchIndex: z.number().int().safe().nonnegative(),
  digest: canonicalDigestSchema,
  state: z.literal('accepted'),
});

export const externalTargetSchema = z.union([
  z.strictObject({
    system: z.literal('monarch'),
    targetKind: z.literal('transaction'),
    sourceRef: sourceReferenceSchema,
  }),
  z.strictObject({
    system: z.literal('monarch'),
    targetKind: z.literal('recurring'),
    sourceRef: sourceReferenceSchema,
  }),
  z.strictObject({
    system: z.literal('monarch'),
    targetKind: z.literal('reportFilter'),
    reportKind: z.literal('spending'),
    period: z.strictObject({
      start: calendarDateSchema,
      end: calendarDateSchema,
    }).refine((value) => value.end >= value.start, {
      path: ['end'],
      message: 'must be on or after period start',
    }),
    categorySourceRef: nullableSourceRefSchema,
    merchantKey: z.string().regex(/^merchant-v1_[A-Za-z0-9_-]{43}$/).nullable(),
  }).refine(
    (value) => value.categorySourceRef === null || value.merchantKey === null,
    'report filter may select a category or merchant, not both',
  ),
  z.strictObject({
    system: z.literal('monarch'),
    targetKind: z.literal('safeRoot'),
    root: z.enum(['transactions', 'recurring', 'reports']),
  }),
  z.strictObject({
    system: z.literal('owl'),
    targetKind: z.literal('document'),
    sourceRef: sourceReferenceSchema,
  }),
]);

export const insightReasonCodeSchema = z.enum([
  'explicit_amount_rule_exceeded',
  'recurring_absolute_gate_exceeded',
  'recurring_relative_gate_exceeded',
  'recurring_decrease_analysis_only',
  'adaptive_baseline_agreement',
  'adaptive_baseline_insufficient',
  'variance_absolute_gate_exceeded',
  'variance_relative_gate_exceeded',
  'robust_deviation_exceeded',
  'new_spend_zero_baseline',
  'seasonal_baseline_insufficient',
  'source_stale',
  'source_partial',
  'source_unavailable',
  'normalized_name_identity',
  'zero_mad_minimum_spread',
  'period_normalized',
  'optional_evidence_unavailable',
  'classification_ambiguous',
  'pending_excluded',
  'transfer_excluded',
  'income_excluded',
  'refund_excluded',
  'unclassified_credit_excluded',
  'known_recurring_excluded',
  'policy_excluded',
  'correction_resolved',
  'correction_superseded',
  'material_source_change',
  'medium_confidence_no_notify',
]);

const insightPeriodSchema = z.strictObject({
  start: calendarDateSchema,
  end: calendarDateSchema,
}).refine((value) => value.end >= value.start, {
  path: ['end'],
  message: 'must be on or after period start',
});
const insightMoneyValueSchema = z.strictObject({
  currency: currencySchema,
  amountMinor: amountMinorSchema,
});
const insightExpectedRangeSchema = z.strictObject({
  currency: currencySchema,
  lowerMinor: amountMinorSchema,
  upperMinor: amountMinorSchema,
}).refine((value) => value.upperMinor >= value.lowerMinor, {
  path: ['upperMinor'],
  message: 'must be greater than or equal to lowerMinor',
});
const insightEntitySchema = z.union([
  z.strictObject({
    kind: z.enum(['recurring', 'transaction', 'category']),
    sourceRef: sourceReferenceSchema,
    displayName: normalizedDisplayNameSchema,
    identityQuality: z.literal('stableSource'),
  }),
  z.strictObject({
    kind: z.literal('merchant'),
    sourceRef: z.string().regex(/^merchant-v1_[A-Za-z0-9_-]{43}$/),
    displayName: normalizedDisplayNameSchema,
    identityQuality: z.enum(['configuredAlias', 'normalizedName']),
  }),
]);
const insightFreshnessSchema = z.strictObject({
  state: z.enum(['fresh', 'stale', 'partial', 'unavailable']),
  sourceAsOf: utcTimestampSchema.nullable(),
  maxAgeHours: z.literal(48),
  warningReason: insightReasonCodeSchema.nullable(),
}).superRefine((value, context) => {
  const expectedWarning = {
    stale: 'source_stale',
    partial: 'source_partial',
    unavailable: 'source_unavailable',
  } as const;
  if (value.state === 'fresh') {
    if (value.sourceAsOf === null) {
      context.addIssue({ code: 'custom', path: ['sourceAsOf'], message: 'is required for fresh source data' });
    }
    if (value.warningReason !== null) {
      context.addIssue({ code: 'custom', path: ['warningReason'], message: 'must be null for fresh source data' });
    }
  } else if (value.warningReason !== expectedWarning[value.state]) {
    context.addIssue({
      code: 'custom',
      path: ['warningReason'],
      message: `must be ${expectedWarning[value.state]} for ${value.state} data`,
    });
  }
});
const insightProvenanceSchema = z.strictObject({
  connectorRef: sourceReferenceSchema,
  sourceGeneration: sourceReferenceSchema,
  bridgeContractVersion: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  providerClass: z.literal('monarchBridgeNormalized'),
  sourceAsOf: utcTimestampSchema,
  coverageStart: calendarDateSchema,
  coverageEnd: calendarDateSchema,
  completeness: z.enum(['complete', 'partial', 'unavailable']),
  detectorSetVersion: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  detectorVersion: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  methodVersion: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  explanationTemplateVersion: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  policyVersion: z.number().int().safe().positive(),
  evaluationStartedAt: utcTimestampSchema,
  evaluationCompletedAt: utcTimestampSchema,
}).superRefine((value, context) => {
  if (value.coverageEnd < value.coverageStart) {
    context.addIssue({ code: 'custom', path: ['coverageEnd'], message: 'must be on or after coverageStart' });
  }
  if (Date.parse(value.evaluationCompletedAt) < Date.parse(value.evaluationStartedAt)) {
    context.addIssue({ code: 'custom', path: ['evaluationCompletedAt'], message: 'must be on or after evaluationStartedAt' });
  }
});

const insightOccurrenceSummaryObjectSchema = z.strictObject({
  contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
  insightId: insightIdSchema,
  occurrenceId: occurrenceIdSchema,
  deliveryRevision: z.number().int().safe().positive(),
  kind: z.enum(['recurringAmountChange', 'largeTransaction', 'categoryVariance', 'merchantVariance']),
  entity: insightEntitySchema,
  analysisState: z.enum(['analyzing', 'qualified', 'insufficientBaseline', 'unavailable']),
  sourceLifecycle: z.enum(['open', 'resolved', 'superseded']).nullable(),
  resolutionReason: insightReasonCodeSchema.nullable(),
  supersededByOccurrenceId: occurrenceIdSchema.nullable(),
  severity: z.enum(['info', 'medium', 'high']),
  confidence: z.enum(['low', 'medium', 'high']),
  baselineSufficiency: z.enum(['insufficient', 'limited', 'sufficient']),
  reasonCodes: z.array(insightReasonCodeSchema).max(12)
    .refine((values) => new Set(values).size === values.length),
  headline: z.string().trim().min(1).max(160),
  explanation: z.string().trim().min(1).max(500).regex(noControlCharacters),
  observationPeriod: insightPeriodSchema,
  baselinePeriod: insightPeriodSchema.nullable(),
  observedValue: insightMoneyValueSchema.nullable(),
  expectedRange: insightExpectedRangeSchema.nullable(),
  absoluteDelta: insightMoneyValueSchema.nullable(),
  percentageDeltaBasisPoints: z.number().int().safe().min(-1_000_000).max(1_000_000).nullable(),
  currency: currencySchema,
  freshness: insightFreshnessSchema,
  provenance: insightProvenanceSchema,
  targets: z.array(externalTargetSchema).max(4)
    .refine((values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
  resolvedAt: utcTimestampSchema.nullable(),
});

const insightOccurrenceSummaryBaseSchema = insightOccurrenceSummaryObjectSchema
  .superRefine((value, context) => {
    const isQualified = value.analysisState === 'qualified';
    if (isQualified !== (value.sourceLifecycle !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['sourceLifecycle'],
        message: 'must be present exactly when analysisState is qualified',
      });
    }
  });

const detailRuleResultSchema = z.strictObject({
      ruleCode: z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/),
      outcome: z.enum(['triggered', 'reinforced', 'informational', 'notEligible']),
      observedMinor: amountMinorSchema.nullable(),
      thresholdMinor: amountMinorSchema.nullable(),
      observedBasisPoints: z.number().int().safe().min(-1_000_000).max(1_000_000).nullable(),
      thresholdBasisPoints: z.number().int().safe().min(-1_000_000).max(1_000_000).nullable(),
      reasonCodes: z.array(insightReasonCodeSchema).max(6)
        .refine((values) => new Set(values).size === values.length),
});
const nonNegativeIntegerSchema = z.number().int().safe().nonnegative();
const nonNegativeAmountMinorSchema = amountMinorSchema.nonnegative();
const detailBaselineSchema = z.strictObject({
      method: z.enum(['seasonalMedianMad', 'rollingMedianMad', 'equivalentPeriodMedianMad']),
      windowStart: calendarDateSchema,
      windowEnd: calendarDateSchema,
      sampleCount: nonNegativeIntegerSchema,
      activePeriodCount: nonNegativeIntegerSchema,
      robustCenterMinor: amountMinorSchema.nullable(),
      dispersionMinor: nonNegativeAmountMinorSchema.nullable(),
      expectedRange: insightExpectedRangeSchema.nullable(),
      exclusionCounts: z.strictObject({
        pending: nonNegativeIntegerSchema,
        transfer: nonNegativeIntegerSchema,
        income: nonNegativeIntegerSchema,
        refund: nonNegativeIntegerSchema,
        unclassifiedCredit: nonNegativeIntegerSchema,
        knownRecurring: nonNegativeIntegerSchema,
        policyExcluded: nonNegativeIntegerSchema,
      }),
});
const detailComparisonSchema = z.strictObject({
      period: insightPeriodSchema,
      value: insightMoneyValueSchema.nullable(),
      eligible: z.boolean(),
      contribution: z.enum(['triggered', 'reinforced', 'informational', 'notEligible']),
      sampleCount: nonNegativeIntegerSchema,
      medianMinor: amountMinorSchema.nullable(),
      dispersionMinor: nonNegativeAmountMinorSchema.nullable(),
      empiricalPercentileBasisPoints: z.number().int().min(0).max(10_000).nullable(),
      ratioBasisPoints: z.number().int().safe().min(-1_000_000).max(1_000_000).nullable(),
});
const detailContributorSchema = z.strictObject({
      rank: z.number().int().positive().max(10),
      sourceRef: sourceReferenceSchema,
      occurredOn: calendarDateSchema,
      displayName: normalizedDisplayNameSchema,
      amount: insightMoneyValueSchema,
      contributionMinor: amountMinorSchema,
});
const detailEvidenceSchema = z.strictObject({
      source: z.enum(['monarchBridge', 'owl']),
      evidenceType: z.enum([
        'transaction',
        'recurringItem',
        'categoryProjection',
        'billingPeriod',
        'billAmount',
        'usage',
      ]),
      observedAt: utcTimestampSchema,
      documentRef: sourceReferenceSchema.nullable(),
      normalizedValueMinor: amountMinorSchema.nullable(),
      normalizedUnit: z.enum(['currencyMinor', 'days', 'usageUnit']).nullable(),
});
const detailLifecycleHistoryEntrySchema = z.strictObject({
      sequence: z.number().int().safe().positive(),
      state: z.enum([
        'analyzing',
        'insufficientBaseline',
        'unavailable',
        'open',
        'resolved',
        'superseded',
      ]),
      reasonCode: insightReasonCodeSchema.nullable(),
      occurredAt: utcTimestampSchema,
      replacementOccurrenceId: occurrenceIdSchema.nullable(),
});
const detailSuppressionSchema = z.strictObject({
      state: z.enum(['none', 'active', 'expired', 'undone']),
      suppressionId: sourceReferenceSchema.nullable(),
      scope: z.enum(['occurrence', 'entity', 'category']).nullable(),
      durationDays: z.union([z.literal(30), z.literal(90), z.literal(180)]).nullable(),
      operator: z.literal('fixedLocalOperator').nullable(),
      createdAt: utcTimestampSchema.nullable(),
      expiresAt: utcTimestampSchema.nullable(),
      undoneAt: utcTimestampSchema.nullable(),
}).superRefine((value, context) => {
      const requiredMetadata = [
        'suppressionId',
        'scope',
        'durationDays',
        'operator',
        'createdAt',
        'expiresAt',
      ] as const;
      if (value.state === 'none') {
        if ([...requiredMetadata, 'undoneAt' as const].some((key) => value[key] !== null)) {
          context.addIssue({ code: 'custom', message: 'suppression metadata must be null' });
        }
        return;
      }
      if (requiredMetadata.some((key) => value[key] === null)) {
        context.addIssue({ code: 'custom', message: 'suppression metadata is required' });
      }
      if (value.state === 'undone' ? value.undoneAt === null : value.undoneAt !== null) {
        context.addIssue({ code: 'custom', path: ['undoneAt'], message: 'is inconsistent with state' });
      }
      if (
        value.createdAt !== null
        && value.expiresAt !== null
        && (
          Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
          || (
            value.durationDays !== null
            && Date.parse(value.expiresAt) - Date.parse(value.createdAt)
              !== value.durationDays * 24 * 60 * 60 * 1_000
          )
        )
      ) {
        context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'is inconsistent with duration' });
      }
      if (
        value.undoneAt !== null
        && value.createdAt !== null
        && Date.parse(value.undoneAt) < Date.parse(value.createdAt)
      ) {
        context.addIssue({ code: 'custom', path: ['undoneAt'], message: 'must follow createdAt' });
      }
      if (
        value.undoneAt !== null
        && value.expiresAt !== null
        && Date.parse(value.undoneAt) >= Date.parse(value.expiresAt)
      ) {
        context.addIssue({ code: 'custom', path: ['undoneAt'], message: 'must precede expiresAt' });
      }
});
const detailAvailableActionSchema = z.enum([
      'expected',
      'notUseful',
      'suppress30Days',
      'suppress90Days',
      'suppress180Days',
      'undoSuppression',
]);

const insightOccurrenceDetailObjectSchema = insightOccurrenceSummaryObjectSchema.extend({
      ruleResults: z.array(detailRuleResultSchema).max(12),
      baseline: detailBaselineSchema.nullable(),
      comparisons: z.array(detailComparisonSchema).max(36),
      contributors: z.array(detailContributorSchema).max(10)
        .refine((values) => values.every((value, index) => value.rank === index + 1)),
      exclusions: z.array(insightReasonCodeSchema).max(12)
        .refine((values) => new Set(values).size === values.length),
      evidence: z.array(detailEvidenceSchema).max(8),
      lifecycleHistory: z.array(detailLifecycleHistoryEntrySchema).min(1).max(50)
        .refine((values) => values.every(
          (value, index) => index === 0 || value.sequence > values[index - 1]!.sequence,
        )),
      suppression: detailSuppressionSchema,
      availableActions: z.array(detailAvailableActionSchema).max(6)
        .refine((values) => new Set(values).size === values.length),
});

export const insightOccurrenceDetailSchema = insightOccurrenceDetailObjectSchema
      .superRefine((value, context) => {
        const {
          baseline,
          comparisons,
          contributors,
          lifecycleHistory,
          suppression,
          availableActions,
        } = value;
        const summary: Record<string, unknown> = { ...value };
        for (const key of [
          'ruleResults',
          'baseline',
          'comparisons',
          'contributors',
          'exclusions',
          'evidence',
          'lifecycleHistory',
          'suppression',
          'availableActions',
        ]) {
          delete summary[key];
        }
        if (!insightOccurrenceSummarySchema.safeParse(summary).success) {
          context.addIssue({ code: 'custom', message: 'occurrence summary is invalid' });
        }
        const monetaryCurrencies = [
          baseline?.expectedRange?.currency,
          ...comparisons.map((comparison) => comparison.value?.currency),
          ...contributors.map((contributor) => contributor.amount.currency),
        ].filter((currency): currency is string => currency !== undefined);
        if (monetaryCurrencies.some((currency) => currency !== value.currency)) {
          context.addIssue({ code: 'custom', path: ['currency'], message: 'must match detail values' });
        }
        const hasUndo = availableActions.includes('undoSuppression');
        if (
          (suppression.state === 'active') !== hasUndo
          || (
            suppression.state === 'active'
            && availableActions.some((action) => action.startsWith('suppress'))
          )
        ) {
          context.addIssue({ code: 'custom', path: ['availableActions'], message: 'is inconsistent with suppression' });
        }
        if (
          value.sourceLifecycle !== 'open'
          && (availableActions.length > 0 || suppression.state === 'active')
        ) {
          context.addIssue({ code: 'custom', path: ['sourceLifecycle'], message: 'cannot expose actions' });
        }
        const transitions: Readonly<Record<string, readonly string[]>> = {
          analyzing: ['open', 'insufficientBaseline', 'unavailable'],
          insufficientBaseline: ['analyzing'],
          unavailable: ['analyzing'],
          open: ['resolved', 'superseded'],
          resolved: [],
          superseded: [],
        };
        if (lifecycleHistory[0]?.state !== 'analyzing') {
          context.addIssue({ code: 'custom', path: ['lifecycleHistory', 0], message: 'must begin with analyzing' });
        }
        lifecycleHistory.forEach((entry, index) => {
          if (Date.parse(entry.occurredAt) > Date.parse(value.updatedAt)) {
            context.addIssue({ code: 'custom', path: ['lifecycleHistory', index, 'occurredAt'], message: 'must precede updatedAt' });
          }
          const previous = lifecycleHistory[index - 1];
          if (
            previous
            && (
              !transitions[previous.state]!.includes(entry.state)
              || Date.parse(entry.occurredAt) < Date.parse(previous.occurredAt)
            )
          ) {
            context.addIssue({ code: 'custom', path: ['lifecycleHistory', index], message: 'contains an invalid transition' });
          }
        });
        const terminal = lifecycleHistory.at(-1);
        const expectedTerminal = value.analysisState === 'qualified'
          ? value.sourceLifecycle
          : value.analysisState;
        if (terminal?.state !== expectedTerminal) {
          context.addIssue({ code: 'custom', path: ['lifecycleHistory'], message: 'terminal state is invalid' });
        }
        if (
          terminal
          && (value.sourceLifecycle === 'resolved' || value.sourceLifecycle === 'superseded')
          && (
            terminal.reasonCode !== value.resolutionReason
            || terminal.occurredAt !== value.resolvedAt
            || terminal.replacementOccurrenceId !== value.supersededByOccurrenceId
          )
        ) {
          context.addIssue({ code: 'custom', path: ['lifecycleHistory'], message: 'resolution metadata is invalid' });
        }
        if (
          terminal
          && value.sourceLifecycle === 'open'
          && (terminal.reasonCode !== null || terminal.replacementOccurrenceId !== null)
        ) {
          context.addIssue({ code: 'custom', path: ['lifecycleHistory'], message: 'open metadata is invalid' });
        }
      });

export const insightOccurrenceSummarySchema = insightOccurrenceSummaryBaseSchema
  .superRefine((value, context) => {
    const isQualified = value.analysisState === 'qualified';
    if (isQualified && value.observedValue === null) {
      context.addIssue({ code: 'custom', path: ['observedValue'], message: 'is required for a qualified occurrence' });
    }
    const expectedEntityKind = {
      recurringAmountChange: 'recurring',
      largeTransaction: 'transaction',
      categoryVariance: 'category',
      merchantVariance: 'merchant',
    } as const;
    if (value.entity.kind !== expectedEntityKind[value.kind]) {
      context.addIssue({ code: 'custom', path: ['entity', 'kind'], message: `must be ${expectedEntityKind[value.kind]} for ${value.kind}` });
    }
    if (
      isQualified
      && value.baselineSufficiency === 'insufficient'
      && (
        value.kind !== 'largeTransaction'
        || !value.reasonCodes.includes('explicit_amount_rule_exceeded')
      )
    ) {
      context.addIssue({ code: 'custom', path: ['baselineSufficiency'], message: 'is invalid for this qualified insight' });
    }
    const hasAnyResolution = value.resolutionReason !== null || value.resolvedAt !== null;
    const hasCompleteResolution = value.resolutionReason !== null && value.resolvedAt !== null;
    if (value.sourceLifecycle === 'open' && (hasAnyResolution || value.supersededByOccurrenceId !== null)) {
      context.addIssue({ code: 'custom', path: ['sourceLifecycle'], message: 'open lifecycle cannot be resolved' });
    }
    if (value.sourceLifecycle === 'resolved') {
      if (!hasCompleteResolution) {
        context.addIssue({ code: 'custom', path: ['resolutionReason'], message: 'resolved lifecycle requires a reason and resolvedAt' });
      }
      if (value.supersededByOccurrenceId !== null) {
        context.addIssue({ code: 'custom', path: ['supersededByOccurrenceId'], message: 'must be null for resolved lifecycle' });
      }
    }
    if (value.sourceLifecycle === 'superseded') {
      if (!hasCompleteResolution || value.supersededByOccurrenceId === null) {
        context.addIssue({ code: 'custom', path: ['supersededByOccurrenceId'], message: 'superseded lifecycle requires resolution metadata' });
      } else if (value.supersededByOccurrenceId === value.occurrenceId) {
        context.addIssue({ code: 'custom', path: ['supersededByOccurrenceId'], message: 'must identify a different occurrence' });
      }
    }
    if (value.sourceLifecycle === null && (hasAnyResolution || value.supersededByOccurrenceId !== null)) {
      context.addIssue({ code: 'custom', path: ['sourceLifecycle'], message: 'non-qualified analysis cannot carry resolution' });
    }
    if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
      context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'must be on or after createdAt' });
    }
    if (
      value.resolvedAt !== null
      && (
        Date.parse(value.resolvedAt) < Date.parse(value.createdAt)
        || Date.parse(value.resolvedAt) > Date.parse(value.updatedAt)
      )
    ) {
      context.addIssue({ code: 'custom', path: ['resolvedAt'], message: 'must be within the occurrence lifetime' });
    }
    if (value.freshness.sourceAsOf !== value.provenance.sourceAsOf) {
      context.addIssue({ code: 'custom', path: ['freshness', 'sourceAsOf'], message: 'must match provenance sourceAsOf' });
    }
    const expectedCompleteness = {
      fresh: 'complete',
      stale: 'complete',
      partial: 'partial',
      unavailable: 'unavailable',
    } as const;
    if (value.provenance.completeness !== expectedCompleteness[value.freshness.state]) {
      context.addIssue({ code: 'custom', path: ['provenance', 'completeness'], message: 'must match freshness state' });
    }
    if (
      value.freshness.state === 'fresh'
      && (
        Date.parse(value.provenance.sourceAsOf) > Date.parse(value.provenance.evaluationCompletedAt)
        || Date.parse(value.provenance.evaluationCompletedAt) - Date.parse(value.provenance.sourceAsOf)
          > value.freshness.maxAgeHours * 60 * 60 * 1_000
      )
    ) {
      context.addIssue({ code: 'custom', path: ['freshness', 'state'], message: 'fresh source data exceeds maxAgeHours' });
    }
    const monetaryCurrencies = [
      value.observedValue?.currency,
      value.expectedRange?.currency,
      value.absoluteDelta?.currency,
    ].filter((currency): currency is string => currency !== undefined);
    if (monetaryCurrencies.some((currency) => currency !== value.currency)) {
      context.addIssue({ code: 'custom', path: ['currency'], message: 'must match every monetary value currency' });
    }
  });

const uniqueArray = <T extends z.ZodType>(schema: T, maximum: number) => z.array(schema)
  .max(maximum)
  .refine((values) => new Set(values).size === values.length);

export const occurrenceListQuerySchema = z.strictObject({
  kind: uniqueArray(z.enum(['recurringAmountChange', 'largeTransaction', 'categoryVariance', 'merchantVariance']), 4),
  sourceLifecycle: uniqueArray(z.enum(['open', 'resolved', 'superseded']), 3),
  analysisState: uniqueArray(z.enum(['analyzing', 'qualified', 'insufficientBaseline', 'unavailable']), 4),
  severity: uniqueArray(z.enum(['info', 'medium', 'high']), 3),
  baselineSufficiency: uniqueArray(z.enum(['insufficient', 'limited', 'sufficient']), 3),
  connectorRef: sourceReferenceSchema.nullable(),
  updatedAfter: utcTimestampSchema.nullable(),
  limit: z.number().int().min(1).max(100),
  cursor: z.string().min(1).max(512).nullable(),
});

export function defaultOccurrenceListQueryV1(): z.infer<typeof occurrenceListQuerySchema> {
  return {
    kind: [],
    sourceLifecycle: ['open'],
    analysisState: ['qualified'],
    severity: [],
    baselineSufficiency: [],
    connectorRef: null,
    updatedAfter: null,
    limit: 50,
    cursor: null,
  };
}
export const occurrenceListResponseSchema = z.strictObject({
  contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
  items: z.array(insightOccurrenceSummarySchema).max(100),
  nextCursor: z.string().min(1).max(512).nullable(),
});

const occurrenceActionIdentityShape = {
  contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
  occurrenceId: occurrenceIdSchema,
  expectedDeliveryRevision: positiveSequenceSchema,
  expectedPolicyVersion: positiveSequenceSchema,
  idempotencyKey: idempotencyKeySchema,
} as const;

export const expectedOccurrenceActionRequestSchema = z.strictObject({
  ...occurrenceActionIdentityShape,
  action: z.literal('expected'),
  reason: z.enum([
    'knownHouseholdExpense',
    'expectedSeasonalChange',
    'expectedOneTimePurchase',
  ]),
});

export const notUsefulOccurrenceActionRequestSchema = z.strictObject({
  ...occurrenceActionIdentityShape,
  action: z.literal('notUseful'),
  reason: z.enum([
    'notActionable',
    'comparisonNotRepresentative',
    'duplicateContext',
  ]),
});

export const suppressOccurrenceActionRequestSchema = z.strictObject({
  ...occurrenceActionIdentityShape,
  action: z.literal('suppress'),
  confirm: z.literal(true),
  scope: z.enum(['occurrence', 'entity', 'category']),
  durationDays: z.union([z.literal(30), z.literal(90), z.literal(180)]),
  reason: z.enum([
    'expectedRecurringPattern',
    'approvedMerchant',
    'temporaryHouseholdChange',
  ]),
});

export const undoSuppressionOccurrenceActionRequestSchema = z.strictObject({
  ...occurrenceActionIdentityShape,
  action: z.literal('undoSuppression'),
  suppressionId: sourceReferenceSchema,
  confirm: z.literal(true),
});

export const occurrenceActionRequestSchema = z.discriminatedUnion('action', [
  expectedOccurrenceActionRequestSchema,
  notUsefulOccurrenceActionRequestSchema,
  suppressOccurrenceActionRequestSchema,
  undoSuppressionOccurrenceActionRequestSchema,
]);

const occurrenceActionResultShape = {
  contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
  occurrenceId: occurrenceIdSchema,
  deliveryRevision: positiveSequenceSchema,
  policyVersion: positiveSequenceSchema,
  actionRef: sourceReferenceSchema,
  appliedAt: utcTimestampSchema,
} as const;

export const occurrenceActionResultSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...occurrenceActionResultShape,
    action: z.enum(['expected', 'notUseful']),
    suppressionId: z.null(),
  }),
  z.strictObject({
    ...occurrenceActionResultShape,
    action: z.enum(['suppress', 'undoSuppression']),
    suppressionId: sourceReferenceSchema,
  }),
]);
export const FINANCE_INSIGHT_ERROR_MESSAGES = {
  invalid_request: 'Finance insight request is invalid',
  invalid_filter: 'Finance insight filter is invalid',
  invalid_cursor: 'Finance insight cursor is invalid',
  invalid_date_range: 'Finance insight date range is invalid',
  unsupported_target: 'Finance insight target is unsupported',
  unsupported_action: 'Finance insight action is unsupported',
  insight_auth_required: 'Finance insight authentication is required',
  insight_auth_invalid: 'Finance insight authentication is invalid',
  insight_forbidden: 'Finance insight request is forbidden',
  insight_route_not_available: 'Finance insight route is not available',
  occurrence_not_found: 'Finance insight occurrence was not found',
  idempotency_conflict: 'Finance insight idempotency key conflicts with prior input',
  source_generation_conflict: 'Finance insight source generation conflicts with prior input',
  source_batch_conflict: 'Finance insight source batch conflicts with prior input',
  source_currency_conflict: 'Finance insight source currency conflicts with policy',
  stale_source_generation: 'Finance insight source generation is stale',
  stale_evaluation: 'Finance insight evaluation is stale',
  occurrence_revision_conflict: 'Finance insight occurrence revision has changed',
  policy_conflict: 'Finance insight policy version has changed',
  payload_too_large: 'Finance insight request payload is too large',
  page_too_large: 'Finance insight page exceeds the allowed size',
  source_generation_too_large: 'Finance insight source generation exceeds the allowed size',
  unsupported_media_type: 'Finance insight media type is unsupported',
  evaluation_in_progress: 'Finance insight evaluation is in progress',
  insight_service_not_configured: 'Finance insight service is not configured',
  insight_source_unavailable: 'Finance insight source data is unavailable',
  insight_store_unavailable: 'Finance insight store is unavailable',
  insight_operation_failed: 'Finance insight operation failed',
} as const;

const insightErrorVariants = Object.entries(FINANCE_INSIGHT_ERROR_MESSAGES).map(
  ([code, message]) => z.strictObject({
    contractVersion: z.literal(FINANCE_INSIGHTS_CONTRACT_VERSION),
    error: z.strictObject({
      code: z.literal(code),
      message: z.literal(message),
    }),
  }),
);

export const insightErrorResponseSchema = z.union(insightErrorVariants as [
  (typeof insightErrorVariants)[number],
  (typeof insightErrorVariants)[number],
  ...(typeof insightErrorVariants)[number][],
]);

export type SourceFactKindV1 = z.infer<typeof sourceFactKindSchema>;
export type TransactionSourceFactV1 = z.infer<typeof transactionSourceFactSchema>;
export type RecurringSourceFactV1 = z.infer<typeof recurringSourceFactSchema>;
export type CategorySourceFactV1 = z.infer<typeof categorySourceFactSchema>;
export type AccountSourceFactV1 = z.infer<typeof accountSourceFactSchema>;
export type TagSourceFactV1 = z.infer<typeof tagSourceFactSchema>;
export type SourceFactBatchV1 = z.infer<typeof sourceFactBatchSchema>;
export type SourceGenerationCreateRequestV1 = z.infer<typeof sourceGenerationCreateRequestSchema>;
export type SourceGenerationCommitRequestV1 = z.infer<typeof sourceGenerationCommitRequestSchema>;
export type SourceGenerationResultV1 = z.infer<typeof sourceGenerationResultSchema>;
export type SourceBatchReceiptV1 = z.infer<typeof sourceBatchReceiptSchema>;
export type EvaluationRequestV1 = z.infer<typeof evaluationRequestSchema>;
export type EvaluationResultV1 = z.infer<typeof evaluationResultSchema>;
export type ExternalTargetV1 = z.infer<typeof externalTargetSchema>;
export type InsightOccurrenceSummaryV1 = z.infer<typeof insightOccurrenceSummarySchema>;
export type InsightOccurrenceDetailV1 = z.infer<typeof insightOccurrenceDetailSchema>;
export type OccurrenceListQueryV1 = z.infer<typeof occurrenceListQuerySchema>;
export type OccurrenceListResponseV1 = z.infer<typeof occurrenceListResponseSchema>;
export type OccurrenceActionRequestV1 = z.infer<typeof occurrenceActionRequestSchema>;
export type OccurrenceActionResultV1 = z.infer<typeof occurrenceActionResultSchema>;
