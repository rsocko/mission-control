import 'server-only';

import { sqlite } from '@/db';
import { financeInsightDigestV1, type CanonicalJsonValue } from '@/lib/finance-insights/canonical';
import {
  FINANCE_INSIGHT_ITEM_LIMITS,
  transactionSourceFactSchema,
} from '@/lib/finance-insights/contract';
import { loadFinanceInsightProjectionFacts } from '@/lib/finance-insights/publication';
import { resolveFinanceInsightCurrency } from '@/lib/finance-insights/settings';
import type { ConnectorConfig } from '@/types';
import { FinanceAttributionCoordinator } from './attribution-service';
import { MonarchBridgeClient, MonarchBridgeError } from './client';
import {
  buildFinanceInsightHistoryWindows,
  financeInsightHistoryGenerationRef,
  FINANCE_INSIGHT_HISTORY_MONTHS,
} from './finance-insight-history-sync';
import {
  MONARCH_BRIDGE_CONTRACT_VERSION,
  MONARCH_TRANSACTION_MAX_BACKFILL_DAYS,
} from './constants';
import { upsertFinanceTransactionPage } from './snapshot-sync';

export const FINANCE_INSIGHT_TRANSACTION_HISTORY_MAX_MONTHS = 37;
export const FINANCE_INSIGHT_BACKFILL_MAX_WINDOWS_PER_RUN = 4;
const BACKFILL_PAGE_SIZE = 500;
const BACKFILL_MAX_PAGES_PER_WINDOW = 100;

export interface FinanceInsightBackfillWindow {
  ordinal: number;
  start: string;
  end: string;
}

type BackfillPlanRow = {
  id: string;
  connectorId: string;
  idempotencyKey: string;
  horizonMonths: number;
  coverageStart: string;
  coverageEnd: string;
  currency: string;
  bridgeContractVersion: string;
  windowCount: number;
  nextWindowOrdinal: number;
  status: 'running' | 'completed';
};

type WindowProofRow = {
  windowOrdinal: number;
  generationRef: string;
  windowStart: string;
  windowEnd: string;
  sourceAsOf: string;
  itemCount: number;
  contentDigest: string;
  currency: string;
  bridgeContractVersion: string;
};

