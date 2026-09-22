import 'server-only';

import logger from '@/lib/logger';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  insightOccurrenceSummarySchema,
  type InsightOccurrenceSummaryV1,
} from './contract';
import { financeInsightOccurrenceRevisionDigest } from './occurrence-shared';

export const FINANCE_INSIGHT_OCCURRENCE_CACHE_LIMIT = 500;
export const FINANCE_INSIGHT_OCCURRENCE_TOMBSTONE_LIMIT = 1_000;
export const FINANCE_INSIGHT_SUMMARY_CACHE_MS = 7 * 24 * 60 * 60 * 1_000;
export const FINANCE_INSIGHT_SUMMARY_PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const FINANCE_INSIGHT_TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export type FinanceInsightOccurrenceCache =
  | {
      state: 'available';
      alertCapable: boolean;
      sourceGeneration: string;
      items: InsightOccurrenceSummaryV1[];
    }
  | {
      state: 'metadata-only';
      alertCapable: false;
      sourceGeneration: string;
      items: Array<Pick<
        InsightOccurrenceSummaryV1,
        'occurrenceId' | 'insightId' | 'kind' | 'sourceLifecycle' | 'updatedAt'
      >>;
    }
  | {
      state: 'unavailable';
      alertCapable: false;
      sourceGeneration: null;
      items: [];
    };

export async function pruneFinanceInsightOccurrenceCache(now = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  const payloadCutoff = new Date(
    now.getTime() - FINANCE_INSIGHT_SUMMARY_PAYLOAD_RETENTION_MS,
  ).toISOString();
  const tombstoneCutoff = new Date(
    now.getTime() - FINANCE_INSIGHT_TOMBSTONE_RETENTION_MS,
  ).toISOString();
  try {
    const { finance } = await getWorkerPersistenceRepositories();
    await finance.insights.occurrenceCache.prune(timestamp, payloadCutoff, tombstoneCutoff);
  } catch {
    logger.warn(
      { code: 'finance_insight_cache_prune_failed' },
      'Finance insight occurrence cache pruning failed',
    );
  }
}

export async function replaceFinanceInsightOccurrenceCache(input: {
  connectorId: string;
  sourceGeneration: string;
  sourceSequence: number;
  sourceAsOf: string;
  items: readonly InsightOccurrenceSummaryV1[];
  now?: Date;
}): Promise<void> {
  if (input.items.length > FINANCE_INSIGHT_OCCURRENCE_CACHE_LIMIT) {
    throw new Error('Finance insight occurrence cache exceeds the row limit');
  }
  if (!Number.isSafeInteger(input.sourceSequence) || input.sourceSequence < 1) {
    throw new Error('Finance insight occurrence cache sequence is invalid');
  }
  const now = input.now ?? new Date();
  const sourceAsOfTime = Date.parse(input.sourceAsOf);
  if (
    !Number.isFinite(sourceAsOfTime)
    || sourceAsOfTime > now.getTime()
  ) {
    throw new Error('Finance insight occurrence cache timestamp is invalid');
  }
  const items = input.items.map((item) => insightOccurrenceSummarySchema.parse(item));
  if (new Set(items.map((item) => item.occurrenceId)).size !== items.length) {
    throw new Error('Finance insight occurrence cache contains duplicate occurrences');
  }
  if (items.some((item) => (
    item.provenance.connectorRef !== input.connectorId
    || item.provenance.sourceGeneration !== input.sourceGeneration
    || item.provenance.sourceAsOf !== input.sourceAsOf
  ))) {
    throw new Error('Finance insight occurrence cache identity is invalid');
  }
  const refreshedAt = now.toISOString();
  const summaryExpiresAt = new Date(
    sourceAsOfTime + FINANCE_INSIGHT_SUMMARY_CACHE_MS,
  ).toISOString();
  const purgeAfter = new Date(
    sourceAsOfTime + FINANCE_INSIGHT_TOMBSTONE_RETENTION_MS,
  ).toISOString();
  const { finance } = await getWorkerPersistenceRepositories();
  await finance.insights.occurrenceCache.replace({
    connectorId: input.connectorId,
    sourceGeneration: input.sourceGeneration,
    sourceSequence: input.sourceSequence,
    sourceAsOf: input.sourceAsOf,
    refreshedAt,
    summaryExpiresAt,
    purgeAfter,
    tombstoneLimit: FINANCE_INSIGHT_OCCURRENCE_TOMBSTONE_LIMIT,
    items: items.map((item) => ({
      occurrenceId: item.occurrenceId,
      insightId: item.insightId,
      deliveryRevision: item.deliveryRevision,
      revisionDigest: financeInsightOccurrenceRevisionDigest(item),
      kind: item.kind,
      entityKind: item.entity.kind,
      entitySourceRef: item.entity.sourceRef,
      entityLabel: item.entity.displayName,
      analysisState: item.analysisState,
      sourceLifecycle: item.sourceLifecycle,
      severity: item.severity,
      confidence: item.confidence,
      baselineSufficiency: item.baselineSufficiency,
      headline: item.headline,
      freshnessState: item.freshness.state,
      freshnessSourceAsOf: item.freshness.sourceAsOf,
      targetDescriptors: item.targets,
      summaryPayload: item,
      updatedAt: item.updatedAt,
    })),
  });
}

export async function readFinanceInsightOccurrenceCache(
  connectorId: string,
  now = new Date(),
): Promise<FinanceInsightOccurrenceCache> {
  await pruneFinanceInsightOccurrenceCache(now);
  const { finance } = await getWorkerPersistenceRepositories();
  const state = await finance.insights.occurrenceCache.readState(connectorId);
  if (!state) {
    return { state: 'unavailable', alertCapable: false, sourceGeneration: null, items: [] };
  }
  const rows = await finance.insights.occurrenceCache.readCurrentGenerationRows(
    connectorId,
    state.sourceGeneration,
    FINANCE_INSIGHT_OCCURRENCE_CACHE_LIMIT,
  );
  if (Date.parse(state.summaryExpiresAt) < now.getTime()) {
    return {
      state: 'metadata-only',
      alertCapable: false,
      sourceGeneration: state.sourceGeneration,
      items: rows.map(({ occurrenceId, insightId, kind, sourceLifecycle, updatedAt }) => ({
        occurrenceId,
        insightId,
        kind: kind as InsightOccurrenceSummaryV1['kind'],
        sourceLifecycle: sourceLifecycle as InsightOccurrenceSummaryV1['sourceLifecycle'],
        updatedAt,
      })),
    };
  }
  const items = rows.map((row) => insightOccurrenceSummarySchema.parse(row.summaryPayload));
  const alertCapable = items.every((item) => (
    item.freshness.state === 'fresh'
    && item.provenance.completeness === 'complete'
    && item.freshness.sourceAsOf !== null
    && Date.parse(item.freshness.sourceAsOf) <= now.getTime()
    && now.getTime() - Date.parse(item.freshness.sourceAsOf)
      <= item.freshness.maxAgeHours * 60 * 60 * 1_000
  ));
  return {
    state: 'available',
    alertCapable,
    sourceGeneration: state.sourceGeneration,
    items,
  };
}
