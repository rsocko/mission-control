import { z } from 'zod';

export const RECEIPT_RECONCILIATION_CONTRACT_VERSION = '1.0' as const;
export const RECEIPT_RECONCILIATION_PAGE_LIMIT = 100;

const identifierSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value));
const boundedTextSchema = z.string().trim().min(1).max(120);
const timestampSchema = z.string()
  .trim()
  .min(1)
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid timestamp')
  .transform((value) => (
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`
  ));
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const amountMinorSchema = z.number().int().safe().min(0).max(100_000_000_000);

export const paymentCaseKindSchema = z.enum([
  'unmatched',
  'ambiguous',
  'source_unavailable',
  'projection_failed',
  'stale',
  'conflict',
  'not_applicable',
  'partial_payment',
  'double_payment',
]);
export const paymentCaseActionSchema = z.enum([
  'confirm',
  'reject',
  'replace',
  'clear',
  'defer',
  'reopen',
  'mark_not_applicable',
  'deliver_attention',
  'acknowledge_attention',
]);

const sourceActionSchema = z.strictObject({
  id: paymentCaseActionSchema,
  method: z.literal('POST'),
  url: z.string().startsWith('/api/mc/v1/payment-reconciliation-reviews/').max(500),
  expectedRevision: z.number().int().safe().positive(),
});

const obligationSchema = z.strictObject({
  id: identifierSchema,
  status: z.string().trim().min(1).max(64),
  revision: z.number().int().safe().positive(),
  expectedAmountMinor: amountMinorSchema.nullable(),
  currency: currencySchema.nullable(),
  completionSuggested: z.boolean(),
}).superRefine((value, context) => {
  if ((value.expectedAmountMinor === null) !== (value.currency === null)) {
    context.addIssue({ code: 'custom', message: 'Obligation amount and currency must appear together' });
  }
});

export const paymentEvidenceSummarySchema = z.strictObject({
  id: identifierSchema,
  kind: z.enum(['invoice', 'bill', 'receipt', 'posted_transaction', 'pending_transaction']),
  payeeHint: boundedTextSchema.nullable(),
  amountMinor: amountMinorSchema.nullable(),
  currency: currencySchema.nullable(),
  evidenceDate: z.iso.date().nullable(),
  sourceSystem: z.enum(['tyrion_receipt', 'tyrion_bill_match', 'legacy_receipt']),
  sourceState: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  matchState: z.enum([
    'matched',
    'no_match',
    'ambiguous',
    'conflict',
    'source_unavailable',
    'projection_failed',
    'stale',
    'not_applicable',
  ]),
  paymentStatus: z.enum(['paid', 'pending', 'unmatched', 'ambiguous', 'unknown']),
  confidence: z.enum(['high', 'medium', 'low']).nullable(),
  reasonCodes: z.array(z.string().regex(/^[a-z0-9._-]+$/).max(64)).max(20),
  sourceAsOf: timestampSchema,
  edgeState: z.string().trim().min(1).max(64).nullable(),
}).superRefine((value, context) => {
  if ((value.amountMinor === null) !== (value.currency === null)) {
    context.addIssue({ code: 'custom', message: 'Evidence amount and currency must appear together' });
  }
  if (new Set(value.reasonCodes).size !== value.reasonCodes.length) {
    context.addIssue({ code: 'custom', path: ['reasonCodes'], message: 'Reason codes must be unique' });
  }
});

const paymentSummarySchema = z.strictObject({
  reasonCodes: z.array(z.string().regex(/^[a-z0-9._-]+$/).max(64)).max(20).optional(),
  sourceGeneration: identifierSchema.optional(),
  expectedAmountMinor: amountMinorSchema.optional(),
  allocatedAmountMinor: amountMinorSchema.optional(),
  currency: currencySchema.optional(),
});

export const paymentReviewItemSchema = z.strictObject({
  contractVersion: z.literal(RECEIPT_RECONCILIATION_CONTRACT_VERSION),
  id: identifierSchema,
  revision: z.number().int().safe().positive(),
  caseKind: paymentCaseKindSchema,
  state: z.enum(['open', 'deferred', 'resolved']),
  active: z.boolean(),
  attentionState: z.enum(['pending', 'delivered', 'acknowledged', 'settled']),
  sourceAsOf: timestampSchema.nullable(),
  summary: paymentSummarySchema,
  obligation: obligationSchema,
  evidence: paymentEvidenceSummarySchema.nullable(),
  owlUrl: z.url().refine((value) => value.startsWith('https://') || value.startsWith('http://localhost')),
  sourceActions: z.array(sourceActionSchema).max(12),
}).superRefine((value, context) => {
  if (value.sourceActions.some((action) => action.expectedRevision !== value.revision)) {
    context.addIssue({ code: 'custom', path: ['sourceActions'], message: 'Action revision mismatch' });
  }
  if (!value.active && value.state !== 'resolved') {
    context.addIssue({ code: 'custom', path: ['active'], message: 'Inactive cases must be resolved' });
  }
});

export const paymentReviewPageSchema = z.strictObject({
  contractVersion: z.literal(RECEIPT_RECONCILIATION_CONTRACT_VERSION),
  state: z.enum(['ready', 'empty', 'unavailable']),
  items: z.array(paymentReviewItemSchema).max(RECEIPT_RECONCILIATION_PAGE_LIMIT),
  offset: z.number().int().safe().nonnegative(),
  nextOffset: z.number().int().safe().nonnegative().nullable(),
  unavailableReason: z.string().trim().min(1).max(240).nullable(),
}).superRefine((value, context) => {
  if (new Set(value.items.map((item) => item.id)).size !== value.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'Review IDs must be unique' });
  }
  if (value.state === 'unavailable' && value.unavailableReason === null) {
    context.addIssue({ code: 'custom', path: ['unavailableReason'], message: 'Unavailable reason required' });
  }
});

export const paymentReviewActionRequestSchema = z.strictObject({
  action: paymentCaseActionSchema.exclude(['deliver_attention', 'acknowledge_attention']),
  expectedRevision: z.number().int().safe().positive(),
  evidenceId: identifierSchema.optional(),
  replacementEvidenceId: identifierSchema.optional(),
  allocatedAmountMinor: amountMinorSchema.optional(),
  deferUntil: timestampSchema.optional(),
  note: z.string().trim().min(1).max(500).optional(),
}).superRefine((value, context) => {
  if (['confirm', 'reject', 'clear', 'mark_not_applicable'].includes(value.action) && !value.evidenceId) {
    context.addIssue({ code: 'custom', path: ['evidenceId'], message: `${value.action} requires evidenceId` });
  }
  if (value.action === 'replace' && (!value.evidenceId || !value.replacementEvidenceId)) {
    context.addIssue({ code: 'custom', path: ['replacementEvidenceId'], message: 'replace requires both evidence IDs' });
  }
  if (value.action === 'defer' && !value.deferUntil) {
    context.addIssue({ code: 'custom', path: ['deferUntil'], message: 'defer requires deferUntil' });
  }
});

export const paymentReviewActionResultSchema = z.strictObject({
  contractVersion: z.literal(RECEIPT_RECONCILIATION_CONTRACT_VERSION),
  action: paymentCaseActionSchema,
  item: paymentReviewItemSchema,
  sourceAcknowledgement: z.enum([
    'not_required',
    'acknowledged',
    'pending_verification',
    'failed',
  ]),
  authoritativeReadBack: z.literal(true),
  idempotent: z.boolean(),
});

export type PaymentCaseAction = z.infer<typeof paymentCaseActionSchema>;
export type PaymentEvidenceSummary = z.infer<typeof paymentEvidenceSummarySchema>;
export type PaymentReviewItem = z.infer<typeof paymentReviewItemSchema>;
export type PaymentReviewPage = z.infer<typeof paymentReviewPageSchema>;
export type PaymentReviewActionRequest = z.infer<typeof paymentReviewActionRequestSchema>;
export type PaymentReviewActionResult = z.infer<typeof paymentReviewActionResultSchema>;