export class FinanceInsightBackfillError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'FinanceInsightBackfillError';
  }
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateValue(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function addDays(value: string, days: number): string {
  const date = new Date(dateValue(value));
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
}

function historyCoverageStart(end: string, months: number): string {
  if (months === FINANCE_INSIGHT_HISTORY_MONTHS) {
    return buildFinanceInsightHistoryWindows(end)[0]!.start;
  }
  const endDate = new Date(dateValue(end));
  const targetMonth = endDate.getUTCMonth() - months;
  const firstOfTargetMonth = new Date(Date.UTC(
    endDate.getUTCFullYear(),
    targetMonth,
    1,
  ));
  const lastTargetDay = new Date(Date.UTC(
    firstOfTargetMonth.getUTCFullYear(),
    firstOfTargetMonth.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  const clamped = new Date(Date.UTC(
    firstOfTargetMonth.getUTCFullYear(),
    firstOfTargetMonth.getUTCMonth(),
    Math.min(endDate.getUTCDate(), lastTargetDay),
  ));
  return addDays(dateOnly(clamped), 1);
}

export function planFinanceInsightBackfillWindows(
  coverageEnd: string,
  horizonMonths: number,
): FinanceInsightBackfillWindow[] {
  if (
    !Number.isSafeInteger(horizonMonths)
    || horizonMonths < 1
    || horizonMonths > FINANCE_INSIGHT_TRANSACTION_HISTORY_MAX_MONTHS
    || !Number.isFinite(dateValue(coverageEnd))
    || dateOnly(new Date(dateValue(coverageEnd))) !== coverageEnd
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_request_invalid', 400);
  }
  const coverageStart = historyCoverageStart(coverageEnd, horizonMonths);
  const windows: FinanceInsightBackfillWindow[] = [];
  let start = coverageStart;
  while (start <= coverageEnd) {
    const boundedEnd = addDays(start, MONARCH_TRANSACTION_MAX_BACKFILL_DAYS - 1);
    const end = boundedEnd < coverageEnd ? boundedEnd : coverageEnd;
    windows.push({ ordinal: windows.length, start, end });
    start = addDays(end, 1);
  }
  return windows;
}

function resolveBackfillCurrency(config: ConnectorConfig): string {
  const currency = resolveFinanceInsightCurrency(config);
  if (!currency) {
    throw new FinanceInsightBackfillError('finance_insight_currency_unavailable', 409);
  }
  return currency;
}

function assertDeliveryDisabled(connectorId: string): void {
  const row = sqlite.prepare(`
    SELECT delivery_enabled AS deliveryEnabled
    FROM finance_insight_cutovers WHERE connector_id = ?
  `).get(connectorId) as { deliveryEnabled: number } | undefined;
  if (row?.deliveryEnabled === 1) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_delivery_enabled', 409);
  }
}

function loadPlan(connectorId: string, idempotencyKey: string): BackfillPlanRow | undefined {
  return sqlite.prepare(`
    SELECT id, connector_id AS connectorId, idempotency_key AS idempotencyKey,
           horizon_months AS horizonMonths, coverage_start AS coverageStart,
           coverage_end AS coverageEnd, currency,
           bridge_contract_version AS bridgeContractVersion,
           window_count AS windowCount, next_window_ordinal AS nextWindowOrdinal,
           status
    FROM finance_insight_transaction_backfill_plans
    WHERE connector_id = ? AND idempotency_key = ?
  `).get(connectorId, idempotencyKey) as BackfillPlanRow | undefined;
}

function createOrLoadPlan(input: {
  connectorId: string;
  idempotencyKey: string;
  horizonMonths: number;
  currency: string;
  coverageEnd: string;
  now: string;
}): BackfillPlanRow {
  return sqlite.transaction(() => {
    assertDeliveryDisabled(input.connectorId);
    const existing = loadPlan(input.connectorId, input.idempotencyKey);
    if (existing) {
      if (
        existing.horizonMonths !== input.horizonMonths
        || existing.currency !== input.currency
        || existing.bridgeContractVersion !== MONARCH_BRIDGE_CONTRACT_VERSION
      ) {
        throw new FinanceInsightBackfillError('finance_insight_backfill_idempotency_conflict', 409);
      }
      return existing;
    }
    const windows = planFinanceInsightBackfillWindows(input.coverageEnd, input.horizonMonths);
    const coverageStart = windows[0]!.start;
    const identity = {
      connectorId: input.connectorId,
      idempotencyKey: input.idempotencyKey,
      horizonMonths: input.horizonMonths,
      coverageStart,
      coverageEnd: input.coverageEnd,
      currency: input.currency,
      bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
    };
    const id = `finance-insight-backfill-v1:${
      financeInsightDigestV1(identity as CanonicalJsonValue).replace('sha256:', '')
    }`;
    sqlite.prepare(`
      INSERT INTO finance_insight_transaction_backfill_plans (
        id, connector_id, idempotency_key, horizon_months, coverage_start,
        coverage_end, currency, bridge_contract_version, window_count,
        next_window_ordinal, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'running', ?, ?)
    `).run(
      id,
      input.connectorId,
      input.idempotencyKey,
      input.horizonMonths,
      coverageStart,
      input.coverageEnd,
      input.currency,
      MONARCH_BRIDGE_CONTRACT_VERSION,
      windows.length,
      input.now,
      input.now,
    );
    return loadPlan(input.connectorId, input.idempotencyKey)!;
  }).immediate();
}

function loadProofs(planId: string): WindowProofRow[] {
  return sqlite.prepare(`
    SELECT window_ordinal AS windowOrdinal, generation_ref AS generationRef,
           window_start AS windowStart, window_end AS windowEnd,
           source_as_of AS sourceAsOf, item_count AS itemCount,
           content_digest AS contentDigest, currency,
           bridge_contract_version AS bridgeContractVersion
    FROM finance_insight_transaction_window_proofs
    WHERE plan_id = ?
    ORDER BY window_ordinal
  `).all(planId) as WindowProofRow[];
}

function verifyProof(
  connectorId: string,
  proof: WindowProofRow,
  expected: FinanceInsightBackfillWindow,
  currency: string,
): void {
  if (
    proof.windowOrdinal !== expected.ordinal
    || proof.windowStart !== expected.start
    || proof.windowEnd !== expected.end
    || proof.currency !== currency
    || proof.bridgeContractVersion !== MONARCH_BRIDGE_CONTRACT_VERSION
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_window_conflict', 409);
  }
  const facts = loadFinanceInsightProjectionFacts(
    connectorId,
    expected.start,
    'transaction',
    expected.end,
  ).transaction;
  if (
    facts.length !== proof.itemCount
    || financeInsightDigestV1(facts as CanonicalJsonValue) !== proof.contentDigest
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_window_changed', 409);
  }
}

function stableWindowGeneration(
  planId: string,
  window: FinanceInsightBackfillWindow,
): string {
  return `finance-insight-window-v1:${
    financeInsightDigestV1({
      planId,
      ordinal: window.ordinal,
      start: window.start,
      end: window.end,
    }).replace('sha256:', '')
  }`;
}

type ProjectionWindowProof = {
  index: number;
  start: string;
  end: string;
  sourceAsOf: string;
  itemCount: number;
  digest: string;
};

function promoteCompletedPlan(
  connectorId: string,
  plan: BackfillPlanRow,
  completedAt: Date,
): void {
  if (plan.horizonMonths !== FINANCE_INSIGHT_HISTORY_MONTHS) return;
  const operationalProofs = loadProofs(plan.id);
  const operationalWindows = planFinanceInsightBackfillWindows(
    plan.coverageEnd,
    plan.horizonMonths,
  );
  if (
    operationalProofs.length !== operationalWindows.length
    || plan.coverageStart !== buildFinanceInsightHistoryWindows(plan.coverageEnd)[0]?.start
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_window_conflict', 409);
  }
  for (const [index, proof] of operationalProofs.entries()) {
    verifyProof(connectorId, proof, operationalWindows[index]!, plan.currency);
  }
  const facts = loadFinanceInsightProjectionFacts(
    connectorId,
    plan.coverageStart,
    'transaction',
    plan.coverageEnd,
  ).transaction;
  if (facts.length > FINANCE_INSIGHT_ITEM_LIMITS.transaction) {
    throw new FinanceInsightBackfillError('transaction_generation_too_large', 409);
  }
  const expectedWindows = buildFinanceInsightHistoryWindows(plan.coverageEnd);
  const windowProofs: ProjectionWindowProof[] = expectedWindows.map((window) => {
    const overlappingProofs = operationalProofs.filter(
      (proof) => proof.windowStart <= window.end && proof.windowEnd >= window.start,
    );
    const sourceAsOf = overlappingProofs
      .map((proof) => proof.sourceAsOf)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
    if (!sourceAsOf) {
      throw new FinanceInsightBackfillError('finance_insight_backfill_window_conflict', 409);
    }
    const windowFacts = facts.filter(
      (fact) => fact.occurredOn >= window.start && fact.occurredOn <= window.end,
    );
    return {
      ...window,
      sourceAsOf,
      itemCount: windowFacts.length,
      digest: financeInsightDigestV1(windowFacts as CanonicalJsonValue),
    };
  });
  const completedTime = completedAt.getTime();
  const sourceTimes = windowProofs.map((proof) => Date.parse(proof.sourceAsOf));
  if (
    sourceTimes.some((value) => !Number.isFinite(value) || value > completedTime)
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_provenance_invalid', 409);
  }
  const sourceAsOf = windowProofs[
    sourceTimes.indexOf(Math.min(...sourceTimes))
  ]!.sourceAsOf;
  const contentDigest = financeInsightDigestV1(facts as CanonicalJsonValue);
  const windowsDigest = financeInsightDigestV1(windowProofs as CanonicalJsonValue);
  const generationId = financeInsightHistoryGenerationRef({
    connectorRef: connectorId,
    sourceAsOf,
    itemCount: facts.length,
    contentDigest,
    coverageStart: plan.coverageStart,
    coverageEnd: plan.coverageEnd,
    windowCount: windowProofs.length,
    windowsDigest,
    bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
  });
  const completedAtValue = completedAt.toISOString();

  sqlite.transaction(() => {
    assertDeliveryDisabled(connectorId);
    const current = loadPlan(connectorId, plan.idempotencyKey);
    if (!current || current.status !== 'completed') {
      throw new FinanceInsightBackfillError('finance_insight_backfill_window_conflict', 409);
    }
    const existingState = sqlite.prepare(`
      SELECT successful_generation_id AS generationId,
             source_as_of AS sourceAsOf, item_count AS itemCount,
             content_digest AS contentDigest, coverage_start AS coverageStart,
             coverage_end AS coverageEnd, window_count AS windowCount,
             windows_digest AS windowsDigest,
             bridge_contract_version AS bridgeContractVersion
      FROM finance_insight_transaction_projection_state
      WHERE connector_id = ? AND status = 'succeeded'
    `).get(connectorId) as {
      generationId: string;
      sourceAsOf: string;
      itemCount: number;
      contentDigest: string;
      coverageStart: string;
      coverageEnd: string;
      windowCount: number;
      windowsDigest: string;
      bridgeContractVersion: string;
    } | undefined;
    if (existingState?.generationId === generationId) {
      const storedFacts = (sqlite.prepare(`
        SELECT payload FROM finance_insight_transaction_projection_facts
        WHERE connector_id = ? AND generation_id = ?
        ORDER BY source_ref
      `).all(connectorId, generationId) as Array<{ payload: string }>).map((row) => (
        transactionSourceFactSchema.parse(JSON.parse(row.payload))
      ));
      const storedWindows = sqlite.prepare(`
        SELECT window_index AS "index", coverage_start AS start,
               coverage_end AS end, source_as_of AS sourceAsOf,
               item_count AS itemCount, content_digest AS digest
        FROM finance_insight_transaction_projection_windows
        WHERE connector_id = ? AND generation_id = ?
        ORDER BY window_index
      `).all(connectorId, generationId) as ProjectionWindowProof[];
      if (
        existingState.sourceAsOf !== sourceAsOf
        || existingState.itemCount !== facts.length
        || existingState.contentDigest !== contentDigest
        || existingState.coverageStart !== plan.coverageStart
        || existingState.coverageEnd !== plan.coverageEnd
        || existingState.windowCount !== windowProofs.length
        || existingState.windowsDigest !== windowsDigest
        || existingState.bridgeContractVersion !== MONARCH_BRIDGE_CONTRACT_VERSION
        || financeInsightDigestV1(storedFacts as CanonicalJsonValue) !== contentDigest
        || financeInsightDigestV1(storedWindows as CanonicalJsonValue) !== windowsDigest
      ) {
        throw new FinanceInsightBackfillError(
          'finance_insight_backfill_projection_changed',
          409,
        );
      }
      return;
    }
    sqlite.prepare(`
      DELETE FROM finance_insight_transaction_projection_facts
      WHERE connector_id = ? AND generation_id = ?
    `).run(connectorId, generationId);
    sqlite.prepare(`
      DELETE FROM finance_insight_transaction_projection_windows
      WHERE connector_id = ? AND generation_id = ?
    `).run(connectorId, generationId);
    const insertFact = sqlite.prepare(`
      INSERT INTO finance_insight_transaction_projection_facts (
        connector_id, generation_id, source_ref, occurred_on, payload
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const fact of facts) {
      insertFact.run(
        connectorId,
        generationId,
        fact.sourceRef,
        fact.occurredOn,
        JSON.stringify(fact),
      );
    }
    const insertWindow = sqlite.prepare(`
      INSERT INTO finance_insight_transaction_projection_windows (
        connector_id, generation_id, window_index, coverage_start,
        coverage_end, source_as_of, item_count, content_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const proof of windowProofs) {
      insertWindow.run(
        connectorId,
        generationId,
        proof.index,
        proof.start,
        proof.end,
        proof.sourceAsOf,
        proof.itemCount,
        proof.digest,
      );
    }
    sqlite.prepare(`
      INSERT INTO finance_insight_transaction_projection_state (
        connector_id, status, current_attempt_id, last_attempt_at,
        last_successful_at, successful_generation_id, source_as_of,
        item_count, content_digest, coverage_start, coverage_end,
        window_count, windows_digest, bridge_contract_version,
        last_error_code, created_at, updated_at
      ) VALUES (
        ?, 'succeeded', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
      )
      ON CONFLICT(connector_id) DO UPDATE SET
        status = 'succeeded',
        current_attempt_id = NULL,
        last_attempt_at = excluded.last_attempt_at,
        last_successful_at = excluded.last_successful_at,
        successful_generation_id = excluded.successful_generation_id,
        source_as_of = excluded.source_as_of,
        item_count = excluded.item_count,
        content_digest = excluded.content_digest,
        coverage_start = excluded.coverage_start,
        coverage_end = excluded.coverage_end,
        window_count = excluded.window_count,
        windows_digest = excluded.windows_digest,
        bridge_contract_version = excluded.bridge_contract_version,
        last_error_code = NULL,
        updated_at = excluded.updated_at
    `).run(
      connectorId,
      completedAtValue,
      completedAtValue,
      generationId,
      sourceAsOf,
      facts.length,
      contentDigest,
      plan.coverageStart,
      plan.coverageEnd,
      windowProofs.length,
      windowsDigest,
      MONARCH_BRIDGE_CONTRACT_VERSION,
      completedAtValue,
      completedAtValue,
    );
    sqlite.prepare(`
      DELETE FROM finance_insight_transaction_projection_facts
      WHERE connector_id = ? AND generation_id <> ?
    `).run(connectorId, generationId);
    sqlite.prepare(`
      DELETE FROM finance_insight_transaction_projection_windows
      WHERE connector_id = ? AND generation_id <> ?
    `).run(connectorId, generationId);
  }).immediate();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_cancelled', 409);
  }
}

function normalizedBackfillError(error: unknown): FinanceInsightBackfillError {
  if (error instanceof FinanceInsightBackfillError) return error;
  if (error instanceof MonarchBridgeError) {
    return new FinanceInsightBackfillError(error.code, error.status ?? 502);
  }
  return new FinanceInsightBackfillError('finance_insight_backfill_failed', 500);
}

async function captureWindow(input: {
  config: ConnectorConfig;
  plan: BackfillPlanRow;
  window: FinanceInsightBackfillWindow;
  signal?: AbortSignal;
}): Promise<{ added: number; updated: number; itemCount: number }> {
  const connectorId = input.config.id;
  const generationRef = stableWindowGeneration(input.plan.id, input.window);
  const client = new MonarchBridgeClient(input.config);
  const attribution = new FinanceAttributionCoordinator(connectorId, {
    financeConfig: input.config,
  });
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  const findPriorWindowTransaction = sqlite.prepare(`
    SELECT date
    FROM finance_transactions
    WHERE connector_instance_id = ? AND upstream_transaction_id = ?
      AND last_seen_generation_id IN (
        SELECT generation_ref
        FROM finance_insight_transaction_window_proofs
        WHERE plan_id = ?
      )
  `);
  let cursor: string | undefined;
  let expectedTotal: number | null = null;
  let sourceAsOf: string | null = null;
  let added = 0;
  let updated = 0;
  try {
    for (let pageNumber = 0; pageNumber < BACKFILL_MAX_PAGES_PER_WINDOW; pageNumber++) {
      throwIfAborted(input.signal);
      const page = await client.getTransactionsPage({
        startDate: input.window.start,
        endDate: input.window.end,
        limit: BACKFILL_PAGE_SIZE,
        cursor,
      }, input.signal);
      if (
        page.page.limit > BACKFILL_PAGE_SIZE
        || page.transactions.length > BACKFILL_PAGE_SIZE
        || page.total > FINANCE_INSIGHT_ITEM_LIMITS.transaction
      ) {
        throw new FinanceInsightBackfillError('finance_insight_backfill_page_limit', 409);
      }
      if (expectedTotal === null) {
        expectedTotal = page.total;
      } else if (page.total !== expectedTotal) {
        throw new FinanceInsightBackfillError('finance_insight_backfill_page_conflict', 409);
      }
      for (const transaction of page.transactions) {
        const priorWindow = findPriorWindowTransaction.get(
          connectorId,
          transaction.id,
          input.plan.id,
        ) as { date: string } | undefined;
        if (
          transaction.date < input.window.start
          || transaction.date > input.window.end
          || seenIds.has(transaction.id)
          || (
            priorWindow !== undefined
            && (priorWindow.date < input.window.start || priorWindow.date > input.window.end)
          )
        ) {
          throw new FinanceInsightBackfillError('finance_insight_backfill_page_conflict', 409);
        }
        seenIds.add(transaction.id);
      }
      if (seenIds.size > FINANCE_INSIGHT_ITEM_LIMITS.transaction) {
        throw new FinanceInsightBackfillError('transaction_generation_too_large', 409);
      }
      if (seenIds.size > expectedTotal) {
        throw new FinanceInsightBackfillError('finance_insight_backfill_page_conflict', 409);
      }
      const fetchedAt = new Date(page.provenance.fetchedAt).toISOString();
      if (sourceAsOf === null || Date.parse(fetchedAt) < Date.parse(sourceAsOf)) {
        sourceAsOf = fetchedAt;
      }
      const counts = upsertFinanceTransactionPage(
        connectorId,
        generationRef,
        page.transactions,
        { ...page.provenance, fetchedAt },
        new Date().toISOString(),
      );
      added += counts.added;
      updated += counts.updated;
      await attribution.attributePage(page.transactions, fetchedAt, input.signal);
      if (!page.page.nextCursor) break;
      if (
        seenCursors.has(page.page.nextCursor)
        || pageNumber === BACKFILL_MAX_PAGES_PER_WINDOW - 1
      ) {
        throw new FinanceInsightBackfillError('finance_insight_backfill_pagination_limit', 409);
      }
      seenCursors.add(page.page.nextCursor);
      cursor = page.page.nextCursor;
    }
    if (sourceAsOf === null) {
      throw new FinanceInsightBackfillError('finance_insight_backfill_provenance_invalid', 409);
    }
    if (expectedTotal === null || seenIds.size !== expectedTotal) {
      throw new FinanceInsightBackfillError('finance_insight_backfill_window_incomplete', 409);
    }
    throwIfAborted(input.signal);
    const completedAt = new Date().toISOString();
    const itemCount = sqlite.transaction(() => {
      assertDeliveryDisabled(connectorId);
      sqlite.prepare(`
        UPDATE finance_transactions
        SET lifecycle_status = 'deleted', deleted_at = ?, synced_at = ?
        WHERE connector_instance_id = ?
          AND lifecycle_status = 'active'
          AND date >= ? AND date <= ?
          AND (last_seen_generation_id IS NULL OR last_seen_generation_id <> ?)
      `).run(
        completedAt,
        completedAt,
        connectorId,
        input.window.start,
        input.window.end,
        generationRef,
      );
      const facts = loadFinanceInsightProjectionFacts(
        connectorId,
        input.window.start,
        'transaction',
        input.window.end,
      ).transaction;
      if (facts.length !== seenIds.size) {
        throw new FinanceInsightBackfillError('finance_insight_backfill_window_incomplete', 409);
      }
      const previousCount = sqlite.prepare(`
        SELECT COALESCE(SUM(item_count), 0) AS itemCount
        FROM finance_insight_transaction_window_proofs WHERE plan_id = ?
      `).get(input.plan.id) as { itemCount: number };
      if (previousCount.itemCount + facts.length > FINANCE_INSIGHT_ITEM_LIMITS.transaction) {
        throw new FinanceInsightBackfillError('transaction_generation_too_large', 409);
      }
      sqlite.prepare(`
        INSERT INTO finance_insight_transaction_window_proofs (
          plan_id, connector_id, window_ordinal, generation_ref, window_start,
          window_end, source_as_of, item_count, content_digest, currency,
          bridge_contract_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.plan.id,
        connectorId,
        input.window.ordinal,
        generationRef,
        input.window.start,
        input.window.end,
        sourceAsOf,
        facts.length,
        financeInsightDigestV1(facts as CanonicalJsonValue),
        input.plan.currency,
        MONARCH_BRIDGE_CONTRACT_VERSION,
        completedAt,
      );
      const nextOrdinal = input.window.ordinal + 1;
      const completed = nextOrdinal === input.plan.windowCount;
      sqlite.prepare(`
        UPDATE finance_insight_transaction_backfill_plans
        SET next_window_ordinal = ?, status = ?, last_error_code = NULL,
            completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        nextOrdinal,
        completed ? 'completed' : 'running',
        completed ? completedAt : null,
        completedAt,
        input.plan.id,
      );
      return facts.length;
    }).immediate();
    attribution.finish(completedAt);
    return { added, updated, itemCount };
  } catch (error) {
    attribution.finish(new Date().toISOString());
    throw normalizedBackfillError(error);
  }
}

export async function runFinanceInsightTransactionBackfill(input: {
  config: ConnectorConfig;
  idempotencyKey: string;
  horizonMonths?: number;
  maxWindows?: number;
  signal?: AbortSignal;
  clock?: () => Date;
}): Promise<{
  planId: string;
  status: 'running' | 'completed';
  completedWindows: number;
  totalWindows: number;
  coverageStart: string;
  coverageEnd: string;
  itemCount: number;
}> {
  const idempotencyKey = input.idempotencyKey.trim();
  const horizonMonths = input.horizonMonths
    ?? FINANCE_INSIGHT_TRANSACTION_HISTORY_MAX_MONTHS;
  const maxWindows = input.maxWindows ?? 1;
  if (
    idempotencyKey.length < 8
    || idempotencyKey.length > 192
    || !Number.isSafeInteger(maxWindows)
    || maxWindows < 1
    || maxWindows > FINANCE_INSIGHT_BACKFILL_MAX_WINDOWS_PER_RUN
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_request_invalid', 400);
  }
  const clock = input.clock ?? (() => new Date());
  const startedAt = clock();
  const currency = resolveBackfillCurrency(input.config);
  const plan = createOrLoadPlan({
    connectorId: input.config.id,
    idempotencyKey,
    horizonMonths,
    currency,
    coverageEnd: dateOnly(startedAt),
    now: startedAt.toISOString(),
  });
  const windows = planFinanceInsightBackfillWindows(plan.coverageEnd, plan.horizonMonths);
  const existingProofs = loadProofs(plan.id);
  let totalItemCount = 0;
  for (const [index, proof] of existingProofs.entries()) {
    const expected = windows[index];
    if (!expected || proof.windowOrdinal !== index) {
      throw new FinanceInsightBackfillError('finance_insight_backfill_window_conflict', 409);
    }
    verifyProof(input.config.id, proof, expected, currency);
    totalItemCount += proof.itemCount;
  }
  if (totalItemCount > FINANCE_INSIGHT_ITEM_LIMITS.transaction) {
    throw new FinanceInsightBackfillError('transaction_generation_too_large', 409);
  }
  let completedWindows = existingProofs.length;
  let remaining = maxWindows;
  try {
    while (completedWindows < windows.length && remaining > 0) {
      assertDeliveryDisabled(input.config.id);
      const result = await captureWindow({
        config: input.config,
        plan,
        window: windows[completedWindows]!,
        signal: input.signal,
      });
      totalItemCount += result.itemCount;
      completedWindows++;
      remaining--;
    }
    if (completedWindows === windows.length) {
      promoteCompletedPlan(input.config.id, {
        ...plan,
        status: 'completed',
        nextWindowOrdinal: completedWindows,
      }, clock());
    }
  } catch (error) {
    const normalized = normalizedBackfillError(error);
    sqlite.prepare(`
      UPDATE finance_insight_transaction_backfill_plans
      SET last_error_code = ?, updated_at = ? WHERE id = ?
    `).run(normalized.code, new Date().toISOString(), plan.id);
    throw normalized;
  }
  return {
    planId: plan.id,
    status: completedWindows === windows.length ? 'completed' : 'running',
    completedWindows,
    totalWindows: windows.length,
    coverageStart: plan.coverageStart,
    coverageEnd: plan.coverageEnd,
    itemCount: totalItemCount,
  };
}
