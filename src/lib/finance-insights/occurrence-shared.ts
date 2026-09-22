import { financeInsightDigestV1, type CanonicalJsonValue } from './canonical';
import {
  insightOccurrenceSummarySchema,
  type InsightOccurrenceSummaryV1,
} from './contract';

export function financeInsightOccurrenceRevisionDigest(
  value: InsightOccurrenceSummaryV1 | unknown,
): string {
  const item = insightOccurrenceSummarySchema.parse(value);
  return financeInsightDigestV1({
    insightId: item.insightId,
    occurrenceId: item.occurrenceId,
    deliveryRevision: item.deliveryRevision,
    kind: item.kind,
    entity: item.entity,
    reasonCodes: item.reasonCodes,
    observationPeriod: item.observationPeriod,
    baselinePeriod: item.baselinePeriod,
    observedValue: item.observedValue,
    expectedRange: item.expectedRange,
    absoluteDelta: item.absoluteDelta,
    percentageDeltaBasisPoints: item.percentageDeltaBasisPoints,
    currency: item.currency,
    analysisState: item.analysisState,
    severity: item.severity,
    confidence: item.confidence,
    baselineSufficiency: item.baselineSufficiency,
    headline: item.headline,
    explanation: item.explanation,
    targets: item.targets,
  } as CanonicalJsonValue);
}
