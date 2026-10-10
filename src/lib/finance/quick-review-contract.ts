import { z } from 'zod';

export const FINANCE_QUICK_REVIEW_CONTRACT_VERSION = '1.0' as const;

const calendarDateSchema = z.iso.date();
const boundedLabelSchema = z.string().trim().min(1).max(120);
const confidenceSchema = z.number().min(0).max(1);

export const financeReviewPresetSchema = z.enum([
  'impact-confidence',
  'highest-amount',
  'newest',
  'kids-uncertainty',
  'category-uncertainty',
  'payee-uncertainty',
  'custom',
]);

export const financeReviewFiltersSchema = z.object({
  preset: financeReviewPresetSchema.default('impact-confidence'),
  startDate: calendarDateSchema.nullable().default(null),
  endDate: calendarDateSchema.nullable().default(null),
  minimumAmount: z.number().finite().nonnegative().nullable().default(null),
  maximumAmount: z.number().finite().nonnegative().nullable().default(null),
  accountNames: z.array(boundedLabelSchema).max(20).default([]),
}).strict().superRefine((filters, context) => {
  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
    context.addIssue({ code: 'custom', message: 'startDate must not be after endDate' });
  }
  if (
    filters.minimumAmount !== null
    && filters.maximumAmount !== null
    && filters.minimumAmount > filters.maximumAmount
  ) {
    context.addIssue({ code: 'custom', message: 'minimumAmount must not exceed maximumAmount' });
  }
});

export const financeReviewSessionRequestSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  connectorId: z.string().trim().min(1).max(200).optional(),
  mode: z.enum(['ranked', 'period']),
  filters: financeReviewFiltersSchema,
  resumeToken: z.string().trim().min(16).max(512).nullable().default(null),
}).strict().superRefine((request, context) => {
  if (
    request.mode === 'period'
    && (!request.filters.startDate || !request.filters.endDate)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'A start and end date are required when reviewing a period',
      path: ['filters'],
    });
  }
});

const correctionOptionSchema = z.object({
  id: z.string().trim().min(1).max(160),
  label: boundedLabelSchema,
}).strict();

const confidenceSignalsSchema = z.object({
  overall: confidenceSchema,
  kids: confidenceSchema.nullable(),
  category: confidenceSchema.nullable(),
  payee: confidenceSchema.nullable(),
}).strict();

export const financeReviewItemSchema = z.object({
  reviewRef: z.string().trim().min(16).max(256),
  stateToken: z.string().trim().min(16).max(256),
  date: calendarDateSchema,
  amount: z.number().finite(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  accountName: boundedLabelSchema,
  payee: boundedLabelSchema,
  category: correctionOptionSchema.nullable(),
  kid: correctionOptionSchema.nullable(),
  monarchReview: z.object({
    status: z.enum(['needs-review', 'reviewed', 'unavailable']),
    assignedTo: boundedLabelSchema.nullable(),
  }).strict(),
  whySelected: z.array(z.string().trim().min(1).max(180)).min(1).max(6),
  confidence: confidenceSignalsSchema,
  corrections: z.object({
    kids: z.array(correctionOptionSchema).max(30),
    categories: z.array(correctionOptionSchema).max(200),
    payeeSuggestions: z.array(boundedLabelSchema).max(20),
    maySuggestKidRule: z.boolean(),
  }).strict(),
  research: z.object({
    recommended: z.boolean(),
    reason: z.string().trim().min(1).max(180).nullable(),
    normalizedVendorName: boundedLabelSchema,
    coarseLocation: z.object({
      locality: z.string().trim().min(1).max(80).nullable(),
      region: z.string().trim().min(1).max(80).nullable(),
      countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
    }).strict().nullable(),
  }).strict(),
}).strict();

export const financeReviewSessionSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  sessionRef: z.string().trim().min(16).max(256),
  resumeToken: z.string().trim().min(16).max(512),
  sourceAsOf: z.iso.datetime({ offset: true }),
  mode: z.enum(['ranked', 'period']),
  filters: financeReviewFiltersSchema,
  progress: z.object({
    reviewed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }).strict(),
  current: financeReviewItemSchema.nullable(),
  accounts: z.array(boundedLabelSchema).max(100),
}).strict();

