import { z } from 'zod';

export const payeeActivitySchema = z.enum(['active', 'inactive', 'unknown']);
export const payeeClassificationSchema = z.enum([
  'recurring-fixed',
  'recurring-variable',
  'regular',
  'infrequent',
  'single-observation',
  'unknown',
]);
export const documentPolicyStatusSchema = z.enum([
  'unreviewed',
  'mapped',
  'not-expected',
  'unavailable',
]);

export const payeePatternEvidenceSchema = z.object({
  payeeRef: z.string().min(1),
  displayName: z.string().min(1),
  activity: payeeActivitySchema,
  classification: payeeClassificationSchema,
  observationCount: z.number().int().nonnegative(),
  observationWindow: z.object({
    firstObservedOn: z.string().min(1),
    lastObservedOn: z.string().min(1),
  }),
  intervalEvidence: z.object({
    sampleCount: z.number().int().nonnegative(),
    medianDays: z.number().nonnegative(),
    minimumDays: z.number().nonnegative(),
    maximumDays: z.number().nonnegative(),
  }).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  basis: z.array(z.string()),
  provenance: z.object({
    transactionHistory: z.literal(true),
    monarchRecurring: z.boolean(),
  }),
  monarchConfirmedRecurring: z.object({
    active: z.boolean(),
    cadence: z.string().nullable(),
  }).nullable(),
});

export const documentPolicySchema = z.object({
  status: documentPolicyStatusSchema,
  correspondentRef: z.string().min(1).nullable(),
  correspondentName: z.string().min(1).nullable(),
  expectationSummary: z.string().min(1).nullable(),
  owlPolicyUrl: z.string().url().nullable(),
});

export const payeeDocumentReviewItemSchema = z.object({
  candidateId: z.string().min(1),
  pattern: payeePatternEvidenceSchema,
  documentPolicy: documentPolicySchema,
});

export const paperlessCorrespondentSchema = z.object({
  correspondentRef: z.string().min(1),
  name: z.string().min(1),
});

export const payeeDocumentReviewSnapshotSchema = z.object({
  contractVersion: z.literal('1'),
  state: z.enum(['ready', 'empty', 'unavailable']),
  sourceAsOf: z.string().nullable(),
  items: z.array(payeeDocumentReviewItemSchema),
  correspondents: z.array(paperlessCorrespondentSchema),
  unavailableReason: z.string().nullable(),
});

export const payeeDocumentReviewDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    candidateId: z.string().min(1),
    decision: z.literal('map-correspondent'),
    correspondentRef: z.string().min(1),
  }),
  z.object({
    candidateId: z.string().min(1),
    decision: z.literal('no-documents-expected'),
  }),
]);

export const payeeDocumentReviewDecisionResultSchema = z.object({
  candidateId: z.string().min(1),
  acknowledged: z.literal(true),
  documentPolicy: documentPolicySchema,
});

export type PayeeActivity = z.infer<typeof payeeActivitySchema>;
export type PayeeClassification = z.infer<typeof payeeClassificationSchema>;
export type DocumentPolicyStatus = z.infer<typeof documentPolicyStatusSchema>;
export type PayeePatternEvidence = z.infer<typeof payeePatternEvidenceSchema>;
export type DocumentPolicy = z.infer<typeof documentPolicySchema>;
export type PayeeDocumentReviewItem = z.infer<typeof payeeDocumentReviewItemSchema>;
export type PaperlessCorrespondent = z.infer<typeof paperlessCorrespondentSchema>;
export type PayeeDocumentReviewSnapshot = z.infer<typeof payeeDocumentReviewSnapshotSchema>;
export type PayeeDocumentReviewDecision = z.infer<typeof payeeDocumentReviewDecisionSchema>;
export type PayeeDocumentReviewDecisionResult = z.infer<
  typeof payeeDocumentReviewDecisionResultSchema
>;
