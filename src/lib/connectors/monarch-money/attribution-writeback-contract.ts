import 'server-only';

import { z } from 'zod';
import { attributionBatchItemSchema } from './attribution-contract';

export const attributionActionRequestSchema = z.object({
  contractVersion: z.literal('2.1'),
  provenance: z.literal('mission-control-normalized-v2'),
  sourceRef: z.string().min(1).max(128),
  expectedPolicyVersion: z.number().int().positive(),
  expectedStateVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(200),
  confirm: z.literal(true),
  action: z.enum(['assign-kid', 'mark-parent-expense']),
  kidId: z.string().min(1).max(128).optional(),
}).strict().superRefine((value, context) => {
  if ((value.action === 'assign-kid') !== (value.kidId !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Kid identifier must match action' });
  }
});

const engineAttributionSchema = z.object({
  contractVersion: z.literal('2.1'),
  sourceRef: z.string().min(1),
  status: z.enum(['attributed', 'pending', 'unassigned']),
  kidId: z.string().nullable(),
  confidence: z.enum(['definite', 'likely', 'none']),
  method: z.enum(['manual', 'account-default', 'merchant-rule', 'historical-pattern', 'unassigned', 'unavailable']),
  explanation: z.string().min(1).max(240),
  review: z.object({
    status: z.enum(['not-required', 'pending', 'resolved']),
    reasons: z.array(z.string()),
  }),
  provenance: z.object({
    decisionSource: z.enum(['manual', 'automated', 'fallback']),
    policyVersion: z.number().int().positive().nullable(),
    engineVersion: z.literal('2.1.0'),
    evaluatedAt: z.string().datetime({ offset: true }),
  }),
});

export const tagProjectionSchema = z.object({
  sourceRef: z.string().min(1),
  decisionVersion: z.string().regex(/^state:\d{16}$/),
  kidIds: z.array(z.string()),
  managedTagIds: z.array(z.string()),
  status: z.enum(['pending', 'projected', 'failed', 'drift']),
  errorCode: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});

export const attributionRecordResponseSchema = z.object({
  contractVersion: z.literal('2.1'),
  record: z.object({
    input: z.object({
      source: z.object({ recordRef: z.string().min(1) }),
      existingManualDecision: z.object({
        action: z.enum(['assign-kid', 'parent-expense', 'unassign']),
        kidId: z.string().nullable(),
      }).nullable(),
    }),
    attribution: engineAttributionSchema,
    stateVersion: z.number().int().positive(),
  }),
  projection: tagProjectionSchema.nullable(),
});

export const attributionActionResponseSchema = z.object({
  contractVersion: z.literal('2.1'),
  sourceRef: z.string().min(1),
  stateVersion: z.number().int().positive(),
  attribution: engineAttributionSchema,
  projection: tagProjectionSchema.nullable(),
});

export const attributionRecordRequestSchema = z.object({
  contractVersion: z.literal('2.1'),
  provenance: z.literal('mission-control-normalized-v3'),
  expectedPolicyVersion: z.number().int().positive(),
  expectedStateVersion: z.number().int().positive().nullable(),
  transactionId: z.string().min(1).max(128),
  item: attributionBatchItemSchema,
}).strict();

export type AttributionActionRequest = z.infer<typeof attributionActionRequestSchema>;
export type AttributionRecordRequest = z.infer<typeof attributionRecordRequestSchema>;
export type AttributionRecordResponse = z.infer<typeof attributionRecordResponseSchema>;
export type TagProjection = z.infer<typeof tagProjectionSchema>;

export function attributionProjectionVersion(stateVersion: number): string {
  return `state:${String(stateVersion).padStart(16, '0')}`;
}
