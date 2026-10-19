import { createHash } from 'node:crypto';
import { z } from 'zod';

export const STATEMENT_DESCRIPTOR_MAX_BYTES = 2_048;
export const STATEMENT_DESCRIPTOR_MAX_ITEMS = 2;

const exactDescriptorTextSchema = z.string()
  .min(1)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    'Descriptor text contains control characters',
  )
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= STATEMENT_DESCRIPTOR_MAX_BYTES,
    `Descriptor text exceeds ${STATEMENT_DESCRIPTOR_MAX_BYTES} UTF-8 bytes`,
  );

export const bridgeStatementDescriptorSchema = z.object({
  kind: z.enum(['statement', 'provider-description']),
  text: exactDescriptorTextSchema,
  source: z.object({
    system: z.literal('monarch'),
    field: z.enum(['plaidName', 'dataProviderDescription']),
  }).strict(),
}).strict();

export const statementDescriptorsSchema = z.array(bridgeStatementDescriptorSchema)
  .max(STATEMENT_DESCRIPTOR_MAX_ITEMS)
  .superRefine((descriptors, context) => {
    const kinds = new Set<string>();
    for (const [index, descriptor] of descriptors.entries()) {
      if (kinds.has(descriptor.kind)) {
        context.addIssue({
          code: 'custom',
          message: 'Descriptor kinds must be unique',
          path: [index, 'kind'],
        });
      }
      kinds.add(descriptor.kind);
      const expected = descriptor.kind === 'statement'
        ? 'plaidName'
        : 'dataProviderDescription';
      if (descriptor.source.field !== expected) {
        context.addIssue({
          code: 'custom',
          message: `Descriptor source field must be ${expected}`,
          path: [index, 'source', 'field'],
        });
      }
    }
  });

export const normalizedLocationEvidenceSchema = z.object({
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  region: z.string().trim().min(1).max(80),
  locality: z.string().trim().min(1).max(80).nullable(),
  confidence: z.number().min(0).max(1),
  sourceKind: z.enum(['private-ai-inference', 'user-confirmed']),
  model: z.string().trim().min(1).max(120).nullable(),
  modelVersion: z.string().trim().min(1).max(120).nullable(),
  evaluatedAt: z.iso.datetime({ offset: true }),
  staleAfter: z.iso.datetime({ offset: true }),
}).strict().superRefine((evidence, context) => {
  if (Date.parse(evidence.staleAfter) <= Date.parse(evidence.evaluatedAt)) {
    context.addIssue({
      code: 'custom',
      message: 'staleAfter must be later than evaluatedAt',
      path: ['staleAfter'],
    });
  }
  const privateInference = evidence.sourceKind === 'private-ai-inference';
  if (
    (privateInference && (!evidence.model || !evidence.modelVersion))
    || (!privateInference && (evidence.model !== null || evidence.modelVersion !== null))
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Location source and model provenance are inconsistent',
      path: ['sourceKind'],
    });
  }
});

export type BridgeStatementDescriptor = z.infer<typeof bridgeStatementDescriptorSchema>;
export type NormalizedLocationEvidence = z.infer<typeof normalizedLocationEvidenceSchema>;

export function descriptorEvidenceFingerprint(
  descriptors: readonly BridgeStatementDescriptor[],
): string {
  return createHash('sha256').update(JSON.stringify(descriptors)).digest('hex');
}

export function attributionStatementDescriptors(
  descriptors: readonly BridgeStatementDescriptor[],
): Array<{
  kind: BridgeStatementDescriptor['kind'];
  text: string;
  source: 'monarch';
}> {
  return descriptors.map(({ kind, text }) => ({ kind, text, source: 'monarch' }));
}
