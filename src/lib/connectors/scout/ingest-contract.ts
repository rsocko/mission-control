import type { MergeableTaskField } from '@/lib/tasks/field-state';

export type ScoutIngestAction =
  | 'created'
  | 'updated'
  | 'skipped'
  | 'linked'
  | 'suppressed'
  | 'triaged';

export interface ScoutIngestResult {
  sourceId: string;
  mcTaskId: string | null;
  action: ScoutIngestAction;
  appliedFields: MergeableTaskField[];
  preservedOverrides: MergeableTaskField[];
  unchangedFields: MergeableTaskField[];
  reason?: string;
  linkedTo?: string;
  triageItemId?: string;
}

export interface ScoutProvenanceInput {
  sourceType: string;
  confidence?: number;
  context?: {
    from?: string;
    sourceSubject?: string;
    extractedAt?: string;
    reasoning?: string;
    confidence?: number;
    originalSource?: Record<string, unknown>;
    relatedSourceIds?: string[];
  };
}

function parseMetadata(metadata: unknown): Record<string, unknown> {
  const parsed = typeof metadata === 'string' ? JSON.parse(metadata) as unknown : metadata;
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Task metadata must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function mergeScoutMetadata(
  currentMetadata: unknown,
  item: ScoutProvenanceInput,
  now: string,
): Record<string, unknown> {
  const current = parseMetadata(currentMetadata);
  const preservedMetadata = { ...current };
  delete preservedMetadata.confidence;
  const currentScoutContext = parseMetadata(current.scoutContext);
  const context = item.context;
  const confidence = item.confidence ?? context?.confidence ?? null;

  return {
    ...preservedMetadata,
    sourceType: item.sourceType,
    scoutContext: {
      confidence,
      reasoning: context?.reasoning ?? null,
      from: context?.from ?? null,
      sourceSubject: context?.sourceSubject ?? null,
      extractedAt: context?.extractedAt ?? currentScoutContext.extractedAt ?? now,
      originalSource: context?.originalSource ?? null,
      relatedSourceIds: context?.relatedSourceIds ?? [],
    },
    ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
  };
}

export function createScoutIngestResult(
  result: Omit<
    ScoutIngestResult,
    'appliedFields' | 'preservedOverrides' | 'unchangedFields'
  > & Partial<Pick<
    ScoutIngestResult,
    'appliedFields' | 'preservedOverrides' | 'unchangedFields'
  >>,
): ScoutIngestResult {
  return {
    ...result,
    appliedFields: result.appliedFields ?? [],
    preservedOverrides: result.preservedOverrides ?? [],
    unchangedFields: result.unchangedFields ?? [],
  };
}
