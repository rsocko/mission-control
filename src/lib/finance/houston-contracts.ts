import { z } from 'zod';

export const FINANCE_TOOL_NAMES = [
  'getHouseholdFinanceSummary',
  'searchFinanceTransactions',
  'getPendingFinanceExceptions',
  'getKidSpending',
  'getFinanceObligations',
  'getFinanceConnectorHealth',
] as const;

export const financeFreshnessSchema = z.enum([
  'fresh',
  'stale',
  'partial',
  'unavailable',
]);

const calendarDateSchema = z.iso.date();
const optionalDateRangeShape = {
  startDate: calendarDateSchema.optional(),
  endDate: calendarDateSchema.optional(),
};

function boundedDateRange<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, ...optionalDateRangeShape }).strict().superRefine((value, context) => {
    const dates = value as { startDate?: string; endDate?: string };
    if (!dates.startDate || !dates.endDate) return;
    const start = Date.parse(`${dates.startDate}T00:00:00.000Z`);
    const end = Date.parse(`${dates.endDate}T00:00:00.000Z`);
    if (start > end) {
      context.addIssue({ code: 'custom', message: 'startDate must not be after endDate' });
    } else if (end - start > 366 * 86_400_000) {
      context.addIssue({ code: 'custom', message: 'Date range must not exceed 366 days' });
    }
  });
}

export const householdFinanceSummaryInputSchema = boundedDateRange({});
export const financeTransactionSearchInputSchema = boundedDateRange({
  query: z.string().trim().min(1).max(80).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  kidName: z.string().trim().min(1).max(80).optional(),
  triageStatus: z.enum(['pending', 'confirmed', 'flagged']).optional(),
  limit: z.number().int().min(1).max(25).optional().default(15),
});
export const pendingFinanceExceptionsInputSchema = z.object({
  limit: z.number().int().min(1).max(20).optional().default(10),
}).strict();
export const kidSpendingInputSchema = boundedDateRange({
  kidName: z.string().trim().min(1).max(80),
  limit: z.number().int().min(1).max(20).optional().default(10),
});
export const financeObligationsInputSchema = z.object({
  horizonDays: z.number().int().min(1).max(365).optional().default(90),
  limit: z.number().int().min(1).max(25).optional().default(15),
}).strict();
export const financeConnectorHealthInputSchema = z.object({}).strict();

const provenanceEntrySchema = z.object({
  kind: z.enum(['monarch-fact', 'tyrion-derived', 'mission-control-calculated']),
  label: z.string().max(80),
  included: z.boolean(),
}).strict();

export const financeToolMetaSchema = z.object({
  sourceAsOf: z.iso.datetime({ offset: true }).nullable(),
  coverage: z.object({
    start: calendarDateSchema,
    end: calendarDateSchema,
  }).strict().nullable(),
  freshness: financeFreshnessSchema,
  truncated: z.boolean(),
  deepLink: z.enum(['/finance', '/finance/review']),
  provenance: z.array(provenanceEntrySchema).length(3),
}).strict();

const categoryAggregateSchema = z.object({
  category: z.string().max(100),
  amount: z.number().finite().nonnegative(),
  transactionCount: z.number().int().nonnegative(),
}).strict();

const kidAggregateSchema = z.object({
  kidName: z.string().max(100),
  amount: z.number().finite().nonnegative(),
  transactionCount: z.number().int().nonnegative(),
}).strict();

export const householdFinanceSummaryOutputSchema = z.object({
  kind: z.literal('household-finance-summary'),
  period: z.object({ startDate: calendarDateSchema, endDate: calendarDateSchema }).strict(),
  missionControlCalculated: z.object({
    totalSpending: z.number().finite().nonnegative(),
    transactionCount: z.number().int().nonnegative(),
    byCategory: z.array(categoryAggregateSchema).max(12),
    byKid: z.array(kidAggregateSchema).max(12),
  }).strict(),
  meta: financeToolMetaSchema,
}).strict();

const transactionSchema = z.object({
  factsViaTyrionBridge: z.object({
    date: calendarDateSchema,
    amount: z.number().finite(),
    merchant: z.string().max(120),
    category: z.string().max(100).nullable(),
    pending: z.boolean(),
    recurring: z.boolean(),
  }).strict(),
  tyrionDerived: z.object({
    kidName: z.string().max(100).nullable(),
    attributionStatus: z.enum(['attributed', 'unassigned', 'pending', 'unavailable']),
    confidence: z.enum(['definite', 'likely', 'none']).nullable(),
    method: z.enum([
      'manual',
      'card-rule',
      'merchant-rule',
      'historical-pattern',
      'unassigned',
      'unavailable',
    ]).nullable(),
  }).strict(),
}).strict();

export const financeTransactionSearchOutputSchema = z.object({
  kind: z.literal('finance-transaction-search'),
  transactions: z.array(transactionSchema).max(25),
  meta: financeToolMetaSchema,
}).strict();

