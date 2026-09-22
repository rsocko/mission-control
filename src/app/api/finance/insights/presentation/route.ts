import { NextResponse } from 'next/server';
import { getPersistedFinanceConnectorConfig } from '@/lib/connectors/monarch-money/config';
import { isTrustedFinanceReadRequest } from '@/lib/connectors/monarch-money/finance-request';
import {
  resolveTyrionFinanceInsightConfig,
  TyrionFinanceInsightClient,
} from '@/lib/finance-insights/client';
import {
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  defaultOccurrenceListQueryV1,
  type InsightOccurrenceSummaryV1,
} from '@/lib/finance-insights/contract';
import {
  readFinanceInsightOccurrenceCache,
  type FinanceInsightOccurrenceCache,
} from '@/lib/finance-insights/occurrence-cache';
import logger from '@/lib/logger';
import type {
  FinanceInsightPresentationState,
  FinanceInsightsPresentationData,
} from '@/components/finance/types';

const PRESENTATION_ITEM_LIMIT = 100;

function response(body: FinanceInsightsPresentationData, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

function emptyPresentation(
  state: FinanceInsightPresentationState,
): FinanceInsightsPresentationData {
  return {
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    state,
    transport: 'none',
    authoritative: false,
    sourceAsOf: null,
    collapsedCount: 0,
    items: [],
  };
}

export function deriveFinanceInsightPresentationState(
  items: readonly InsightOccurrenceSummaryV1[],
): FinanceInsightPresentationState {
  if (items.length === 0) return 'connected';
  const states = new Set(items.map((item) => item.freshness.state));
  if (states.size === 1 && states.has('unavailable')) return 'unavailable';
  if (states.has('partial')) return 'partial';
  if (states.size === 1 && states.has('stale')) return 'stale';
  if (states.has('stale') || states.has('unavailable')) return 'degraded';
  return 'connected';
}

function sourceAsOf(items: readonly InsightOccurrenceSummaryV1[]): string | null {
  const timestamps = items
    .map((item) => item.freshness.sourceAsOf)
    .filter((value): value is string => value !== null)
    .sort();
  return timestamps[0] ?? null;
}

function cachedPresentation(
  cache: FinanceInsightOccurrenceCache,
): FinanceInsightsPresentationData {
  if (cache.state === 'metadata-only') {
    return {
      ...emptyPresentation('stale'),
      transport: 'metadata-only',
      sourceAsOf: null,
      collapsedCount: cache.items.length,
    };
  }
  if (cache.state === 'unavailable') return emptyPresentation('unavailable');
  const now = Date.now();
  const items = cache.items.map((item) => {
    const sourceAsOf = item.freshness.sourceAsOf;
    if (
      item.freshness.state !== 'fresh'
      || sourceAsOf === null
      || Date.parse(sourceAsOf) > now
      || now - Date.parse(sourceAsOf) <= item.freshness.maxAgeHours * 60 * 60 * 1_000
    ) {
      return item;
    }
    return {
      ...item,
      freshness: {
        ...item.freshness,
        state: 'stale' as const,
        warningReason: 'source_stale' as const,
      },
    };
  });
  const derivedState = deriveFinanceInsightPresentationState(items);
  return {
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    state: derivedState === 'connected' ? 'degraded' : derivedState,
    transport: 'cache',
    authoritative: false,
    sourceAsOf: sourceAsOf(items),
    collapsedCount: 0,
    items: items.slice(0, PRESENTATION_ITEM_LIMIT),
  };
}

function mergeItems(
  groups: ReadonlyArray<readonly InsightOccurrenceSummaryV1[]>,
): { items: InsightOccurrenceSummaryV1[]; truncated: boolean } {
  const byOccurrence = new Map<string, InsightOccurrenceSummaryV1>();
  for (const item of groups.flat()) {
    const current = byOccurrence.get(item.occurrenceId);
    if (!current || item.deliveryRevision > current.deliveryRevision) {
      byOccurrence.set(item.occurrenceId, item);
    }
  }
  const items = [...byOccurrence.values()]
    .sort((left, right) => (
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      || left.occurrenceId.localeCompare(right.occurrenceId)
    ));
  return {
    items: items.slice(0, PRESENTATION_ITEM_LIMIT),
    truncated: items.length > PRESENTATION_ITEM_LIMIT,
  };
}

export async function GET(request: Request) {
  if (!isTrustedFinanceReadRequest(request)) {
    return response(emptyPresentation('unavailable'), 403);
  }

  let config;
  try {
    config = await getPersistedFinanceConnectorConfig();
  } catch {
    return response(emptyPresentation('connectorUnavailable'));
  }

  let cache: FinanceInsightOccurrenceCache;
  try {
    cache = await readFinanceInsightOccurrenceCache(config.id);
  } catch (error) {
    logger.warn(
      { code: 'finance_insight_presentation_cache_failed', connectorId: config.id, err: error },
      'Finance insight presentation cache failed',
    );
    cache = { state: 'unavailable', alertCapable: false, sourceGeneration: null, items: [] };
  }

  try {
    const client = new TyrionFinanceInsightClient(resolveTyrionFinanceInsightConfig(config));
    const defaults = defaultOccurrenceListQueryV1();
    const results = await Promise.allSettled([
      client.listOccurrenceSnapshot({
        ...defaults,
        connectorRef: config.id,
        limit: 50,
      }, request.signal),
      client.listOccurrenceSnapshot({
        ...defaults,
        sourceLifecycle: [],
        analysisState: ['insufficientBaseline', 'unavailable'],
        connectorRef: config.id,
        limit: 50,
      }, request.signal),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof client.listOccurrenceSnapshot>>> => (
        result.status === 'fulfilled'
      ),
    );
    if (fulfilled.length === 0) return response(cachedPresentation(cache));

    const merged = mergeItems(fulfilled.map((result) => result.value));
    const authoritative = fulfilled.length === results.length && !merged.truncated;
    return response({
      contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
      state: authoritative
        ? deriveFinanceInsightPresentationState(merged.items)
        : 'partial',
      transport: 'live',
      authoritative,
      sourceAsOf: sourceAsOf(merged.items),
      collapsedCount: 0,
      items: merged.items,
    });
  } catch (error) {
    logger.warn(
      { code: 'finance_insight_presentation_failed', connectorId: config.id, err: error },
      'Finance insight presentation failed',
    );
    return response(cachedPresentation(cache));
  }
}