const correctionSchema = z.object({
  kidId: z.string().trim().min(1).max(160).nullable().optional(),
  categoryId: z.string().trim().min(1).max(160).nullable().optional(),
  payee: boundedLabelSchema.optional(),
}).strict();

export const financeReviewActionRequestSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  connectorId: z.string().trim().min(1).max(200).optional(),
  sessionRef: z.string().trim().min(16).max(256),
  resumeToken: z.string().trim().min(16).max(512),
  reviewRef: z.string().trim().min(16).max(256),
  stateToken: z.string().trim().min(16).max(256),
  idempotencyKey: z.uuid(),
  action: z.enum(['confirm', 'correct', 'skip']),
  monarchReviewOutcome: z.enum(['reviewed', 'unchanged']),
  correction: correctionSchema.nullable().default(null),
}).strict().superRefine((request, context) => {
  if (request.action === 'correct' && !request.correction) {
    context.addIssue({ code: 'custom', message: 'A correction is required', path: ['correction'] });
  }
  if (request.action !== 'correct' && request.correction) {
    context.addIssue({
      code: 'custom',
      message: 'Corrections are only accepted for the correct action',
      path: ['correction'],
    });
  }
  const expectedOutcome = request.action === 'skip' ? 'unchanged' : 'reviewed';
  if (request.monarchReviewOutcome !== expectedOutcome) {
    context.addIssue({
      code: 'custom',
      message: `${request.action} requires Monarch review state to be ${expectedOutcome}`,
      path: ['monarchReviewOutcome'],
    });
  }
});

export const financeVendorResearchRequestSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  connectorId: z.string().trim().min(1).max(200).optional(),
  sessionRef: z.string().trim().min(16).max(256),
  resumeToken: z.string().trim().min(16).max(512),
  reviewRef: z.string().trim().min(16).max(256),
  stateToken: z.string().trim().min(16).max(256),
  request: z.string().trim().min(1).max(500).nullable().default(null),
  publicContext: z.object({
    normalizedVendorName: boundedLabelSchema,
    coarseLocation: z.object({
      locality: z.string().trim().min(1).max(80).nullable(),
      region: z.string().trim().min(1).max(80).nullable(),
      countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
    }).strict().nullable(),
    amount: z.number().finite().nullable(),
    date: calendarDateSchema.nullable(),
    sensitiveContextApproved: z.boolean(),
  }).strict(),
}).strict().superRefine((request, context) => {
  if ((request.publicContext.amount === null) !== (request.publicContext.date === null)) {
    context.addIssue({
      code: 'custom',
      message: 'Amount and date must be provided together',
      path: ['publicContext'],
    });
  }
  const includesSensitiveContext = (
    request.publicContext.amount !== null || request.publicContext.date !== null
  );
  if (includesSensitiveContext && !request.publicContext.sensitiveContextApproved) {
    context.addIssue({
      code: 'custom',
      message: 'Amount and date require explicit disclosure approval',
      path: ['publicContext', 'sensitiveContextApproved'],
    });
  }
});

const researchStatementSchema = z.object({
  statement: z.string().trim().min(1).max(400),
  confidence: confidenceSchema,
  sourceIds: z.array(z.string().trim().min(1).max(80)).max(10),
}).strict();

export const financeVendorResearchResponseSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  reviewRef: z.string().trim().min(16).max(256),
  researchedAt: z.iso.datetime({ offset: true }),
  facts: z.array(researchStatementSchema).max(12),
  inferences: z.array(researchStatementSchema).max(12),
  suggestions: z.object({
    businessIdentity: boundedLabelSchema.nullable(),
    location: z.string().trim().min(1).max(160).nullable(),
    businessType: boundedLabelSchema.nullable(),
    plausiblePurchase: z.string().trim().min(1).max(240).nullable(),
    category: boundedLabelSchema.nullable(),
    kidsClues: z.array(z.string().trim().min(1).max(180)).max(8),
  }).strict(),
  riskIndicators: z.array(z.object({
    label: z.literal('Needs investigation'),
    detail: z.string().trim().min(1).max(240),
    confidence: confidenceSchema,
  }).strict()).max(8),
  sources: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(200),
    url: z.url().refine((value) => value.startsWith('https://'), 'Source URL must use HTTPS'),
    publisher: z.string().trim().min(1).max(120),
  }).strict()).max(20),
}).strict();