export const pendingFinanceExceptionsOutputSchema = z.object({
  kind: z.literal('pending-finance-exceptions'),
  exceptions: z.array(z.object({
    date: calendarDateSchema,
    merchant: z.string().max(120),
    reason: z.string().max(80),
    retryable: z.boolean(),
    kidName: z.string().max(100).nullable(),
    confidence: z.enum(['definite', 'likely', 'none']).nullable(),
    conclusion: z.string().max(240).nullable(),
    observedAt: z.iso.datetime({ offset: true }),
  }).strict()).max(20),
  meta: financeToolMetaSchema,
}).strict();

export const kidSpendingOutputSchema = z.object({
  kind: z.literal('kid-spending'),
  kidName: z.string().max(100),
  period: z.object({ startDate: calendarDateSchema, endDate: calendarDateSchema }).strict(),
  missionControlCalculated: z.object({
    totalSpending: z.number().finite().nonnegative(),
    transactionCount: z.number().int().nonnegative(),
    dailyLimit: z.number().finite().nonnegative().nullable(),
    weeklyLimit: z.number().finite().nonnegative().nullable(),
    monthlyLimit: z.number().finite().nonnegative().nullable(),
  }).strict(),
  recentTransactions: z.array(transactionSchema).max(20),
  meta: financeToolMetaSchema,
}).strict();

export const financeObligationsOutputSchema = z.object({
  kind: z.literal('finance-obligations'),
  horizonDays: z.number().int().min(1).max(365),
  obligations: z.array(z.object({
    factsViaTyrionBridge: z.object({
      merchant: z.string().max(120),
      amount: z.number().finite(),
      frequency: z.string().max(40),
      nextExpectedDate: calendarDateSchema.nullable(),
      category: z.string().max(100).nullable(),
    }).strict(),
  }).strict()).max(25),
  missionControlCalculated: z.object({
    estimatedMonthlyAmount: z.number().finite().nonnegative(),
  }).strict(),
  meta: financeToolMetaSchema,
}).strict();

export const financeConnectorHealthOutputSchema = z.object({
  kind: z.literal('finance-connector-health'),
  missionControlCalculated: z.object({
    overall: z.enum(['healthy', 'degraded', 'unavailable']),
  }).strict(),
  bridgeProjection: z.object({
    status: financeFreshnessSchema,
    lastSuccessfulSyncAt: z.iso.datetime({ offset: true }).nullable(),
  }).strict(),
  tyrionAttribution: z.object({
    status: z.enum(['idle', 'healthy', 'degraded', 'unavailable']),
    lastSuccessfulAt: z.iso.datetime({ offset: true }).nullable(),
  }).strict(),
  datasets: z.array(z.object({
    name: z.string().max(40),
    freshness: financeFreshnessSchema,
    itemCount: z.number().int().nonnegative(),
    sourceAsOf: z.iso.datetime({ offset: true }).nullable(),
    coverage: z.object({
      start: calendarDateSchema,
      end: calendarDateSchema,
    }).strict().nullable(),
  }).strict()).max(6),
  meta: financeToolMetaSchema,
}).strict();

export const financeToolOutputSchema = z.discriminatedUnion('kind', [
  householdFinanceSummaryOutputSchema,
  financeTransactionSearchOutputSchema,
  pendingFinanceExceptionsOutputSchema,
  kidSpendingOutputSchema,
  financeObligationsOutputSchema,
  financeConnectorHealthOutputSchema,
]);

export type HouseholdFinanceSummaryInput = z.input<typeof householdFinanceSummaryInputSchema>;
export type FinanceTransactionSearchInput = z.input<typeof financeTransactionSearchInputSchema>;
export type PendingFinanceExceptionsInput = z.input<typeof pendingFinanceExceptionsInputSchema>;
export type KidSpendingInput = z.input<typeof kidSpendingInputSchema>;
export type FinanceObligationsInput = z.input<typeof financeObligationsInputSchema>;
export type FinanceConnectorHealthInput = z.input<typeof financeConnectorHealthInputSchema>;
export type HouseholdFinanceSummaryOutput = z.infer<typeof householdFinanceSummaryOutputSchema>;
export type FinanceTransactionSearchOutput = z.infer<typeof financeTransactionSearchOutputSchema>;
export type PendingFinanceExceptionsOutput = z.infer<typeof pendingFinanceExceptionsOutputSchema>;
export type KidSpendingOutput = z.infer<typeof kidSpendingOutputSchema>;
export type FinanceObligationsOutput = z.infer<typeof financeObligationsOutputSchema>;
export type FinanceConnectorHealthOutput = z.infer<typeof financeConnectorHealthOutputSchema>;
export type FinanceToolOutput = z.infer<typeof financeToolOutputSchema>;
