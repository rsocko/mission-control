import 'server-only';

import { z } from 'zod';

export const TYRION_ATTRIBUTION_CONTRACT_VERSION = '1.0';
export const TYRION_ATTRIBUTION_ENGINE_VERSION = '1.0.0';
export const TYRION_ATTRIBUTION_PROVENANCE = 'mission-control-normalized-v1';
export const TYRION_ATTRIBUTION_PATH = '/api/internal/v1/attribution/batch';
export const TYRION_ATTRIBUTION_MAX_ITEMS = 100;
export const TYRION_ATTRIBUTION_MAX_BODY_BYTES = 65_536;
export const TYRION_ATTRIBUTION_MAX_RESPONSE_BYTES = 262_144;

const identifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value));
const timestampSchema = z.string().datetime({ offset: true });
const reasonSchema = z.enum([
  'no-match',
  'low-confidence',
  'card-rule-conflict',
  'merchant-rule-conflict',
  'historical-attribution-tie',
  'engine-unavailable',
  'policy-unavailable',
  'policy-version-mismatch',
]);

export const manualDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('assign-kid'),
    kidId: identifierSchema,
    decidedAt: timestampSchema,
  }).strict(),
  z.object({
    action: z.literal('parent-expense'),
    kidId: z.null(),
    decidedAt: timestampSchema,
  }).strict(),
]).nullable();

export const attributionBatchItemSchema = z.object({
  sourceRef: identifierSchema,
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  merchantName: z.string().min(1).max(160),
  instrumentFingerprint: z.string()
    .regex(/^instrument-v1:[A-Za-z0-9_-]{43}$/)
    .nullable(),
  observedAt: timestampSchema,
  existingManualDecision: manualDecisionSchema,
}).strict();

export const attributionBatchRequestSchema = z.object({
  contractVersion: z.literal(TYRION_ATTRIBUTION_CONTRACT_VERSION),
  provenance: z.literal(TYRION_ATTRIBUTION_PROVENANCE),
  expectedPolicyVersion: z.number().int().positive().nullable(),
  items: z.array(attributionBatchItemSchema)
    .min(1)
    .max(TYRION_ATTRIBUTION_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  const refs = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (refs.has(item.sourceRef)) {
      context.addIssue({
        code: 'custom',
        message: 'sourceRef values must be unique',
        path: ['items', index, 'sourceRef'],
      });
    }
    refs.add(item.sourceRef);
  }
});

export const attributionBatchResultSchema = z.object({
  contractVersion: z.literal(TYRION_ATTRIBUTION_CONTRACT_VERSION),
  sourceRef: identifierSchema,
  status: z.enum(['attributed', 'unassigned', 'pending']),
  kidId: identifierSchema.nullable(),
  confidence: z.enum(['definite', 'likely', 'none']),
  method: z.enum([
    'manual',
    'card-rule',
    'merchant-rule',
    'historical-pattern',
    'unassigned',
    'unavailable',
  ]),
  explanation: z.string().min(1).max(240),
  reviewStatus: z.enum(['not-required', 'pending', 'resolved']),
  reasons: z.array(reasonSchema).max(8),
  decisionSource: z.enum(['manual', 'automated', 'fallback']),
  policyVersion: z.number().int().positive(),
  engineVersion: z.literal(TYRION_ATTRIBUTION_ENGINE_VERSION),
  evaluatedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if (value.status === 'attributed' && value.kidId === null) {
    context.addIssue({
      code: 'custom',
      message: 'Attributed results require a kid identifier',
      path: ['kidId'],
    });
  }
  if (value.status === 'unassigned' && value.kidId !== null) {
    context.addIssue({
      code: 'custom',
      message: 'Unassigned results cannot include a kid identifier',
      path: ['kidId'],
    });
  }
  if (
    (value.method === 'manual' && value.decisionSource !== 'manual')
    || (value.method !== 'manual' && value.decisionSource === 'manual')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Manual method and decision source must agree',
      path: ['decisionSource'],
    });
  }
});

export const attributionBatchResponseSchema = z.object({
  contractVersion: z.literal(TYRION_ATTRIBUTION_CONTRACT_VERSION),
  policyVersion: z.number().int().positive(),
  engineVersion: z.literal(TYRION_ATTRIBUTION_ENGINE_VERSION),
  results: z.array(attributionBatchResultSchema)
    .min(1)
    .max(TYRION_ATTRIBUTION_MAX_ITEMS),
}).strict();

export const attributionErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().max(240),
  }).strict(),
}).strict();

export type AttributionBatchItem = z.infer<typeof attributionBatchItemSchema>;
export type AttributionBatchRequest = z.infer<typeof attributionBatchRequestSchema>;
export type AttributionBatchResult = z.infer<typeof attributionBatchResultSchema>;
export type AttributionBatchResponse = z.infer<typeof attributionBatchResponseSchema>;
export type ManualDecision = z.infer<typeof manualDecisionSchema>;