export type FinanceReviewFilters = z.infer<typeof financeReviewFiltersSchema>;
export type FinanceReviewSessionRequest = z.infer<typeof financeReviewSessionRequestSchema>;
export type FinanceReviewSession = z.infer<typeof financeReviewSessionSchema>;
export type FinanceReviewItem = z.infer<typeof financeReviewItemSchema>;
export type FinanceReviewActionRequest = z.infer<typeof financeReviewActionRequestSchema>;
export type FinanceVendorResearchRequest = z.infer<typeof financeVendorResearchRequestSchema>;
export type FinanceVendorResearchResponse = z.infer<typeof financeVendorResearchResponseSchema>;

const tyrionOpaqueRefSchema = z.string().trim().min(1).max(512)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Reference contains controls');
const normalizedTyrionNameSchema = z.string().trim().min(1).max(120)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Name contains controls')
  .transform((value) => value.replace(/\s+/g, ' '));
const tyrionSignalSchema = z.enum([
  'kid-attribution-ambiguous',
  'payee-ambiguous',
  'category-mismatch',
  'unknown-merchant',
  'new-merchant',
  'monarch-needs-review',
]);

export const tyrionQuickReviewRankRequestSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  items: z.array(z.object({
    sourceRef: tyrionOpaqueRefSchema,
    occurredOn: calendarDateSchema,
    merchantName: normalizedTyrionNameSchema,
    isPending: z.boolean(),
    monarchReviewStatus: z.enum(['needs_review', 'reviewed']),
    attribution: z.object({
      status: z.enum(['assigned', 'parent-expense', 'unassigned']),
      confidence: z.enum(['definite', 'likely', 'unknown']),
      reviewStatus: z.enum(['none', 'needs-review', 'deferred']),
    }).strict(),
    signals: z.array(tyrionSignalSchema).max(5)
      .refine((values) => new Set(values).size === values.length, 'Signals must be unique'),
  }).strict()).min(1).max(100)
    .refine(
      (items) => new Set(items.map((item) => item.sourceRef)).size === items.length,
      'sourceRef values must be unique',
    ),
}).strict();

export const tyrionQuickReviewRankResponseSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  rankedItems: z.array(z.object({
    sourceRef: tyrionOpaqueRefSchema,
    rank: z.number().int().min(1),
    score: z.number().int().min(0).max(100),
    reasons: z.array(tyrionSignalSchema)
      .refine((values) => new Set(values).size === values.length, 'Reasons must be unique'),
  }).strict()).min(1).max(100),
}).strict();

const coarseLocationSchema = z.object({
  locality: z.string().trim().min(1).max(80).nullable(),
  region: z.string().trim().min(1).max(80).nullable(),
  countryCode: z.string().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()).nullable(),
}).strict();

export const tyrionQuickReviewResearchRequestSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  vendorName: normalizedTyrionNameSchema,
  coarseLocation: coarseLocationSchema.nullable(),
  sensitiveContext: z.object({
    amount: z.number().finite().min(-999_999_999.99).max(999_999_999.99)
      .transform((value) => Math.round(value * 100) / 100),
    occurredOn: calendarDateSchema,
  }).strict().nullable(),
  disclosure: z.object({
    shown: z.boolean(),
    confirmedAt: z.iso.datetime({ offset: true }).nullable(),
  }).strict(),
}).strict().superRefine((request, context) => {
  if (
    request.sensitiveContext !== null
    && (!request.disclosure.shown || request.disclosure.confirmedAt === null)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Sensitive research context requires confirmed disclosure',
      path: ['disclosure'],
    });
  }
});

export const tyrionQuickReviewResearchResponseSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  query: z.object({
    vendorName: normalizedTyrionNameSchema,
    coarseLocation: coarseLocationSchema.nullable(),
    amount: z.number().finite().nullable(),
    occurredOn: calendarDateSchema.nullable(),
  }).strict(),
  outputPolicy: z.object({
    factsRequireSources: z.literal(true),
    inferencesMustBeLabeled: z.literal(true),
    fraudAssertionAllowed: z.literal(false),
  }).strict(),
}).strict();

export const tyrionQuickReviewRuleRequestSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  merchantName: normalizedTyrionNameSchema,
  kidId: tyrionOpaqueRefSchema,
  suggestReusableRule: z.boolean(),
}).strict();

export const tyrionQuickReviewRuleResponseSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  policyVersion: z.number().int().positive(),
  suggestion: z.object({
    kind: z.literal('merchant'),
    merchantPattern: z.string().trim().min(1).max(120),
    kidId: tyrionOpaqueRefSchema,
    confidence: z.literal('likely'),
    requiresConfirmation: z.literal(true),
  }).strict().nullable(),
}).strict();

export const financeQuickReviewRuleSuggestionRequestSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  sessionRef: z.string().trim().min(16).max(256),
  resumeToken: z.string().trim().min(16).max(512),
  reviewRef: z.string().trim().min(16).max(256),
  stateToken: z.string().trim().min(16).max(256),
  merchantName: normalizedTyrionNameSchema,
  kidId: tyrionOpaqueRefSchema,
  suggestReusableRule: z.literal(true),
}).strict();

export const financeQuickReviewRuleSuggestionResponseSchema = z.object({
  contractVersion: z.literal(FINANCE_QUICK_REVIEW_CONTRACT_VERSION),
  suggestion: tyrionQuickReviewRuleResponseSchema.shape.suggestion,
}).strict();

export type TyrionQuickReviewRankRequest = z.infer<typeof tyrionQuickReviewRankRequestSchema>;
export type TyrionQuickReviewRankResponse = z.infer<typeof tyrionQuickReviewRankResponseSchema>;
export type TyrionQuickReviewResearchRequest = z.infer<typeof tyrionQuickReviewResearchRequestSchema>;
export type TyrionQuickReviewResearchResponse = z.infer<typeof tyrionQuickReviewResearchResponseSchema>;
export type TyrionQuickReviewRuleRequest = z.infer<typeof tyrionQuickReviewRuleRequestSchema>;
export type TyrionQuickReviewRuleResponse = z.infer<typeof tyrionQuickReviewRuleResponseSchema>;
export type FinanceQuickReviewRuleSuggestionRequest = z.infer<
  typeof financeQuickReviewRuleSuggestionRequestSchema
>;
export type FinanceQuickReviewRuleSuggestionResponse = z.infer<
  typeof financeQuickReviewRuleSuggestionResponseSchema
>;

export const TYRION_MERCHANT_RULE_CONTRACT_VERSION = '2.0' as const;

const merchantRulePatternSchema = z.string().trim().min(2).max(160)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Pattern contains controls')
  .transform((value) => value.replace(/\s+/g, ' '));
const merchantRuleAccountRefSchema = z.string().trim().min(1).max(512)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Account reference contains controls');
const merchantRuleIdempotencyKeySchema = z.string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const tyrionMerchantRuleSchema = z.object({
  outcome: z.enum(['kid', 'parent-shared', 'review']),
  kidId: tyrionOpaqueRefSchema.nullable(),
  pattern: merchantRulePatternSchema,
  businessEntityPattern: merchantRulePatternSchema.nullable(),
  scope: z.enum(['global', 'accounts']),
  accountRefs: z.array(merchantRuleAccountRefSchema).max(32)
    .refine((values) => new Set(values).size === values.length, 'Account references must be unique'),
  confidence: z.enum(['definite', 'likely']),
}).strict().superRefine((rule, context) => {
  if ((rule.outcome === 'kid') !== (rule.kidId !== null)) {
    context.addIssue({
      code: 'custom',
      message: 'kidId is required only for kid outcomes',
      path: ['kidId'],
    });
  }
  if (rule.scope === 'global' && rule.accountRefs.length !== 0) {
    context.addIssue({
      code: 'custom',
      message: 'Global rules cannot include account references',
      path: ['accountRefs'],
    });
  }
  if (rule.scope === 'accounts' && rule.accountRefs.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'Account-scoped rules require at least one account reference',
      path: ['accountRefs'],
    });
  }
});

