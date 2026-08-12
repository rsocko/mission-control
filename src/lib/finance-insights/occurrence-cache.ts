import 'server-only';

import { sqlite } from '@/db';
import logger from '@/lib/logger';
import {
  insightOccurrenceSummarySchema,
  type InsightOccurrenceSummaryV1,
} from './contract';
import { financeInsightDigestV1, type CanonicalJsonValue } from './canonical';

export const FINANCE_INSIGHT_OCCURRENCE_CACHE_LIMIT = 500;
export const FINANCE_INSIGHT_OCCURRENCE_TOMBSTONE_LIMIT = 1_000;
export const FINANCE_INSIGHT_SUMMARY_CACHE_MS = 7 * 24 * 60 * 60 * 1_000;
export const FINANCE_INSIGHT_SUMMARY_PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const FINANCE_INSIGHT_TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

function occurrenceRevisionDigest(item: InsightOccurrenceSummaryV1): string {
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

export function pruneFinanceInsightOccurrenceCache(now = new Date()): void {
  const timestamp = now.toISOString();
  const payloadCutoff = new Date(
    now.getTime() - FINANCE_INSIGHT_SUMMARY_PAYLOAD_RETENTION_MS,
  ).toISOString();
  const tombstoneCutoff = new Date(
    now.getTime() - FINANCE_INSIGHT_TOMBSTONE_RETENTION_MS,
  ).toISOString();
  try {
    sqlite.transaction(() => {
      sqlite.prepare(`
        UPDATE finance_insight_occurrences
        SET entity_label = '', headline = '', target_descriptors = '[]',
            summary_payload = NULL
        WHERE cached_at < ?
      `).run(payloadCutoff);
      sqlite.prepare(`
        DELETE FROM finance_insight_occurrences
        WHERE is_tombstone = 1
          AND source_lifecycle IN ('resolved', 'superseded')
          AND source_updated_at < ?
      `).run(tombstoneCutoff);
      sqlite.prepare(`
        DELETE FROM finance_insight_occurrences
        WHERE connector_id IN (
          SELECT connector_id FROM finance_insight_occurrence_cache_state
          WHERE purge_after < ?
        )
      `).run(timestamp);
      sqlite.prepare(`
        DELETE FROM finance_insight_occurrence_cache_state WHERE purge_after < ?
      `).run(timestamp);
    }).immediate();
  } catch {
    logger.warn(
      { code: 'finance_insight_cache_prune_failed' },
      'Finance insight occurrence cache pruning failed',
    );
  }
}

export function replaceFinanceInsightOccurrenceCache(input: {
  connectorId: string;
  sourceGeneration: string;
  sourceSequence: number;
  sourceAsOf: string;
  items: readonly InsightOccurrenceSummaryV1[];
  now?: Date;
}): void {
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
  sqlite.transaction(() => {
    const previousState = sqlite.prepare(`
      SELECT source_generation AS sourceGeneration, source_sequence AS sourceSequence,
             source_as_of AS sourceAsOf,
             summary_expires_at AS summaryExpiresAt
      FROM finance_insight_occurrence_cache_state WHERE connector_id = ?
    `).get(input.connectorId) as {
      sourceGeneration: string;
      sourceSequence: number;
      sourceAsOf: string;
      summaryExpiresAt: string;
    } | undefined;
    if (previousState) {
      const previousSourceAsOf = Date.parse(previousState.sourceAsOf);
      if (
        previousState.sourceSequence > 0
        && previousState.sourceGeneration === input.sourceGeneration
        && (
          previousState.sourceSequence !== input.sourceSequence
          || previousState.sourceAsOf !== input.sourceAsOf
        )
      ) {
        throw new Error('Finance insight occurrence cache identity is immutable');
      }
      if (
        input.sourceSequence < previousState.sourceSequence
        || sourceAsOfTime < previousSourceAsOf
      ) {
        throw new Error('Finance insight occurrence cache generation is stale');
      }
      if (
        input.sourceSequence === previousState.sourceSequence
        && previousState.sourceGeneration !== input.sourceGeneration
      ) {
        throw new Error('Finance insight occurrence cache generation conflicts');
      }
    }
    const previousRows = sqlite.prepare(`
      SELECT occurrence_id AS occurrenceId, delivery_revision AS deliveryRevision,
             revision_digest AS revisionDigest, summary_payload AS summaryPayload,
             source_generation AS sourceGeneration, source_sequence AS sourceSequence,
             is_tombstone AS isTombstone,
             source_lifecycle AS sourceLifecycle, source_updated_at AS sourceUpdatedAt
      FROM finance_insight_occurrences WHERE connector_id = ?
    `).all(input.connectorId) as Array<{
      occurrenceId: string;
      deliveryRevision: number;
      revisionDigest: string;
      isTombstone: number;
      summaryPayload: string | null;
      sourceGeneration: string;
      sourceSequence: number;
      sourceLifecycle: InsightOccurrenceSummaryV1['sourceLifecycle'];
      sourceUpdatedAt: string;
    }>;
    const previousByOccurrence = new Map(
      previousRows.map((row) => [row.occurrenceId, row]),
    );
    const previousCurrentRowCount = previousRows.filter(
      (row) => row.sourceGeneration === input.sourceGeneration && row.isTombstone === 0,
    ).length;
    for (const item of items) {
      const previous = previousByOccurrence.get(item.occurrenceId);
      if (previous && item.deliveryRevision < previous.deliveryRevision) {
        throw new Error('Finance insight occurrence cache revision is stale');
      }
      if (previous && Date.parse(item.updatedAt) < Date.parse(previous.sourceUpdatedAt)) {
        throw new Error('Finance insight occurrence cache revision is stale');
      }
      const revisionDigest = occurrenceRevisionDigest(item);
      const previousRevisionDigest = previous?.revisionDigest || (
        previous?.summaryPayload
          ? occurrenceRevisionDigest(
              insightOccurrenceSummarySchema.parse(JSON.parse(previous.summaryPayload)),
            )
          : null
      );
      if (
        previous
        && item.deliveryRevision === previous.deliveryRevision
        && revisionDigest !== previousRevisionDigest
      ) {
        throw new Error('Finance insight occurrence cache revision conflicts');
      }
      if (
        previous
        && item.deliveryRevision === previous.deliveryRevision
        && previous.sourceLifecycle !== 'open'
        && item.sourceLifecycle === 'open'
      ) {
        throw new Error('Finance insight occurrence cache lifecycle is stale');
      }
    }
    if (
      previousState?.sourceGeneration === input.sourceGeneration
      && previousState.sourceSequence === input.sourceSequence
      && previousState.sourceAsOf === input.sourceAsOf
      && previousCurrentRowCount === items.length
      && items.every((item) => (
        previousByOccurrence.get(item.occurrenceId)?.summaryPayload === JSON.stringify(item)
        && previousByOccurrence.get(item.occurrenceId)?.sourceGeneration === input.sourceGeneration
        && previousByOccurrence.get(item.occurrenceId)?.sourceSequence === input.sourceSequence
        && previousByOccurrence.get(item.occurrenceId)?.revisionDigest
          === occurrenceRevisionDigest(item)
      ))
    ) {
      sqlite.prepare(`
        UPDATE finance_insight_occurrences
        SET cached_at = ?
        WHERE connector_id = ? AND source_generation = ? AND is_tombstone = 0
      `).run(refreshedAt, input.connectorId, input.sourceGeneration);
      sqlite.prepare(`
        UPDATE finance_insight_occurrence_cache_state
        SET refreshed_at = ?, updated_at = ?
        WHERE connector_id = ?
      `).run(refreshedAt, refreshedAt, input.connectorId);
      return;
    }
    sqlite.prepare(`
      DELETE FROM finance_insight_occurrences
      WHERE connector_id = ?
        AND (source_lifecycle IS NULL OR source_lifecycle NOT IN ('resolved', 'superseded'))
    `).run(input.connectorId);
    sqlite.prepare(`
      UPDATE finance_insight_occurrences
      SET is_tombstone = 1
      WHERE connector_id = ?
        AND source_lifecycle IN ('resolved', 'superseded')
    `).run(input.connectorId);
    const insert = sqlite.prepare(`
      INSERT INTO finance_insight_occurrences (
        connector_id, occurrence_id, source_generation, source_sequence, is_tombstone,
        insight_id, delivery_revision, revision_digest, kind,
        entity_kind, entity_source_ref, entity_label, analysis_state,
        source_lifecycle, severity, confidence, baseline_sufficiency, headline,
        freshness_state, source_as_of, target_descriptors, summary_payload,
        source_updated_at, cached_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connector_id, occurrence_id) DO UPDATE SET
        source_generation = excluded.source_generation,
        source_sequence = excluded.source_sequence,
        is_tombstone = 0,
        insight_id = excluded.insight_id,
        delivery_revision = excluded.delivery_revision,
        revision_digest = excluded.revision_digest,
        kind = excluded.kind,
        entity_kind = excluded.entity_kind,
        entity_source_ref = excluded.entity_source_ref,
        entity_label = excluded.entity_label,
        analysis_state = excluded.analysis_state,
        source_lifecycle = excluded.source_lifecycle,
        severity = excluded.severity,
        confidence = excluded.confidence,
        baseline_sufficiency = excluded.baseline_sufficiency,
        headline = excluded.headline,
        freshness_state = excluded.freshness_state,
        source_as_of = excluded.source_as_of,
        target_descriptors = excluded.target_descriptors,
        summary_payload = excluded.summary_payload,
        source_updated_at = excluded.source_updated_at,
        cached_at = excluded.cached_at
    `);
    for (const item of items) {
      insert.run(
        input.connectorId,
        item.occurrenceId,
        input.sourceGeneration,
        input.sourceSequence,
        item.insightId,
        item.deliveryRevision,
        occurrenceRevisionDigest(item),
        item.kind,
        item.entity.kind,
        item.entity.sourceRef,
        item.entity.displayName,
        item.analysisState,
        item.sourceLifecycle,
        item.severity,
        item.confidence,
        item.baselineSufficiency,
        item.headline,
        item.freshness.state,
        item.freshness.sourceAsOf,
        JSON.stringify(item.targets),
        JSON.stringify(item),
        item.updatedAt,
        refreshedAt,
      );
    }
    sqlite.prepare(`
      UPDATE finance_insight_occurrences
      SET entity_label = '', headline = '', target_descriptors = '[]',
          summary_payload = NULL
      WHERE connector_id = ?
        AND is_tombstone = 1
        AND source_lifecycle IN ('resolved', 'superseded')
    `).run(input.connectorId);
    sqlite.prepare(`
      DELETE FROM finance_insight_occurrences
      WHERE rowid IN (
        SELECT rowid FROM finance_insight_occurrences
        WHERE connector_id = ?
          AND is_tombstone = 1
          AND source_lifecycle IN ('resolved', 'superseded')
        ORDER BY source_updated_at DESC, occurrence_id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(
      input.connectorId,
      FINANCE_INSIGHT_OCCURRENCE_TOMBSTONE_LIMIT,
    );
    sqlite.prepare(`
      INSERT INTO finance_insight_occurrence_cache_state (
        connector_id, source_generation, item_count, source_as_of, refreshed_at,
        source_sequence, summary_expires_at, purge_after, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connector_id) DO UPDATE SET
        source_generation = excluded.source_generation,
        source_sequence = excluded.source_sequence,
        item_count = excluded.item_count,
        source_as_of = excluded.source_as_of,
        refreshed_at = excluded.refreshed_at,
        summary_expires_at = excluded.summary_expires_at,
        purge_after = excluded.purge_after,
        updated_at = excluded.updated_at
    `).run(
      input.connectorId,
      input.sourceGeneration,
      items.length,
      input.sourceAsOf,
      refreshedAt,
      input.sourceSequence,
      summaryExpiresAt,
      purgeAfter,
      refreshedAt,
      refreshedAt,
    );
  }).immediate();
}

export function readFinanceInsightOccurrenceCache(
  connectorId: string,
  now = new Date(),
): FinanceInsightOccurrenceCache {
  pruneFinanceInsightOccurrenceCache(now);
  const state = sqlite.prepare(`
    SELECT source_generation AS sourceGeneration, source_as_of AS sourceAsOf,
           summary_expires_at AS summaryExpiresAt, purge_after AS purgeAfter
    FROM finance_insight_occurrence_cache_state WHERE connector_id = ?
  `).get(connectorId) as {
    sourceGeneration: string;
    sourceAsOf: string;
    summaryExpiresAt: string;
    purgeAfter: string;
  } | undefined;
  if (!state) {
    return { state: 'unavailable', alertCapable: false, sourceGeneration: null, items: [] };
  }
  const rows = sqlite.prepare(`
    SELECT occurrence_id AS occurrenceId, insight_id AS insightId, kind,
           source_lifecycle AS sourceLifecycle, source_updated_at AS updatedAt,
           summary_payload AS summaryPayload
    FROM finance_insight_occurrences
    WHERE connector_id = ? AND source_generation = ? AND is_tombstone = 0
    ORDER BY source_updated_at DESC, occurrence_id
    LIMIT ?
  `).all(
    connectorId,
    state.sourceGeneration,
    FINANCE_INSIGHT_OCCURRENCE_CACHE_LIMIT,
  ) as Array<{
    occurrenceId: string;
    insightId: string;
    kind: InsightOccurrenceSummaryV1['kind'];
    sourceLifecycle: InsightOccurrenceSummaryV1['sourceLifecycle'];
    updatedAt: string;
    summaryPayload: string | null;
  }>;
  if (Date.parse(state.summaryExpiresAt) < now.getTime()) {
    return {
      state: 'metadata-only',
      alertCapable: false,
      sourceGeneration: state.sourceGeneration,
      items: rows.map(({ occurrenceId, insightId, kind, sourceLifecycle, updatedAt }) => ({
        occurrenceId,
        insightId,
        kind,
        sourceLifecycle,
        updatedAt,
      })),
    };
  }
  const items = rows.map((row) => insightOccurrenceSummarySchema.parse(
    JSON.parse(row.summaryPayload!),
  ));
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