export const tyrionMerchantRuleCreateRequestSchema = z.object({
  contractVersion: z.literal(TYRION_MERCHANT_RULE_CONTRACT_VERSION),
  expectedPolicyVersion: z.number().int().positive(),
  idempotencyKey: merchantRuleIdempotencyKeySchema,
  confirmation: z.object({
    confirmed: z.literal(true),
    confirmedAt: z.iso.datetime({ offset: true }),
  }).strict(),
  rule: tyrionMerchantRuleSchema,
}).strict();

export const tyrionMerchantRuleCreateResponseSchema = z.object({
  contractVersion: z.literal(TYRION_MERCHANT_RULE_CONTRACT_VERSION),
  outcome: z.enum(['created', 'replayed']),
  policyVersion: z.number().int().positive(),
  rule: tyrionMerchantRuleSchema.extend({
    id: z.string().trim().min(1).max(256),
    enabled: z.literal(true),
  }).strict(),
}).strict();

export const financeMerchantRuleCreateRequestSchema = z.object({
  contractVersion: z.literal(TYRION_MERCHANT_RULE_CONTRACT_VERSION),
  sessionRef: z.string().trim().min(16).max(256),
  resumeToken: z.string().trim().min(16).max(512),
  reviewRef: z.string().trim().min(16).max(256),
  stateToken: z.string().trim().min(16).max(256),
  idempotencyKey: z.uuid(),
  confirmation: z.object({
    confirmed: z.literal(true),
    confirmedAt: z.iso.datetime({ offset: true }),
    globalScopeConfirmed: z.boolean(),
  }).strict(),
  rule: z.object({
    outcome: z.enum(['kid', 'parent-shared', 'review']),
    kidId: tyrionOpaqueRefSchema.nullable(),
    pattern: merchantRulePatternSchema,
    businessEntityPattern: merchantRulePatternSchema.nullable(),
    scope: z.enum(['global', 'accounts']),
    confidence: z.enum(['definite', 'likely']),
  }).strict(),
}).strict().superRefine((request, context) => {
  if ((request.rule.outcome === 'kid') !== (request.rule.kidId !== null)) {
    context.addIssue({
      code: 'custom',
      message: 'kidId is required only for kid outcomes',
      path: ['rule', 'kidId'],
    });
  }
  if (request.rule.scope === 'global' && !request.confirmation.globalScopeConfirmed) {
    context.addIssue({
      code: 'custom',
      message: 'Global scope requires an additional confirmation',
      path: ['confirmation', 'globalScopeConfirmed'],
    });
  }
  if (request.rule.scope === 'accounts' && request.confirmation.globalScopeConfirmed) {
    context.addIssue({
      code: 'custom',
      message: 'Account scope cannot include global confirmation',
      path: ['confirmation', 'globalScopeConfirmed'],
    });
  }
});

export const financeMerchantRuleCreateResponseSchema = z.object({
  contractVersion: z.literal(TYRION_MERCHANT_RULE_CONTRACT_VERSION),
  outcome: z.enum(['created', 'replayed']),
  policyVersion: z.number().int().positive(),
  rule: z.object({
    id: z.string().trim().min(1).max(256),
    outcome: z.enum(['kid', 'parent-shared', 'review']),
    kidId: tyrionOpaqueRefSchema.nullable(),
    pattern: merchantRulePatternSchema,
    businessEntityPattern: merchantRulePatternSchema.nullable(),
    scope: z.enum(['global', 'accounts']),
    confidence: z.enum(['definite', 'likely']),
    enabled: z.literal(true),
  }).strict(),
}).strict();

export type TyrionMerchantRule = z.infer<typeof tyrionMerchantRuleSchema>;
export type TyrionMerchantRuleCreateRequest = z.infer<typeof tyrionMerchantRuleCreateRequestSchema>;
export type TyrionMerchantRuleCreateResponse = z.infer<typeof tyrionMerchantRuleCreateResponseSchema>;
export type FinanceMerchantRuleCreateRequest = z.infer<typeof financeMerchantRuleCreateRequestSchema>;
export type FinanceMerchantRuleCreateResponse = z.infer<typeof financeMerchantRuleCreateResponseSchema>;
